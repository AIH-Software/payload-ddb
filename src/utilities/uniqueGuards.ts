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
 * A guard also answers "which document has this value?" in one `GetItem`,
 * so lookups by a unique field are routed through it — see `indexLookup`.
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

/** One field value found in a document, with where it lives. */
export type Leaf = {
  field: FlattenedField
  /** Schema path, without locale — what a validation error names. */
  schemaPath: string
  /** Path the value is stored under, locale key included (`title.en`). */
  storedPath: string
  value: unknown
}

const cache = new WeakMap<DynamoAdapter, Map<string, boolean>>()

function fieldsOf(adapter: DynamoAdapter, collectionSlug: string): FlattenedField[] | undefined {
  return adapter.payload?.collections?.[collectionSlug]?.config.flattenedFields
}

/** Whether a collection declares any unique field the adapter guards. */
export function hasUniqueFields(adapter: DynamoAdapter, collectionSlug: string): boolean {
  let known = cache.get(adapter)
  if (!known) {
    known = new Map()
    cache.set(adapter, known)
  }
  const cached = known.get(collectionSlug)
  if (cached !== undefined) return cached

  const fields = fieldsOf(adapter, collectionSlug)
  const result = fields ? containsUnique(fields) : false
  known.set(collectionSlug, result)
  return result
}

/** A unique field whose values get guard rows. */
export function isGuardable(field: FlattenedField): boolean {
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

/**
 * Walk a document along its collection's schema and report the value of
 * every field `accept` picks. Groups and named tabs are descended into;
 * arrays and blocks are not (a row in a list has no single stored path). A
 * localized field is reported once per configured locale.
 *
 * Every accepted field is reported even when the document has nothing
 * there — a missing group, a locale without a value — with `undefined` as
 * its value, so callers that need one entry per document get one.
 */
export function visitLeaves(
  adapter: DynamoAdapter,
  collectionSlug: string,
  doc: Record<string, unknown>,
  accept: (field: FlattenedField) => boolean,
  visit: (leaf: Leaf) => void,
): void {
  const fields = fieldsOf(adapter, collectionSlug)
  if (!fields) return
  const localeCodes = adapter.payload.config.localization
    ? adapter.payload.config.localization.localeCodes
    : null

  collect(doc, fields, [], [], false)

  function collect(
    source: unknown,
    level: FlattenedField[],
    schemaPath: string[],
    storedPath: string[],
    parentIsLocalized: boolean,
  ): void {
    const record =
      source && typeof source === 'object' && !Array.isArray(source)
        ? (source as Record<string, unknown>)
        : {}

    for (const field of level) {
      if (field.type === 'array' || field.type === 'blocks') continue
      const isContainer = 'flattenedFields' in field
      if (!isContainer && !accept(field)) continue

      const value = record[field.name]
      const schema = [...schemaPath, field.name]
      const stored = [...storedPath, field.name]
      const localized = Boolean(localeCodes) && fieldShouldBeLocalized({ field, parentIsLocalized })

      // A localized field holds one value per locale; visit each.
      const perLocale =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {}
      const variants: [unknown, string[]][] = localized
        ? localeCodes!.map((locale) => [perLocale[locale], [...stored, locale]])
        : [[value, stored]]

      for (const [inner, innerStored] of variants) {
        if (isContainer) {
          collect(inner, field.flattenedFields, schema, innerStored, parentIsLocalized || localized)
          continue
        }
        visit({
          field,
          schemaPath: schema.join('.'),
          storedPath: innerStored.join('.'),
          value: inner,
        })
      }
    }
  }
}

/** The partition holding the guards of one unique field. */
export function guardPartition(partition: string, storedPath: string): string {
  return `${partition}#unique#${storedPath}`
}

/** Every guard a document's current values call for. */
export function uniqueGuardsFor(
  adapter: DynamoAdapter,
  collectionSlug: string,
  partition: string,
  doc: Record<string, unknown>,
): UniqueGuard[] {
  if (!hasUniqueFields(adapter, collectionSlug)) return []

  const guards: UniqueGuard[] = []
  visitLeaves(adapter, collectionSlug, doc, isGuardable, (leaf) => {
    const sk = encodeValue(leaf.value)
    if (sk === null) return
    guards.push({
      key: { pk: guardPartition(partition, leaf.storedPath), sk },
      path: leaf.schemaPath,
    })
  })
  return guards
}

/**
 * Turn a value into a guard's sort key. The type tag keeps `1` and `'1'`
 * apart; long strings are hashed because a sort key is capped at 1024 bytes.
 * Returns `null` for values that aren't guarded.
 */
export function encodeValue(value: unknown): null | string {
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
