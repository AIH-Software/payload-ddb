/**
 * The where-operator coverage shared by `matchesWhere` (in-JS evaluator) and
 * `buildFilterExpression` (DynamoDB pushdown). Keeping the set in one place
 * keeps the two paths honest — if an operator is supported in one, it should
 * be supported in the other, since callers can't know which path runs.
 *
 * This is Payload's full operator list (`validOperators` in core).
 */
export const SUPPORTED_OPERATORS = new Set([
  'all',
  'contains',
  'equals',
  'exists',
  'greater_than',
  'greater_than_equal',
  'in',
  'intersects',
  'less_than',
  'less_than_equal',
  'like',
  'near',
  'not_equals',
  'not_in',
  'not_like',
  'within',
])

/**
 * Operators we can't faithfully express in a DynamoDB `FilterExpression` and
 * therefore evaluate in JS after fetching candidate rows:
 *
 *  - `like` / `not_like` / `contains`: Payload's contract is case-insensitive
 *    matching, while DynamoDB's `contains()` is case-sensitive — pushing it
 *    down would silently change semantics.
 *  - `all`: needs "every operand is a member" over a list; no equivalent.
 *  - `near` / `within` / `intersects`: geometry.
 *
 * A clause using one of these is simply left out of the pushed-down filter
 * (see `buildFilterExpression`); the rest of the `where` still narrows the
 * read server-side, and `matchesWhere` re-checks every returned row.
 */
export const JS_ONLY_OPERATORS = new Set([
  'all',
  'contains',
  'intersects',
  'like',
  'near',
  'not_like',
  'within',
])

/**
 * Pseudo-operator `castWhere` adds to a clause whose *path* can't be pushed
 * down, whatever its operators: one that runs through an array or a
 * `hasMany` value (DynamoDB document paths can't mean "any element"), or
 * into a field whose inner shape the schema doesn't describe. The pushdown
 * skips the whole clause; `matchesWhere` ignores the marker and evaluates the
 * real operators with any-element semantics.
 */
export const JS_ONLY_MARKER = '$js'

export const SUPPORTED_OPERATORS_DESCRIPTION = `${[...SUPPORTED_OPERATORS].join(', ')}, and, or`

export function unsupportedOperatorError(operator: string, field: string): Error {
  return new Error(
    `payload-ddb: operator \`${operator}\` is not supported on field \`${field}\`. ` +
      `Supported: ${SUPPORTED_OPERATORS_DESCRIPTION}.`,
  )
}
