import type { FlattenedField, Where } from 'payload'

import {
  buildVersionCollectionFields,
  buildVersionGlobalFields,
  createArrayFromCommaDelineated,
} from 'payload'

import type { DynamoAdapter } from '../types.js'

/**
 * Coerce the operands of a Payload `Where` to the types the targeted fields
 * actually store, before either evaluator (`buildFilterExpression` or
 * `matchesWhere`) sees it.
 *
 * Why this exists: operands routinely arrive as strings. The REST API parses
 * `?where[price][greater_than]=10` with `qs`, which yields `"10"`; the admin
 * list filters go the same way. Mongoose and SQL drivers quietly coerce those
 * against their schema. DynamoDB has no schema and compares strictly by type
 * — `"10"` never equals or orders against the number `10` — so without this
 * pass such a filter matches nothing and reports no error.
 *
 * The rules follow Payload's Mongo and Postgres adapters
 * (`sanitizeQueryValue`), minus their database-specific quirks:
 *
 *  - `checkbox`: `'true'` / `'false'` (any case) → boolean.
 *  - `number`: numeric strings → number.
 *  - `date`: parseable strings, epoch-ms numbers and `Date`s → the full ISO
 *    string we store. `'2026-01-01'` must become `'2026-01-01T00:00:00.000Z'`
 *    or it would compare as a mere prefix of the stored value.
 *  - `relationship` / `upload`: `'null'` → `null`; ids → number when the
 *    related collection has numeric ids, including inside a polymorphic
 *    `{ relationTo, value }` operand.
 *  - `id`: → number when this collection has numeric ids.
 *  - `in` / `not_in`: a comma-delimited string → array, each member cast.
 *  - `exists`: operand → boolean (`'false'` is a truthy string otherwise),
 *    and for fields that can hold text, an empty string counts as absent —
 *    that's what the admin UI leaves behind when a text input is cleared.
 *
 * Anything it can't confidently cast is left exactly as given: an unknown
 * path, a path that continues past a leaf field (relationship traversal, a
 * locale key), an unparseable value. The evaluators then treat it as before.
 *
 * Returns a new `Where`; the caller's object is never mutated.
 */

export type IdType = 'number' | 'text'

export type CastContext = {
  /** Flattened fields of the entity the `where` targets. */
  fields: FlattenedField[]
  /** Type of the entity's own `id` when it isn't declared as a field. */
  idType: IdType
  /** Id type of another collection, for relationship operands. */
  idTypeOf: (collectionSlug: string) => IdType
}

/** Field types whose stored value can be an empty string. */
const CAN_HOLD_EMPTY_STRING = new Set(['code', 'email', 'radio', 'select', 'text', 'textarea'])

/** Operators whose operand is a search needle or a flag, not a field value. */
const UNCAST_OPERATORS = new Set(['exists', 'like'])

const LIST_OPERATORS = new Set(['in', 'not_in'])

export function castWhere(where: undefined | Where, ctx: CastContext): undefined | Where {
  if (!where || typeof where !== 'object') return where

  const out: Where = {}
  // Clauses a rewrite needs AND-ed onto this level (see `exists` below).
  const extra: Where[] = []

  for (const [key, raw] of Object.entries(where)) {
    if (key === 'and' || key === 'or') {
      out[key] = Array.isArray(raw)
        ? raw.map((sub) => (sub && typeof sub === 'object' ? castWhere(sub, ctx)! : sub))
        : (raw as Where[])
      continue
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      out[key] = raw as Where[string]
      continue
    }

    const field = resolveField(ctx.fields, key)
    const cast = casterFor(key, field, ctx)
    const operators: Record<string, unknown> = {}

    for (const [operator, operand] of Object.entries(raw as Record<string, unknown>)) {
      if (operator === 'exists') {
        const wanted = toBoolean(operand)
        if (!field || !holdsEmptyString(field)) {
          operators['exists'] = wanted
        } else if (wanted) {
          // Present = has a value, and that value isn't the empty string.
          operators['exists'] = true
          extra.push({ [key]: { not_equals: '' } })
        } else {
          // Absent = no value, or an empty string.
          extra.push({ or: [{ [key]: { exists: false } }, { [key]: { equals: '' } }] })
        }
        continue
      }

      if (UNCAST_OPERATORS.has(operator)) {
        operators[operator] = operand
        continue
      }

      const value =
        LIST_OPERATORS.has(operator) && typeof operand === 'string'
          ? createArrayFromCommaDelineated(operand)
          : operand
      operators[operator] = Array.isArray(value) ? value.map(cast) : cast(value)
    }

    if (Object.keys(operators).length > 0) {
      out[key] = operators as Where[string]
    }
  }

  if (extra.length > 0) {
    // Sibling keys of a `Where` are AND-ed together, as are the members of
    // its `and` — so appending there keeps the meaning and avoids colliding
    // with an operator the caller already put on the same path.
    out.and = [...(Array.isArray(out.and) ? out.and : []), ...extra]
  }

  return out
}

/**
 * Walk a dotted path through groups, named tabs and arrays to the field it
 * names. Returns `null` when the path leaves the declared schema — including
 * when it continues past a field with no sub-fields (e.g. `author.name`
 * through a relationship), where guessing a type would be wrong.
 */
function resolveField(fields: FlattenedField[], path: string): FlattenedField | null {
  const segments = path.split('.')
  let current = fields

  for (const [index, segment] of segments.entries()) {
    const field = current.find((candidate) => candidate.name === segment)
    if (!field) return null
    if (index === segments.length - 1) return field
    if (!('flattenedFields' in field)) return null
    current = field.flattenedFields
  }

  return null
}

function holdsEmptyString(field: FlattenedField): boolean {
  if (!CAN_HOLD_EMPTY_STRING.has(field.type)) return false
  // `hasMany` text/select fields store a list, never a bare string.
  return !('hasMany' in field && field.hasMany)
}

function casterFor(
  path: string,
  field: FlattenedField | null,
  ctx: CastContext,
): (value: unknown) => unknown {
  if (!field) {
    // `id` is framework-owned and only shows up in `fields` when a
    // collection declares a custom one.
    return path === 'id' ? (value) => castId(value, ctx.idType) : keep
  }

  switch (field.type) {
    case 'checkbox':
      return castCheckbox
    case 'date':
      return castDate
    case 'number':
      return castNumber
    case 'relationship':
    case 'upload': {
      const { relationTo } = field
      return (value) => {
        if (value === 'null') return null
        if (typeof relationTo === 'string') return castId(value, ctx.idTypeOf(relationTo))
        // Polymorphic: only the `{ relationTo, value }` form says which
        // collection the id belongs to.
        if (isRelationValue(value)) {
          return { ...value, value: castId(value.value, ctx.idTypeOf(value.relationTo)) }
        }
        return value
      }
    }
    default:
      return keep
  }
}

const keep = (value: unknown): unknown => value

function toBoolean(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.toLowerCase() === 'true')
}

function castCheckbox(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const lowered = value.toLowerCase()
  if (lowered === 'true') return true
  if (lowered === 'false') return false
  return value
}

function castNumber(value: unknown): unknown {
  if (typeof value !== 'string' || value.trim() === '') return value
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : value
}

function castDate(value: unknown): unknown {
  const isCandidate =
    (typeof value === 'string' && value.trim() !== '') ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    value instanceof Date
  if (!isCandidate) return value
  const parsed = new Date(value as Date | number | string)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
}

/**
 * Text ids are left alone on purpose — a text-id collection can still hold a
 * numeric `id` (a number passed as `customID`), so stringifying operands
 * would break lookups that work today.
 */
function castId(value: unknown, idType: IdType): unknown {
  return idType === 'number' ? castNumber(value) : value
}

function isRelationValue(value: unknown): value is { relationTo: string; value: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { relationTo?: unknown }).relationTo === 'string' &&
    'value' in value
  )
}

// ---------------------------------------------------------------------------
// Adapter-facing entry points. One per kind of partition a `where` can target.
// Each falls back to returning `where` untouched when the slug isn't in the
// config — same "skip, don't kill the operation" stance as `resolveSchema`.
// ---------------------------------------------------------------------------

function idTypeOf(adapter: DynamoAdapter, collectionSlug: string): IdType {
  return adapter.payload?.collections?.[collectionSlug]?.customIDType ?? adapter.defaultIDType
}

/** `where` in document terms, against a collection's main partition. */
export function castCollectionWhere(
  adapter: DynamoAdapter,
  slug: string,
  where: undefined | Where,
): undefined | Where {
  const fields = adapter.payload?.collections?.[slug]?.config.flattenedFields
  if (!where || !fields) return where
  return castWhere(where, {
    fields,
    idType: idTypeOf(adapter, slug),
    idTypeOf: (related) => idTypeOf(adapter, related),
  })
}

/** `where` against a global's singleton row. */
export function castGlobalWhere(
  adapter: DynamoAdapter,
  slug: string,
  where: undefined | Where,
): undefined | Where {
  const fields = adapter.payload?.config?.globals?.find((g) => g.slug === slug)?.flattenedFields
  if (!where || !fields) return where
  return castWhere(where, {
    fields,
    idType: 'text',
    idTypeOf: (related) => idTypeOf(adapter, related),
  })
}

/**
 * `where` in version-row terms (`parent`, `latest`, `version.<field>`, …),
 * against the versions partition of a collection or global.
 */
export function castVersionsWhere(
  adapter: DynamoAdapter,
  parent: { kind: 'collection' | 'global'; slug: string },
  where: undefined | Where,
): undefined | Where {
  if (!where) return where
  const fields = versionFields(adapter, parent)
  if (!fields) return where
  return castWhere(where, {
    fields,
    // Version rows are keyed by ids the adapter generates itself (UUIDs).
    idType: 'text',
    idTypeOf: (related) => idTypeOf(adapter, related),
  })
}

const versionFieldsCache = new WeakMap<DynamoAdapter, Map<string, FlattenedField[]>>()

function versionFields(
  adapter: DynamoAdapter,
  parent: { kind: 'collection' | 'global'; slug: string },
): FlattenedField[] | null {
  const config = adapter.payload?.config
  if (!config) return null

  let cache = versionFieldsCache.get(adapter)
  if (!cache) {
    cache = new Map()
    versionFieldsCache.set(adapter, cache)
  }
  const cacheKey = `${parent.kind}:${parent.slug}`
  const cached = cache.get(cacheKey)
  if (cached) return cached

  let fields: FlattenedField[] | null = null
  if (parent.kind === 'collection') {
    const collection = adapter.payload.collections?.[parent.slug]?.config
    if (collection) fields = buildVersionCollectionFields(config, collection, true)
  } else {
    const global = config.globals?.find((g) => g.slug === parent.slug)
    if (global) fields = buildVersionGlobalFields(config, global, true)
  }

  if (fields) cache.set(cacheKey, fields)
  return fields
}
