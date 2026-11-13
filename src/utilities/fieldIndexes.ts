import type { FlattenedField } from 'payload'

import { fieldShouldBeLocalized } from 'payload/shared'

import type { DynamoAdapter } from '../types.js'

import { guardPartition, hasUniqueFields, isGuardable, visitLeaves } from './uniqueGuards.js'

/**
 * Which fields can be looked up without reading a whole partition, and the
 * rows that make that possible.
 *
 * Indexes are ordinary rows in the same table (never DynamoDB GSIs, which
 * can't be read consistently). There are three kinds:
 *
 *  - **`unique`** — a `unique: true` field. Its guard rows (`uniqueGuards`)
 *    already map each value to the one document holding it, so nothing more
 *    is written.
 *  - **`rows`** — an `index: true` field, or a version row's `parent`. Each
 *    value a document holds gets an *index row*:
 *
 *        pk = "<partition>#index#<stored field path>"
 *        sk = "<value key>#<document id>"
 *        owner = "<document id>"
 *
 *    Value keys sort the way the values do (see `valueKey`), so the rows of
 *    one index are in value order: "who has this value?" is a `Query` on a
 *    key prefix, a range filter is a `Query` between two keys, and reading
 *    the index front to back visits the documents in sorted order. A
 *    `hasMany` field gets one row per element. A single-valued field gets
 *    exactly one row per document — under the "no value" key when it's blank
 *    — which is what makes its index usable for sorting (`ordered`).
 *  - **`latest`** — one *pointer* row per versioned document, naming its
 *    latest version:
 *
 *        pk = "<versions partition>#latest"
 *        sk = "<value key of the parent id>"
 *        owner = "<id of the version row with latest = true>"
 *
 * Index rows are written and removed in the same transaction as the row
 * they describe (`writeItems`), so a lookup through them is as consistent as
 * a read of the partition itself. A row that outlives its value is harmless:
 * every lookup re-checks the documents it finds.
 *
 * Only fields where a lookup can be selective are indexed — text, email,
 * number, date, relationship and upload. Payload also flags `_status` and
 * checkboxes with `index: true`; pointing at half a partition row by row
 * costs more than reading it, so those are left out. So are the timestamps
 * Payload manages itself: an index on `updatedAt` would turn every update
 * into a transaction, and one on `createdAt` every insert.
 */

export type FieldIndex = {
  kind: 'latest' | 'rows' | 'unique'
  /**
   * `rows` only: every document has exactly one row in this index, so
   * walking it visits each document once, in value order.
   */
  ordered: boolean
  /** Partition holding this index's rows. */
  partition: string
  /** Path the value is stored under, locale key included (`title.en`). */
  path: string
}

export type IndexRow = { pk: string; sk: string }

/** Field types worth an index row. */
const ROW_TYPES = new Set(['date', 'email', 'number', 'relationship', 'text', 'upload'])

/** Fields Payload flags itself that change (or are set) on every write. */
const UNINDEXED_FIELDS = new Set(['createdAt', 'deletedAt', 'updatedAt'])

/**
 * Collections whose rows are also written outside the collection write path
 * (`updateJobs`), and whose lookups are queue polls that match most of the
 * partition anyway.
 */
const UNINDEXED_COLLECTIONS = new Set(['payload-jobs'])

/** An `index: true` field whose values get index rows. */
function isRowIndexable(field: FlattenedField): boolean {
  if (!ROW_TYPES.has(field.type) || field.name === 'id' || isGuardable(field)) return false
  if (UNINDEXED_FIELDS.has(field.name)) return false
  const flagged =
    ('index' in field && Boolean(field.index)) || ('unique' in field && Boolean(field.unique))
  if (!flagged) return false
  // A polymorphic relationship stores `{ relationTo, value }`, not a scalar.
  if ('relationTo' in field && typeof field.relationTo !== 'string') return false
  return true
}

const isMulti = (field: FlattenedField): boolean => 'hasMany' in field && Boolean(field.hasMany)

export type IndexedPartition = {
  indexes: FieldIndex[]
  /** `collection` rows are documents; `versions` rows are version rows. */
  kind: 'collection' | 'versions'
  partition: string
  /** The collection or global the partition belongs to. */
  slug: string
}

type Registry = {
  /** Partition → its lookup indexes (`unique` and `rows`), by stored path. */
  byPartition: Map<string, Map<string, FieldIndex>>
  /** Every partition this config owns: collections, globals and versions. */
  known: Set<string>
  /** Versions partition → its `latest` pointer index. */
  latest: Map<string, FieldIndex>
  partitions: IndexedPartition[]
  /** Collection slugs that have at least one `rows` index. */
  withRows: Set<string>
}

const emptyRegistry = (): Registry => ({
  byPartition: new Map(),
  known: new Set(),
  latest: new Map(),
  partitions: [],
  withRows: new Set(),
})
const registries = new WeakMap<DynamoAdapter, Registry>()

function registry(adapter: DynamoAdapter): Registry {
  const cached = registries.get(adapter)
  if (cached) return cached

  const config = adapter.payload?.config
  if (!config?.collections) return emptyRegistry()

  const built = emptyRegistry()
  const localeCodes = config.localization ? config.localization.localeCodes : null

  const register = (entry: IndexedPartition, lookups: Map<string, FieldIndex>): void => {
    if (entry.indexes.length === 0) return
    built.partitions.push(entry)
    if (lookups.size > 0) built.byPartition.set(entry.partition, lookups)
  }

  /** A versions partition: version rows by `parent`, and the `latest` pointers. */
  const registerVersions = (slug: string, hasParent: boolean): void => {
    const partition = adapter.resolveVersionsPartition(slug)
    built.known.add(partition)
    if (!adapter.indexes) return

    const lookups = new Map<string, FieldIndex>()
    if (hasParent) {
      lookups.set('parent', {
        kind: 'rows',
        ordered: false,
        partition: indexPartition(partition, 'parent'),
        path: 'parent',
      })
    }
    const pointers: FieldIndex = {
      kind: 'latest',
      ordered: false,
      partition: latestPartition(partition),
      path: 'latest',
    }
    built.latest.set(partition, pointers)
    register(
      { indexes: [...lookups.values(), pointers], kind: 'versions', partition, slug },
      lookups,
    )
  }

  for (const collection of config.collections) {
    const partition = adapter.resolvePartition(collection.slug)
    built.known.add(partition)
    if (collection.versions) registerVersions(collection.slug, true)
    // With `indexes: false` the partitions are known but none has an index.
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
              ordered: false,
              partition: guardPartition(partition, stored),
              path: stored,
            })
          } else if (rowsAllowed && isRowIndexable(field)) {
            const stored = path.join('.')
            indexes.set(stored, {
              kind: 'rows',
              ordered: !isMulti(field),
              partition: indexPartition(partition, stored),
              path: stored,
            })
            built.withRows.add(collection.slug)
          }
        }
      }
    }
    enumerate(collection.flattenedFields, [], false)

    register(
      { indexes: [...indexes.values()], kind: 'collection', partition, slug: collection.slug },
      indexes,
    )
  }

  for (const global of config.globals ?? []) {
    built.known.add(adapter.resolvePartition(global.slug))
    if (global.versions) registerVersions(global.slug, false)
  }

  registries.set(adapter, built)
  return built
}

/** The partition holding the index rows of one field. */
export function indexPartition(partition: string, storedPath: string): string {
  return `${partition}#index#${storedPath}`
}

/** The partition holding the `latest` pointers of a versions partition. */
export function latestPartition(versionsPartition: string): string {
  return `${versionsPartition}#latest`
}

/**
 * The partition an index partition (of any kind) belongs to, if that
 * partition is part of this config.
 */
export function ownerPartitionOf(adapter: DynamoAdapter, partition: string): null | string {
  const match = /^(.*?)(?:#(?:index|unique)#.*|#latest)$/.exec(partition)
  return match && registry(adapter).known.has(match[1]!) ? match[1]! : null
}

/** The lookup indexes of the rows stored at `partition`, by stored path. */
export function indexesOf(
  adapter: DynamoAdapter,
  partition: string,
): ReadonlyMap<string, FieldIndex> | undefined {
  return registry(adapter).byPartition.get(partition)
}

/** The `latest` pointer index of a versions partition, if it has one. */
export function latestIndexOf(
  adapter: DynamoAdapter,
  versionsPartition: string,
): FieldIndex | undefined {
  return registry(adapter).latest.get(versionsPartition)
}

/** Every partition that has indexes, with those indexes. */
export function indexedPartitions(adapter: DynamoAdapter): readonly IndexedPartition[] {
  return registry(adapter).partitions
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
  const add = (pk: string, key: string): void => {
    const sk = rowSortKey(key, id)
    rows.set(`${pk}\u0000${sk}`, { pk, sk })
  }

  visitLeaves(adapter, collectionSlug, doc, isRowIndexable, (leaf) => {
    const pk = indexPartition(partition, leaf.storedPath)
    if (isMulti(leaf.field)) {
      // A `hasMany` field holds a list; every element points at the document.
      for (const value of Array.isArray(leaf.value) ? leaf.value : []) {
        const key = valueKey(value)
        if (key !== null) add(pk, key)
      }
    } else {
      // Exactly one row per document, so the index can be walked in order.
      add(pk, valueKey(leaf.value) ?? NO_VALUE_KEY)
    }
  })
  return [...rows.values()]
}

export type VersionCompanions = {
  /** The key of the `latest` pointer this row holds, when it is the latest. */
  pointer: IndexRow | null
  rows: IndexRow[]
}

/** The index row and pointer a version row calls for. */
export function versionCompanionsFor(
  adapter: DynamoAdapter,
  versionsPartition: string,
  row: Record<string, unknown>,
): VersionCompanions {
  const pointers = latestIndexOf(adapter, versionsPartition)
  if (!pointers) return { pointer: null, rows: [] }

  const parentKey = valueKey(row['parent'])
  const byParent = indexesOf(adapter, versionsPartition)?.get('parent')
  return {
    pointer:
      row['latest'] === true ? { pk: pointers.partition, sk: pointerKey(row['parent']) } : null,
    rows:
      byParent && parentKey !== null
        ? [{ pk: byParent.partition, sk: rowSortKey(parentKey, String(row['id'])) }]
        : [],
  }
}

/** Sort key of the `latest` pointer for a parent (a global has no parent). */
export function pointerKey(parent: unknown): string {
  return valueKey(parent) ?? NO_VALUE_KEY
}

export function sameIndexRow(a: IndexRow, b: IndexRow): boolean {
  return a.pk === b.pk && a.sk === b.sk
}

// ---------------------------------------------------------------------------
// Value keys
// ---------------------------------------------------------------------------

/** Key of a single-valued field that holds nothing; sorts before every value. */
export const NO_VALUE_KEY = '0:'

/** Bytes of a string that go into its key; the rest only breaks ties by id. */
const MAX_TEXT_BYTES = 240

/**
 * The part of an index row's sort key that stands for a value. Keys compare
 * the way their values do, which is what lets an index answer range filters
 * and sorts:
 *
 *  - a number is `n:` plus its IEEE-754 bits, sign-adjusted so that the
 *    hexadecimal string orders like the number;
 *  - a string (dates are stored as ISO strings) is `s:` plus the hex of its
 *    UTF-8 bytes, which orders like the string and never contains the `#`
 *    that separates a key from the document id — so a value can't run into
 *    the id, and a shorter value sorts before any longer one it starts.
 *
 * The type tag keeps `1` and `'1'` apart and puts "no value" first, then
 * numbers, then strings. A long string is cut at `MAX_TEXT_BYTES`: lookups
 * re-check every document, so two values sharing a key only cost a wasted
 * read (see `isTruncatedKey` for where it matters).
 *
 * Returns `null` for anything that isn't a number or a string.
 */
export function valueKey(value: unknown): null | string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const bytes = Buffer.alloc(8)
    bytes.writeDoubleBE(value === 0 ? 0 : value)
    // Flip the sign bit of non-negatives, and every bit of negatives, so the
    // unsigned bytes order like the number.
    if (bytes[0]! & 0x80) {
      for (let index = 0; index < 8; index++) bytes[index] = ~bytes[index]! & 0xff
    } else {
      bytes[0] = bytes[0]! | 0x80
    }
    return `n:${bytes.toString('hex')}`
  }
  if (typeof value === 'string') {
    return `s:${Buffer.from(value, 'utf8').subarray(0, MAX_TEXT_BYTES).toString('hex')}`
  }
  return null
}

/** Whether a key stands for the start of a longer string, not a whole value. */
export function isTruncatedKey(key: string): boolean {
  return key.startsWith('s:') && key.length >= 2 + MAX_TEXT_BYTES * 2
}

/** An index row's sort key: the value key, `#`, the document id. */
export function rowSortKey(key: string, id: string): string {
  return `${key}#${id}`
}

/** The value key an index row's sort key starts with. */
export function keyOfRow(sortKey: string): string {
  const end = sortKey.indexOf('#')
  return end === -1 ? sortKey : sortKey.slice(0, end)
}
