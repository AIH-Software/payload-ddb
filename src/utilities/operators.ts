import type { Where } from 'payload'

/**
 * The where-operator coverage shared by `matchesWhere` (in-JS evaluator) and
 * `buildFilterExpression` (DynamoDB pushdown). Keeping the set in one place
 * keeps the two paths honest — if an operator is supported in one, it should
 * be supported in the other, since callers can't know which path runs.
 */
export const SUPPORTED_OPERATORS = new Set([
  'equals',
  'exists',
  'greater_than',
  'greater_than_equal',
  'in',
  'less_than',
  'less_than_equal',
  'like',
  'not_equals',
  'not_in',
])

/**
 * Operators we can't faithfully express in a DynamoDB `FilterExpression` and
 * therefore evaluate in JS after fetching candidate rows. `like` is here
 * because Payload's contract is case-insensitive substring matching while
 * DynamoDB's `contains()` is case-sensitive — pushing it down would silently
 * change semantics. When `where` contains any of these, the read helpers
 * `Query` the partition without server-side filtering and apply
 * `matchesWhere` in memory.
 */
export const JS_ONLY_OPERATORS = new Set(['like'])

export const SUPPORTED_OPERATORS_DESCRIPTION = `${[...SUPPORTED_OPERATORS].join(', ')}, and, or`

export function unsupportedOperatorError(operator: string, field: string): Error {
  return new Error(
    `payload-ddb: operator \`${operator}\` is not supported yet on field \`${field}\`. ` +
      `Supported: ${SUPPORTED_OPERATORS_DESCRIPTION}.`,
  )
}

/**
 * Walk a `Where` and return true if any leaf clause uses an operator that
 * forces JS-side evaluation. Recurses into `and`/`or` groups.
 */
export function whereHasJsOnlyOperator(where: undefined | Where): boolean {
  if (!where) return false
  for (const [key, raw] of Object.entries(where)) {
    if (key === 'and' || key === 'or') {
      if (!Array.isArray(raw)) continue
      for (const sub of raw) {
        if (sub && typeof sub === 'object' && whereHasJsOnlyOperator(sub as Where)) {
          return true
        }
      }
      continue
    }
    if (!raw || typeof raw !== 'object') continue
    for (const op of Object.keys(raw)) {
      if (JS_ONLY_OPERATORS.has(op)) return true
    }
  }
  return false
}
