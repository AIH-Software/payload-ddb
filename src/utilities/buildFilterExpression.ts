import type { Where } from 'payload'

import { normalizeForDynamo } from './normalizeForDynamo.js'
import {
  JS_ONLY_MARKER,
  JS_ONLY_OPERATORS,
  SUPPORTED_OPERATORS,
  unsupportedOperatorError,
} from './operators.js'

/**
 * Compile a Payload `Where` into a DynamoDB `FilterExpression` plus its
 * companion `ExpressionAttributeNames` / `ExpressionAttributeValues` maps.
 *
 * The result is a *prefilter*: it never rejects a row the `where` accepts,
 * but it may let through rows the `where` rejects. `exact` says which:
 *
 *  - `exact: true` — the filter (or its absence) is the whole `where`; rows
 *    DynamoDB returns need no further checking.
 *  - `exact: false` — some clause couldn't be expressed (a JS-only operator
 *    such as `like`, or a path `castWhere` marked as running through an
 *    array). That clause is left out, so callers must re-check every
 *    returned row with `matchesWhere`. Everything that *could* be expressed
 *    still narrows the read server-side.
 *
 * `never: true` means the predicate is structurally always-false (e.g. an
 * empty `id: { in: [] }`). Callers should short-circuit and return zero rows
 * without ever hitting DynamoDB. Payload uses empty `in` as a "match
 * nothing" sentinel (typically from access control resolving to no IDs);
 * surfacing it as a filter would mean throwing or constructing an invalid
 * `IN ()` clause.
 *
 * Throws on any operator outside `operators.ts`'s supported set, identical
 * to `matchesWhere` — coverage is enforced from one source so the in-JS
 * path and the pushdown path can never disagree.
 *
 * Implementation notes:
 *  - Every field path segment becomes an `#nN` placeholder, sidestepping
 *    DynamoDB's reserved-word list entirely. Segments are deduped per-call so
 *    repeated fields produce one `#name` entry rather than many.
 *  - Every value becomes a `:vN` placeholder. We don't dedupe values because
 *    array members and repeated literals are cheap and the placeholder count
 *    keeps the expression readable.
 *  - Dotted paths in `where` keys are split on `.` so DynamoDB document-path
 *    syntax (`#a.#b`) is produced for nested fields.
 *  - A clause compiles to an expression string, to `''` (always true — no
 *    constraint), or to the NEVER sentinel (always false). AND drops `''`
 *    and collapses to NEVER if any part is NEVER; OR drops NEVER branches
 *    and collapses to `''` if any branch is `''`. An inexpressible clause
 *    compiles to `''` and clears `exact`, which keeps the result a superset
 *    under both AND and OR.
 *  - `not_in: []` is treated as no constraint (the complement of an empty
 *    set is everything, so omitting it from the expression matches semantics).
 */
export type FilterExpression = {
  expression: string
  names: Record<string, string>
  values: Record<string, unknown>
}

export type CompiledFilter = {
  exact: boolean
  filter?: FilterExpression
  never: boolean
}

const NEVER = Symbol('payload-ddb-filter-never')
type Compiled = string | typeof NEVER

type Ctx = {
  exact: boolean
  nameByPlaceholder: Record<string, string>
  nameCounter: number
  placeholderBySegment: Map<string, string>
  valueCounter: number
  values: Record<string, unknown>
}

export function buildFilterExpression(where: undefined | Where): CompiledFilter {
  if (!where) return { exact: true, never: false }

  const ctx: Ctx = {
    exact: true,
    nameByPlaceholder: {},
    nameCounter: 0,
    placeholderBySegment: new Map(),
    valueCounter: 0,
    values: {},
  }

  const expression = compile(where, ctx)
  if (expression === NEVER) return { exact: true, never: true }
  if (!expression) return { exact: ctx.exact, never: false }

  return {
    exact: ctx.exact,
    filter: {
      expression,
      names: onlyReferenced(ctx.nameByPlaceholder, expression, /#n\d+/g),
      values: onlyReferenced(ctx.values, expression, /:v\d+/g),
    },
    never: false,
  }
}

/**
 * DynamoDB rejects a request that declares an expression name or value the
 * expression never uses. Placeholders get registered as clauses compile, but
 * a clause can still end up contributing nothing (a skipped JS-only
 * operator, `not_in: []`, a branch dropped from an OR), so keep only what
 * the final expression references.
 */
function onlyReferenced<T>(
  registered: Record<string, T>,
  expression: string,
  pattern: RegExp,
): Record<string, T> {
  const used = new Set(expression.match(pattern) ?? [])
  const out: Record<string, T> = {}
  for (const [placeholder, value] of Object.entries(registered)) {
    if (used.has(placeholder)) out[placeholder] = value
  }
  return out
}

function compile(where: Where, ctx: Ctx): Compiled {
  const parts: string[] = []

  for (const [key, raw] of Object.entries(where)) {
    if (key === 'and') {
      const inner = compileGroup(raw, ctx, 'AND')
      if (inner === NEVER) return NEVER
      if (inner) parts.push(inner)
      continue
    }
    if (key === 'or') {
      const inner = compileGroup(raw, ctx, 'OR')
      if (inner === NEVER) return NEVER
      if (inner) parts.push(inner)
      continue
    }

    if (!raw || typeof raw !== 'object') continue

    const operators = raw as Record<string, unknown>
    // `castWhere` marks clauses whose path can't be a DynamoDB document path
    // (it runs through an array). Leave the whole clause to `matchesWhere`.
    const pathIsJsOnly = JS_ONLY_MARKER in operators
    const path = pathIsJsOnly ? '' : pathRef(ctx, key)

    for (const [operator, expected] of Object.entries(operators)) {
      if (operator === JS_ONLY_MARKER) continue
      if (!SUPPORTED_OPERATORS.has(operator)) {
        throw unsupportedOperatorError(operator, key)
      }
      if (pathIsJsOnly || JS_ONLY_OPERATORS.has(operator)) {
        ctx.exact = false
        continue
      }
      const expr = operatorToExpression(operator, path, expected, ctx)
      if (expr === NEVER) return NEVER
      if (expr) parts.push(expr)
    }
  }

  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]!
  return parts.join(' AND ')
}

function compileGroup(raw: unknown, ctx: Ctx, joiner: 'AND' | 'OR'): Compiled {
  if (!Array.isArray(raw)) return ''
  const subs: string[] = []
  let neverCount = 0
  let consideredCount = 0
  for (const sub of raw) {
    if (!sub || typeof sub !== 'object') continue
    consideredCount++
    const expr = compile(sub as Where, ctx)
    if (expr === NEVER) {
      if (joiner === 'AND') return NEVER
      neverCount++
      continue
    }
    // An unconstrained branch makes the whole OR unconstrained. (Dropping it
    // and keeping the others would narrow the result.)
    if (!expr && joiner === 'OR') return ''
    if (expr) subs.push(expr)
  }
  // OR over branches that all collapsed to NEVER is NEVER itself.
  if (joiner === 'OR' && consideredCount > 0 && neverCount === consideredCount) {
    return NEVER
  }
  if (subs.length === 0) return ''
  if (subs.length === 1) return subs[0]!
  return `(${subs.join(` ${joiner} `)})`
}

function pathRef(ctx: Ctx, path: string): string {
  return path
    .split('.')
    .map((segment) => segmentRef(ctx, segment))
    .join('.')
}

function segmentRef(ctx: Ctx, segment: string): string {
  const cached = ctx.placeholderBySegment.get(segment)
  if (cached) return cached
  const placeholder = `#n${ctx.nameCounter++}`
  ctx.nameByPlaceholder[placeholder] = segment
  ctx.placeholderBySegment.set(segment, placeholder)
  return placeholder
}

function valueRef(ctx: Ctx, value: unknown): string {
  const placeholder = `:v${ctx.valueCounter++}`
  // Normalize so Date literals in `where` compare against the ISO strings we
  // actually stored. Without this, `{ updatedAt: { greater_than: new Date() } }`
  // would push an empty map literal into the filter and DynamoDB would reject
  // the comparison.
  ctx.values[placeholder] = normalizeForDynamo(value)
  return placeholder
}

function operatorToExpression(
  operator: string,
  path: string,
  expected: unknown,
  ctx: Ctx,
): Compiled {
  switch (operator) {
    case 'equals':
      return `${path} = ${valueRef(ctx, expected)}`
    case 'not_equals':
      return `${path} <> ${valueRef(ctx, expected)}`
    case 'greater_than':
      return `${path} > ${valueRef(ctx, expected)}`
    case 'greater_than_equal':
      return `${path} >= ${valueRef(ctx, expected)}`
    case 'less_than':
      return `${path} < ${valueRef(ctx, expected)}`
    case 'less_than_equal':
      return `${path} <= ${valueRef(ctx, expected)}`
    case 'exists': {
      // "Exists" means "holds a non-null value", same as `matchesWhere`.
      // Payload writes `null` when a field is cleared and DynamoDB stores
      // that as a real attribute of type NULL, so `attribute_exists` alone
      // would report a cleared field as present.
      const nullType = valueRef(ctx, 'NULL')
      return expected
        ? `(attribute_exists(${path}) AND NOT attribute_type(${path}, ${nullType}))`
        : `(attribute_not_exists(${path}) OR attribute_type(${path}, ${nullType}))`
    }
    case 'in': {
      if (!Array.isArray(expected)) return ''
      if (expected.length === 0) return NEVER
      const refs = expected.map((v) => valueRef(ctx, v))
      return `${path} IN (${refs.join(', ')})`
    }
    case 'not_in': {
      if (!Array.isArray(expected) || expected.length === 0) return ''
      const refs = expected.map((v) => valueRef(ctx, v))
      return `NOT (${path} IN (${refs.join(', ')}))`
    }
    default:
      // Unreachable — gated by SUPPORTED_OPERATORS check above. Belt-and-braces.
      throw unsupportedOperatorError(operator, path)
  }
}
