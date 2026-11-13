import type { Where } from 'payload'

import { matchesIntersects, matchesNear, matchesWithin } from './geo.js'
import { getByPath } from './getByPath.js'
import { normalizeForDynamo } from './normalizeForDynamo.js'
import { JS_ONLY_MARKER, SUPPORTED_OPERATORS, unsupportedOperatorError } from './operators.js'

/**
 * In-memory predicate that evaluates a Payload `Where` against a fetched item.
 * This is the adapter's reference evaluator: `buildFilterExpression` pushes
 * down whatever part of a `where` DynamoDB can express, and every row that
 * comes back from an inexact pushdown is re-checked here. It also runs alone
 * for rows that only take their doc shape after projection (drafts
 * supplements, `queryDrafts`).
 *
 * Where a clause can be evaluated by both, the two must return the same rows
 * — `test/parity` pins that.
 *
 * Paths follow MongoDB's array semantics, which is what Payload's query
 * language assumes: an array anywhere along a path is transparent, so
 * `tags equals 'x'` matches a `hasMany` value containing `'x'` and
 * `items.label equals 'x'` matches when any item has that label. A negative
 * operator (`not_equals`, `not_in`, `not_like`) holds only when *no* element
 * matches its positive form.
 *
 * Throws on any unsupported operator so we surface coverage gaps instead of
 * silently returning wrong results.
 */
export function matchesWhere(item: Record<string, unknown>, where: undefined | Where): boolean {
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

    const operators = raw as Record<string, unknown>
    let candidates: undefined | unknown[]

    for (const [operator, expected] of Object.entries(operators)) {
      if (operator === JS_ONLY_MARKER) continue
      if (!SUPPORTED_OPERATORS.has(operator)) {
        throw unsupportedOperatorError(operator, key)
      }

      // Geometry reads the stored point whole — `[lng, lat]` is a value, not
      // a list of candidates.
      if (operator === 'near' || operator === 'within' || operator === 'intersects') {
        if (!evaluateGeo(getByPath(item, key), operator, expected)) return false
        continue
      }

      candidates ??= candidatesAt(item, key)
      if (!evaluate(candidates, operator, expected)) {
        return false
      }
    }
  }

  return true
}

/**
 * Every value a dotted path can reach in `source`, treating arrays as
 * transparent. A path that ends on an array yields the array itself (so an
 * array operand can match it whole, and `exists` sees an empty list as a
 * value) followed by each of its elements. A path that reaches nothing
 * yields no candidates.
 */
export function candidatesAt(source: unknown, path: string): unknown[] {
  const out: unknown[] = []
  collect(source, path.split('.'), 0, out)
  return out
}

function collect(value: unknown, segments: string[], index: number, out: unknown[]): void {
  if (index === segments.length) {
    if (value === undefined) return
    out.push(value)
    if (Array.isArray(value)) {
      for (const member of value) {
        if (member !== undefined) out.push(member)
      }
    }
    return
  }
  if (Array.isArray(value)) {
    for (const member of value) collect(member, segments, index, out)
    return
  }
  if (value === null || typeof value !== 'object') return
  collect((value as Record<string, unknown>)[segments[index]!], segments, index + 1, out)
}

function evaluateGeo(value: unknown, operator: string, expected: unknown): boolean {
  switch (operator) {
    case 'intersects':
      return matchesIntersects(value, expected)
    case 'near':
      return matchesNear(value, expected)
    default:
      return matchesWithin(value, expected)
  }
}

function evaluate(candidates: unknown[], operator: string, rawExpected: unknown): boolean {
  // Coerce the operand exactly as `buildFilterExpression` coerces its
  // expression values (today: `Date` → ISO string, including inside `in` /
  // `not_in` lists). Rows hold ISO strings, so comparing them against a raw
  // `Date` would never be equal and would order by `Date#toString()` text.
  const expected = normalizeForDynamo(rawExpected)
  const some = (test: (candidate: unknown) => boolean) => candidates.some(test)
  const hasValue = (candidate: unknown) => candidate !== undefined && candidate !== null

  switch (operator) {
    case 'all':
      return (
        Array.isArray(expected) &&
        expected.every((member) => some((candidate) => valuesEqual(candidate, member)))
      )
    case 'contains':
      return asList(expected).some((needle) => some((candidate) => containsText(candidate, needle)))
    case 'equals':
      return some((candidate) => valuesEqual(candidate, expected))
    case 'exists':
      return expected ? some(hasValue) : !some(hasValue)
    case 'greater_than':
      return some((candidate) => compareLoose(candidate, expected) > 0)
    case 'greater_than_equal':
      return some((candidate) => compareLoose(candidate, expected) >= 0)
    case 'in':
      return (
        Array.isArray(expected) &&
        expected.some((member) => some((candidate) => valuesEqual(candidate, member)))
      )
    case 'less_than':
      return some((candidate) => compareLoose(candidate, expected) < 0)
    case 'less_than_equal':
      return some((candidate) => compareLoose(candidate, expected) <= 0)
    case 'like':
      return isLike(candidates, expected)
    case 'not_equals':
      return !some((candidate) => valuesEqual(candidate, expected))
    case 'not_in':
      return (
        Array.isArray(expected) &&
        !expected.some((member) => some((candidate) => valuesEqual(candidate, member)))
      )
    case 'not_like':
      return !isLike(candidates, expected)
    default:
      return false
  }
}

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value])

function isLike(candidates: unknown[], expected: unknown): boolean {
  // Empty needle means "no constraint" — mirrors SQL `LIKE '%%'` and what
  // Payload's admin search produces when the search input is cleared.
  if (typeof expected !== 'string' || expected === '') return true
  const needle = expected.toLowerCase()
  return candidates.some(
    (candidate) => typeof candidate === 'string' && candidate.toLowerCase().includes(needle),
  )
}

/**
 * `contains`: case-insensitive substring, over text and numbers (a `hasMany`
 * number field is searched by its digits, as the Mongo adapter does).
 */
function containsText(candidate: unknown, needle: unknown): boolean {
  if (typeof needle !== 'string' && typeof needle !== 'number') return false
  if (typeof candidate !== 'string' && typeof candidate !== 'number') return false
  return String(candidate).toLowerCase().includes(String(needle).toLowerCase())
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
