import type { FlattenedField } from 'payload'

import { createHash } from 'node:crypto'
import { fieldShouldBeLocalized } from 'payload/shared'

import type { DynamoAdapter } from '../types.js'

/**
 * Uniqueness for fields declared `unique: true`.
 *
 * DynamoDB can only enforce uniqueness on a primary key, so each unique
 * value gets a small *guard row* whose key *is* the value:
 *
 *     pk = "<collection partition>#unique#<stored field path>"
 *     sk = "<type tag>:<value>"
 *     owner = "<id of the document holding the value>"
 *
 * A document and its guards are written in one `TransactWriteItems`, each
 * guard conditioned on "no such row, or it's already mine". A second
 * document claiming the same value fails that condition and the whole write
 * is cancelled. Guards live in their own partitions, so they never show up
 * in a collection's reads.
 *
 * Covered: scalar unique fields at the top level or inside groups / named
 * tabs, including localized ones (one guard per locale). Not covered:
 * unique fields inside arrays or blocks, and `hasMany` fields — a list has
 * no single value to key on.
 *
 * Empty values (`null`, `undefined`, `''`) are not guarded: any number of
 * documents may leave a unique field blank.
 */

export type UniqueGuard = {
  key: { pk: string; sk: string }
  /** Schema path of the field, without locale — what a validation error names. */
  path: string
}

type UniqueField = { field: FlattenedField; path: string[] }

const cache = new WeakMap<DynamoAdapter, Map<string, boolean>>()

/** Whether a collection declares any unique field the adapter guards. */
export function hasUniqueFields(adapter: DynamoAdapter, collectionSlug: string): boolean {
  let known = cache.get(adapter)
  if (!known) {
    known = new Map()
    cache.set(adapter, known)
  }
  const cached = known.get(collectionSlug)
  if (cached !== undefined) return cached

  const fields = adapter.payload?.collections?.[collectionSlug]?.config.flattenedFields
  const result = fields ? containsUnique(fields) : false
  known.set(collectionSlug, result)
  return result
}

function isGuardable(field: FlattenedField): boolean {
  return (
    'unique' in field &&
    Boolean(field.unique) &&
    field.name !== 'id' &&
    !('hasMany' in field && field.hasMany)
  )
}

function containsUnique(fields: FlattenedField[]): boolean {
  return fields.some((field) => {
    if (field.type === 'array' || field.type === 'blocks') return false
    if ('flattenedFields' in field) return containsUnique(field.flattenedFields)
    return isGuardable(field)
  })
}

/** Every guard a document's current values call for. */
export function uniqueGuardsFor(
  adapter: DynamoAdapter,
  collectionSlug: string,
  partition: string,
  doc: Record<string, unknown>,
): UniqueGuard[] {
  if (!hasUniqueFields(adapter, collectionSlug)) return []
  const fields = adapter.payload.collections[collectionSlug]!.config.flattenedFields
  const localeCodes = adapter.payload.config.localization
    ? adapter.payload.config.localization.localeCodes
    : null

  const guards: UniqueGuard[] = []
  collect(doc, fields, [], [], false)
  return guards

  function collect(
    source: unknown,
    level: FlattenedField[],
    schemaPath: string[],
    storedPath: string[],
    parentIsLocalized: boolean,
  ): void {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return
    const record = source as Record<string, unknown>

    for (const field of level) {
      if (field.type === 'array' || field.type === 'blocks') continue
      const isContainer = 'flattenedFields' in field
      if (!isContainer && !isGuardable(field)) continue

      const value = record[field.name]
      const schema = [...schemaPath, field.name]
      const stored = [...storedPath, field.name]
      const localized = Boolean(localeCodes) && fieldShouldBeLocalized({ field, parentIsLocalized })

      // A localized field holds one value per locale; visit each.
      const variants: [unknown, string[]][] =
        localized && value && typeof value === 'object' && !Array.isArray(value)
          ? Object.entries(value as Record<string, unknown>)
              .filter(([locale]) => localeCodes!.includes(locale))
              .map(([locale, inner]) => [inner, [...stored, locale]])
          : localized
            ? []
            : [[value, stored]]

      for (const [inner, innerStored] of variants) {
        if (isContainer) {
          collect(inner, field.flattenedFields, schema, innerStored, parentIsLocalized || localized)
          continue
        }
        const sk = encodeValue(inner)
        if (sk === null) continue
        guards.push({
          key: { pk: `${partition}#unique#${innerStored.join('.')}`, sk },
          path: schema.join('.'),
        })
      }
    }
  }
}

/**
 * Turn a value into a sort key. The type tag keeps `1` and `'1'` apart;
 * long strings are hashed because a sort key is capped at 1024 bytes.
 * Returns `null` for values that aren't guarded.
 */
function encodeValue(value: unknown): null | string {
  switch (typeof value) {
    case 'boolean':
      return `b:${value}`
    case 'number':
      return Number.isFinite(value) ? `n:${value}` : null
    case 'string':
      if (value === '') return null
      return value.length > 256
        ? `h:${createHash('sha256').update(value).digest('hex')}`
        : `s:${value}`
    default:
      return null
  }
}

export function sameGuard(a: UniqueGuard, b: UniqueGuard): boolean {
  return a.key.pk === b.key.pk && a.key.sk === b.key.sk
}
