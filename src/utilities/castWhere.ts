import type { FlattenedField, Where } from 'payload'

import { createArrayFromCommaDelineated } from 'payload'
import { fieldShouldBeLocalized } from 'payload/shared'

import { JS_ONLY_MARKER } from './operators.js'

/**
 * Rewrite a Payload `Where` into the terms the stored rows are in, before
 * either evaluator (`buildFilterExpression` or `matchesWhere`) sees it. Three
 * things happen per clause, all driven by the field the path points at:
 *
 * **Operands are cast** to the type the field stores. They routinely arrive
 * as strings: the REST API parses `?where[price][greater_than]=10` with
 * `qs`, which yields `"10"`, and the admin list filters go the same way.
 * Mongoose and SQL drivers quietly coerce those against their schema.
 * DynamoDB has no schema and compares strictly by type — `"10"` never equals
 * or orders against the number `10` — so without this such a filter matches
 * nothing and reports no error. The rules follow Payload's Mongo and
 * Postgres adapters (`sanitizeQueryValue`), minus their database quirks:
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
 *  - `in` / `not_in` / `all`: a comma-delimited string → array, each member
 *    cast.
 *  - `exists`: operand → boolean (`'false'` is a truthy string otherwise),
 *    and for fields that can hold text, an empty string counts as absent —
 *    that's what the admin UI leaves behind when a text input is cleared.
 *  - `contains` on a `hasMany` select or a relationship means "has this
 *    value", so it becomes `equals` / `in`.
 *
 * **Localized paths get their locale key.** A localized field is stored as
 * `{ en: …, es: … }`, so `title` becomes `title.en` for the request's locale
 * (unless the caller already wrote a locale into the path).
 *
 * **Paths DynamoDB can't address are marked** with `JS_ONLY_MARKER`: any that
 * run through an `array` / `blocks` field or a `hasMany` value, or into a
 * field whose inner shape the schema doesn't describe (`json`, rich text).
 * The pushdown skips those clauses; `matchesWhere` evaluates them with
 * any-element semantics.
 *
 * Anything it can't confidently cast is left exactly as given: an unknown
 * path, a path that continues past a leaf field, an unparseable value.
 *
 * Returns a new `Where`; the caller's object is never mutated.
 */

export type IdType = 'number' | 'text'

export type Localization = {
  /** Locale to address when a path doesn't name one. */
  locale: string
  localeCodes: string[]
}

export type CastContext = {
  /** Flattened fields of the entity the `where` targets. */
  fields: FlattenedField[]
  /** Type of the entity's own `id` when it isn't declared as a field. */
  idType: IdType
  /** Id type of another collection, for relationship operands. */
  idTypeOf: (collectionSlug: string) => IdType
  /** Set only when the Payload config has localization enabled. */
  localization?: Localization
}

/** Field types whose stored value can be an empty string. */
const CAN_HOLD_EMPTY_STRING = new Set(['code', 'email', 'radio', 'select', 'text', 'textarea'])

/**
 * Operators whose operand is a search needle, a flag or a geometry — not a
 * value of the field's own type.
 */
const UNCAST_OPERATORS = new Set(['intersects', 'like', 'near', 'not_like', 'within'])

const LIST_OPERATORS = new Set(['all', 'in', 'not_in'])

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

    const { field, multi, path } = resolvePath(ctx.fields, key, ctx.localization)
    const cast = casterFor(key, field, ctx)
    /** A clause on this path, carrying the JS-only marker when it needs one. */
    const clause = (operators: Record<string, unknown>): Where => ({
      [path]: (multi ? { ...operators, [JS_ONLY_MARKER]: true } : operators) as Where[string],
    })
    const castList = (operand: unknown): unknown =>
      Array.isArray(operand) ? operand.map(cast) : cast(operand)

    const operators: Record<string, unknown> = {}

    for (const [operator, operand] of Object.entries(raw as Record<string, unknown>)) {
      if (operator === 'exists') {
        const wanted = toBoolean(operand)
        if (!field || !holdsEmptyString(field)) {
          operators['exists'] = wanted
        } else if (wanted) {
          // Present = has a value, and that value isn't the empty string.
          operators['exists'] = true
          extra.push(clause({ not_equals: '' }))
        } else {
          // Absent = no value, or an empty string.
          extra.push({ or: [clause({ exists: false }), clause({ equals: '' })] })
        }
        continue
      }

      if (operator === 'contains') {
        if (field && holdsDiscreteValues(field)) {
          // "Contains" an option or an id means "has it" — there's no
          // substring to search.
          const value = castList(operand)
          extra.push(clause(Array.isArray(value) ? { in: value } : { equals: value }))
        } else {
          operators['contains'] = operand
        }
        continue
      }

      if (UNCAST_OPERATORS.has(operator)) {
        operators[operator] = operand
        continue
      }

      operators[operator] = castList(
        LIST_OPERATORS.has(operator) && typeof operand === 'string'
          ? createArrayFromCommaDelineated(operand)
          : operand,
      )
    }

    if (Object.keys(operators).length > 0) {
      Object.assign(out, clause(operators))
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

export type ResolvedPath = {
  /** The field the path ends on, when the schema describes it. */
  field: FlattenedField | null
  /** True when DynamoDB can't address the path as one value. */
  multi: boolean
  /** The path as stored: locale keys inserted after localized segments. */
  path: string
}

/**
 * Walk a dotted path through groups, named tabs, arrays and blocks to the
 * field it names, noting on the way whether it crosses anything list-shaped
 * and where locale keys belong.
 *
 * `field` is `null` when the path leaves the declared schema — an unknown
 * name, or a path that continues past a field with no sub-fields (a
 * polymorphic relationship's `.value`, a key inside `json`), where guessing
 * a type would be wrong.
 */
export function resolvePath(
  fields: FlattenedField[],
  path: string,
  localization?: Localization,
): ResolvedPath {
  const segments = path.split('.')
  const stored: string[] = []
  let current: FlattenedField[] | null = fields
  let field: FlattenedField | null = null
  let multi = false
  let parentIsLocalized = false

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!
    stored.push(segment)

    const found: FlattenedField | undefined = current?.find(
      (candidate) => candidate.name === segment,
    )
    if (!found) {
      // Off the schema from here on; copy the rest of the path as given.
      current = null
      field = null
      continue
    }
    field = found

    if (localization && fieldShouldBeLocalized({ field: found, parentIsLocalized })) {
      const next = segments[index + 1]
      if (next !== undefined && localization.localeCodes.includes(next)) {
        // The caller named a locale explicitly — keep theirs.
        stored.push(next)
        index++
      } else {
        stored.push(localization.locale)
      }
      parentIsLocalized = true
    }

    if (found.type === 'array' || found.type === 'blocks' || ('hasMany' in found && found.hasMany)) {
      multi = true
    }

    if (index === segments.length - 1) break

    if ('flattenedFields' in found) {
      current = found.flattenedFields
    } else if (found.type === 'blocks') {
      // Block rows are stored side by side in one list, so a sub-field name
      // is looked up across every block type.
      current = found.blocks.flatMap((block) => block.flattenedFields)
    } else {
      current = null
      // Relationships keep a known shape below them (`.value`, `.relationTo`).
      // Anything else — `json`, rich text — may hold lists we can't see.
      if (found.type !== 'relationship' && found.type !== 'upload') multi = true
    }
  }

  return { field, multi, path: stored.join('.') }
}

/** `hasMany` selects, and relationships of either arity, hold whole values to match — not text to search. */
function holdsDiscreteValues(field: FlattenedField): boolean {
  if (field.type === 'relationship' || field.type === 'upload') return true
  return field.type === 'select' && Boolean(field.hasMany)
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
