import type { Where } from 'payload'

import { getByPath } from './getByPath.js'
import { normalizeForDynamo } from './normalizeForDynamo.js'
import { SUPPORTED_OPERATORS, unsupportedOperatorError } from './operators.js'

/**
 * In-memory predicate that evaluates a Payload `Where` against a fetched item.
 * Used wherever the predicate can't be pushed to DynamoDB: a `where` that
 * contains a JS-only operator (`like`), and rows that only take their doc
 * shape after projection (drafts supplements, `queryDrafts`).
 *
 * Must return the same rows `buildFilterExpression` would for the same
 * `where` — callers can't tell which evaluator a query takes. The operator
 * set is shared via `operators.ts`; `test/parity` pins the semantics.
 * Throws on any unsupported operator so we surface coverage gaps instead of
 * silently returning wrong results.
 */
export function matchesWhere(item: Record<string, unknown>, where: Where | undefined): boolean {
  if (!where) {
    return true
  }

  for (const [key, raw] of Object.entries(where)) {
    if (key === 'and') {
      if (!Array.isArray(raw)) continue
      for (const sub of raw) {
        if (!matchesWhere(item, sub)) return false
      }
      continue
    }

    if (key === 'or') {
      if (!Array.isArray(raw)) continue
      let any = false
      for (const sub of raw) {
        if (matchesWhere(item, sub)) {
          any = true
          break
        }
      }
      if (!any) return false
      continue
    }

    if (!raw || typeof raw !== 'object') {
      continue
    }

    const fieldValue = getByPath(item, key)
    const operators = raw as Record<string, unknown>

    for (const [operator, expected] of Object.entries(operators)) {
      if (!SUPPORTED_OPERATORS.has(operator)) {
        throw unsupportedOperatorError(operator, key)
      }

      if (!evaluate(fieldValue, operator, expected)) {
        return false
      }
    }
  }

  return true
}

function evaluate(actual: unknown, operator: string, rawExpected: unknown): boolean {
  // Coerce the operand exactly as `buildFilterExpression` coerces its
  // expression values (today: `Date` → ISO string, including inside `in` /
  // `not_in` lists). Rows hold ISO strings, so comparing them against a raw
  // `Date` would never be equal and would order by `Date#toString()` text.
  const expected = normalizeForDynamo(rawExpected)

  switch (operator) {
    case 'equals':
      return valuesEqual(actual, expected)
    case 'not_equals':
      return !valuesEqual(actual, expected)
    case 'greater_than':
      return compareLoose(actual, expected) > 0
    case 'greater_than_equal':
      return compareLoose(actual, expected) >= 0
    case 'less_than':
      return compareLoose(actual, expected) < 0
    case 'less_than_equal':
      return compareLoose(actual, expected) <= 0
    case 'exists':
      return expected ? actual !== undefined && actual !== null : actual === undefined || actual === null
    case 'in':
      return Array.isArray(expected) && expected.some((member) => valuesEqual(actual, member))
    case 'not_in':
      return Array.isArray(expected) && !expected.some((member) => valuesEqual(actual, member))
    case 'like': {
      // Empty needle means "no constraint" — mirrors SQL `LIKE '%%'` and what
      // Payload's admin search produces when the search input is cleared.
      if (typeof expected !== 'string' || expected === '') return true
      if (typeof actual !== 'string') return false
      return actual.toLowerCase().includes(expected.toLowerCase())
    }
    default:
      return false
  }
}

/**
 * Equality as DynamoDB's `=` defines it: scalars by value and type, lists
 * element-by-element in order, maps key-by-key regardless of key order. A
 * plain `===` would compare objects by reference and never match — which
 * breaks object operands such as a polymorphic relationship's
 * `{ relationTo, value }`.
 *
 * Keys holding `undefined` are ignored on both sides, since the marshaller
 * drops them before anything reaches DynamoDB (`removeUndefinedValues`).
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((member, index) => valuesEqual(member, b[index]))
  }

  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const definedKeys = (record: Record<string, unknown>) =>
    Object.keys(record).filter((key) => record[key] !== undefined)
  const leftKeys = definedKeys(left)
  if (leftKeys.length !== definedKeys(right).length) return false
  return leftKeys.every((key) => right[key] !== undefined && valuesEqual(left[key], right[key]))
}

/**
 * Ordered comparison matching DynamoDB's `<`/`>` semantics: two numbers or
 * two strings (including ISO date strings) compare naturally; anything else
 * — a missing side, or operands of different types — yields a non-match by
 * returning `NaN`. DynamoDB never orders a number against a string, so
 * falling back to string comparison here would match rows the pushdown
 * rejects. `castWhere` is what turns a string operand into the field's real
 * type before it gets this far.
 */
function compareLoose(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') {
    if (a < b) return -1
    if (a > b) return 1
    return 0
  }
  return NaN
}
