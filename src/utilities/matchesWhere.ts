import type { Where } from 'payload'

import { getByPath } from './getByPath.js'
import { SUPPORTED_OPERATORS, unsupportedOperatorError } from './operators.js'

/**
 * In-memory predicate that evaluates a Payload `Where` against a fetched item.
 * Used as a fallback when the query cannot be reduced to a `GetItem` and we
 * have to `Scan` the table.
 *
 * Supports: `equals`, `not_equals`, `exists`, `in`, `not_in`, `and`, `or`.
 * Throws on any other operator so we surface coverage gaps instead of
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

function evaluate(actual: unknown, operator: string, expected: unknown): boolean {
  switch (operator) {
    case 'equals':
      return actual === expected
    case 'not_equals':
      return actual !== expected
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
      return Array.isArray(expected) && expected.includes(actual)
    case 'not_in':
      return Array.isArray(expected) && !expected.includes(actual)
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
 * Loose ordered comparison matching DynamoDB's `<`/`>` semantics: numbers and
 * strings (including ISO date strings) compare naturally; nullish on either
 * side yields a non-match by returning `NaN`. Lets `greater_than`/`less_than`
 * mirror the server-side filter evaluator behavior.
 */
function compareLoose(a: unknown, b: unknown): number {
  if (a === undefined || a === null || b === undefined || b === null) return NaN
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const as = String(a)
  const bs = String(b)
  if (as < bs) return -1
  if (as > bs) return 1
  return 0
}
