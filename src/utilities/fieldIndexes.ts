import type { FlattenedField } from 'payload'

import { createHash } from 'node:crypto'
import { fieldShouldBeLocalized } from 'payload/shared'

import type { DynamoAdapter } from '../types.js'

import { guardPartition, hasUniqueFields, isGuardable, visitLeaves } from './uniqueGuards.js'

/**
 * Which fields of a collection can be looked up without reading the whole
 * partition, and the rows that make that possible.
 *
 * Two kinds of index exist, both stored as ordinary rows in the same table
 * (never DynamoDB GSIs, which can't be read consistently):
 *
 *  - **`unique`** — a `unique: true` field. Its guard rows (`uniqueGuards`)
 *    already map each value to the one document holding it, so nothing more
 *    is written.
 *  - **`rows`** — an `index: true` field. Each value a document holds gets an
 *    *index row*:
 *
 *        pk = "<collection partition>#index#<stored field path>"
 *        sk = "<type tag>:<value>#<document id>"
 *        owner = "<document id>"
 *
 *    All documents holding a value sit next to each other, so "who has this
 *    value?" is one `Query` on a key prefix. A `hasMany` field gets one row
 *    per element.
 *
 * Index rows are written and removed in the same transaction as the
 * document (`writeItems`), so a lookup through them is as consistent as a
 * read of the partition itself. A row that outlives its value (possible only
 * for the overflow cases noted in `writeItems`) is harmless: every lookup
 * re-checks the documents it finds.
 *
 * Only fields where an equality lookup is selective are indexed — text,
 * email, number, relationship and upload. Payload also flags timestamps,
 * `_status` and checkboxes with `index: true`; pointing at half a partition
 * row by row costs more than reading the partition, so those are left out.
 */

export type FieldIndex = {
  kind: 'rows' | 'unique'
  /** Partition holding this index's rows. */
  partition: string
  /** Path the value is stored under, locale key included (`title.en`). */
  path: string
}

export type IndexRow = { pk: string; sk: string }

/** Field types worth an index row. */
const ROW_TYPES = new Set(['email', 'number', 'relationship', 'text', 'upload'])

/**
 * Collections whose rows are also written outside the collection write path
 * (`updateJobs`), and whose lookups are queue polls that match most of the
 * partition anyway.
 */
const UNINDEXED_COLLECTIONS = new Set(['payload-jobs'])

/** An `index: true` field whose values get index rows. */
function isRowIndexable(field: FlattenedField): boolean {
  if (!ROW_TYPES.has(field.type) || field.name === 'id' || isGuardable(field)) return false
  const flagged =
    ('index' in field && Boolean(field.index)) || ('unique' in field && Boolean(field.unique))
  if (!flagged) return false
  // A polymorphic relationship stores `{ relationTo, value }`, not a scalar.
  if ('relationTo' in field && typeof field.relationTo !== 'string') return false
  return true
}

type Registry = {
  /** Collection partition → its indexes, by stored path. */
  byPartition: Map<string, Map<string, FieldIndex>>
  /** Collection partition → slug. */
  slugOf: Map<string, string>
  /** Slugs that have at least one `rows` index. */
  withRows: Set<string>
}

const EMPTY: Registry = { byPartition: new Map(), slugOf: new Map(), withRows: new Set() }
const registries = new WeakMap<DynamoAdapter, Registry>()

function registry(adapter: DynamoAdapter): Registry {
  const cached = registries.get(adapter)
  if (cached) return cached

  const config = adapter.payload?.config
  if (!config?.collections) return EMPTY

  const built: Registry = { byPartition: new Map(), slugOf: new Map(), withRows: new Set() }
  const localeCodes = config.localization ? config.localization.localeCodes : null

  for (const collection of config.collections) {
    const partition = adapter.resolvePartition(collection.slug)
    built.slugOf.set(partition, collection.slug)
    // With `indexes: false` the collections are known but none has an index.
    if (!adapter.indexes) continue

    const indexes = new Map<string, FieldIndex>()
    const rowsAllowed = !UNINDEXED_COLLECTIONS.has(collection.slug)

    const enumerate = (
      fields: FlattenedField[],
      prefix: string[],
      parentIsLocalized: boolean,
    ): void => {
      for (const field of fields) {
        if (field.type === 'array' || field.type === 'blocks') continue
        const localized =
          Boolean(localeCodes) && fieldShouldBeLocalized({ field, parentIsLocalized })
        const paths = localized
          ? localeCodes!.map((locale) => [...prefix, field.name, locale])
          : [[...prefix, field.name]]

        for (const path of paths) {
          if ('flattenedFields' in field) {
            enumerate(field.flattenedFields, path, parentIsLocalized || localized)
          } else if (isGuardable(field)) {
            const stored = path.join('.')
            indexes.set(stored, {
              kind: 'unique',
              partition: guardPartition(partition, stored),
              path: stored,
            })
          } else if (rowsAllowed && isRowIndexable(field)) {
            const stored = path.join('.')
            indexes.set(stored, {
              kind: 'rows',
              partition: indexPartition(partition, stored),
              path: stored,
            })
            built.withRows.add(collection.slug)
          }
        }
      }
    }
    enumerate(collection.flattenedFields, [], false)

    if (indexes.size > 0) built.byPartition.set(partition, indexes)
  }

  registries.set(adapter, built)
  return built
}

/** The partition holding the index rows of one field. */
export function indexPartition(partition: string, storedPath: string): string {
  return `${partition}#index#${storedPath}`
}

/**
 * The collection partition an index partition (or guard partition) belongs
 * to, if that collection is part of this config.
 */
export function collectionPartitionOf(adapter: DynamoAdapter, partition: string): null | string {
  const match = /^(.*?)#(?:index|unique)#/.exec(partition)
  return match && registry(adapter).slugOf.has(match[1]!) ? match[1]! : null
}

/** The indexes of the collection stored at `partition`, by stored path. */
export function indexesOf(
  adapter: DynamoAdapter,
  partition: string,
): ReadonlyMap<string, FieldIndex> | undefined {
  return registry(adapter).byPartition.get(partition)
}

/** Every collection that has indexes: its slug, partition and indexes. */
export function indexedCollections(
  adapter: DynamoAdapter,
): { indexes: FieldIndex[]; partition: string; slug: string }[] {
  const { byPartition, slugOf } = registry(adapter)
  return [...byPartition].map(([partition, indexes]) => ({
    indexes: [...indexes.values()],
    partition,
    slug: slugOf.get(partition)!,
  }))
}

/**
 * Whether writing or deleting a document of this collection touches rows
 * besides the document itself — unique guards, index rows, or both. Deletes
 * need the document's values to find those rows, so they read it first.
 */
export function hasCompanionRows(adapter: DynamoAdapter, collectionSlug: string): boolean {
  return hasUniqueFields(adapter, collectionSlug) || registry(adapter).withRows.has(collectionSlug)
}

/** Every index row a document's current values call for. */
export function indexRowsFor(
  adapter: DynamoAdapter,
  collectionSlug: string,
  partition: string,
  doc: Record<string, unknown>,
): IndexRow[] {
  if (!registry(adapter).withRows.has(collectionSlug)) return []

  const id = String(doc['id'])
  const rows = new Map<string, IndexRow>()
  visitLeaves(adapter, collectionSlug, doc, isRowIndexable, (leaf) => {
    const pk = indexPartition(partition, leaf.storedPath)
    // A `hasMany` field holds a list; every element points at the document.
    for (const value of Array.isArray(leaf.value) ? leaf.value : [leaf.value]) {
      const key = indexValueKey(value)
      if (key === null) continue
      const sk = `${key}#${id}`
      rows.set(`${pk}\u0000${sk}`, { pk, sk })
    }
  })
  return [...rows.values()]
}

export function sameIndexRow(a: IndexRow, b: IndexRow): boolean {
  return a.pk === b.pk && a.sk === b.sk
}

/**
 * The part of an index row's sort key that stands for the value. A row's
 * full sort key is this, a `#`, and the document id.
 *
 * The type tag keeps `1` and `'1'` apart. `#` is escaped inside the value so
 * the first `#` of a sort key always ends the value — otherwise the value
 * `a` held by document `b#c` and the value `a#b` held by document `c` would
 * share one row. Long strings are hashed to stay inside the 1024-byte sort
 * key. Returns `null` for values that aren't indexed (blank, or not a scalar).
 */
export function indexValueKey(value: unknown): null | string {
  if (typeof value === 'number') return Number.isFinite(value) ? `n:${value}` : null
  if (typeof value !== 'string' || value === '') return null

  const escaped = value.replace(/[%#]/g, (char) => (char === '%' ? '%25' : '%23'))
  return Buffer.byteLength(escaped) > 512
    ? `h:${createHash('sha256').update(value).digest('hex')}`
    : `s:${escaped}`
}
