import type { Payload } from 'payload'

import type { DynamoAdapter } from '../types.js'

import {
  type FieldIndex,
  indexedPartitions,
  type IndexRow,
  indexRowsFor,
  versionCompanionsFor,
} from './fieldIndexes.js'
import { indexPages } from './indexLookup.js'
import { markIndexesReady } from './indexState.js'
import { mapWithConcurrency } from './mapWithConcurrency.js'
import { queryMatching } from './queryMatching.js'
import { revisionOf } from './stripInternalKeys.js'
import { hasUniqueFields, uniqueGuardsFor } from './uniqueGuards.js'
import {
  claimGuard,
  claimPointer,
  deleteIndexRowIfUnchanged,
  putIndexRow,
  WRITE_CONCURRENCY,
} from './writeItems.js'

/**
 * One-shot pass that builds unique guards, index rows and latest-version
 * pointers for rows written before the adapter kept them, then marks each
 * index as complete so lookups start using it.
 *
 * All of these are written with every document and version, so a row that
 * hasn't been saved since upgrading has none. Until this runs:
 *
 *  - a new document could take a unique value such a document already holds;
 *  - lookups by a `unique: true` or `index: true` field, and the search for
 *    a document's latest version, keep reading the whole partition, because
 *    an index that misses rows can't be trusted (see `indexState`).
 *
 * The pass walks every collection that has unique or indexed fields and
 * every versions partition. It also removes *stray* index rows — ones whose
 * document no longer holds the value — which an interrupted write can leave
 * behind. It is safe to re-run, and safe to run while the application is
 * serving: writes keep their own rows current, and nothing here overwrites
 * or removes a row a concurrent write has just put.
 *
 * Existing duplicates of a unique value can't both be guarded. The first
 * document reached keeps the value and the others are listed under
 * `conflicts`; that field's index is left unmarked. Fix those by hand
 * (change or clear the duplicated value) and run the pass again.
 *
 * @example
 *   import { getPayload } from 'payload'
 *   import config from './payload.config'
 *   import { backfillIndexes } from '@aih-software/payload-ddb'
 *
 *   const payload = await getPayload({ config })
 *   const report = await backfillIndexes(payload)
 *   console.log(JSON.stringify(report, null, 2))
 *   await payload.destroy()
 */
export interface IndexBackfillReport {
  collections: Record<
    string,
    {
      /** Unique values another document already holds a guard for. */
      conflicts: { heldBy: string; id: unknown; path: string }[]
      /** Guards this pass created or confirmed. */
      guarded: number
      /** Index rows this pass wrote. */
      indexed: number
      /** Stray index rows this pass removed. */
      pruned: number
      /** Stored paths of the indexes that are now complete and in use. */
      ready: string[]
      scanned: number
    }
  >
  /** Versions partitions, by the slug of their collection or global. */
  versions: Record<
    string,
    {
      /** By-parent index rows this pass wrote. */
      indexed: number
      /** Latest-version pointers this pass created. */
      pointers: number
      /** Stray index rows this pass removed. */
      pruned: number
      scanned: number
    }
  >
}

/** @deprecated Use `IndexBackfillReport`. */
export type UniqueBackfillReport = IndexBackfillReport

type Row = Record<string, unknown>

const keyOf = (row: IndexRow): string => `${row.pk}\u0000${row.sk}`

/**
 * Remove the rows of `index` that no scanned row called for. Each removal is
 * conditional on the row it points at being unchanged since the scan, so a
 * row some concurrent write has just made true is left alone.
 */
async function prune(
  adapter: DynamoAdapter,
  index: FieldIndex,
  partition: string,
  expected: ReadonlySet<string>,
  revisions: ReadonlyMap<string, number | undefined>,
): Promise<number> {
  let pruned = 0
  for await (const page of indexPages(adapter, index.partition)) {
    for (const found of page) {
      const row = { pk: index.partition, sk: String(found['sk']) }
      if (expected.has(keyOf(row))) continue
      const owner = String(found['owner'])
      const removed = await deleteIndexRowIfUnchanged(
        adapter,
        row,
        { pk: partition, sk: owner },
        // `null`: no such row was scanned, so it must still be absent.
        revisions.has(owner) ? revisions.get(owner) : null,
      )
      if (removed) pruned++
    }
  }
  return pruned
}

export async function backfillIndexes(payload: Payload): Promise<IndexBackfillReport> {
  const adapter = payload.db as DynamoAdapter
  if (!adapter.docClient) {
    throw new Error('payload-ddb: backfillIndexes requires a connected adapter.')
  }

  const report: IndexBackfillReport = { collections: {}, versions: {} }
  const indexed = new Map(indexedPartitions(adapter).map((entry) => [entry.partition, entry]))

  for (const slug of Object.keys(adapter.payload?.collections ?? {})) {
    const partition = adapter.resolvePartition(slug)
    const indexes = indexed.get(partition)?.indexes ?? []
    if (!hasUniqueFields(adapter, slug) && indexes.length === 0) continue

    const entry: IndexBackfillReport['collections'][string] = {
      conflicts: [],
      guarded: 0,
      indexed: 0,
      pruned: 0,
      ready: [],
      scanned: 0,
    }
    report.collections[slug] = entry
    /** Guard partitions where some document couldn't claim its value. */
    const contested = new Set<string>()
    const expected = new Set<string>()
    const revisions = new Map<string, number | undefined>()

    const rows = await queryMatching(adapter, partition, undefined)
    await mapWithConcurrency(rows, WRITE_CONCURRENCY, async (row) => {
      entry.scanned++
      const owner = String(row['id'])
      revisions.set(owner, revisionOf(row))

      for (const guard of uniqueGuardsFor(adapter, slug, partition, row)) {
        const heldBy = await claimGuard(adapter, guard, owner)
        if (heldBy === null) {
          entry.guarded++
        } else {
          entry.conflicts.push({ heldBy, id: row['id'], path: guard.path })
          contested.add(guard.key.pk)
        }
      }

      for (const indexRow of indexRowsFor(adapter, slug, partition, row)) {
        expected.add(keyOf(indexRow))
        await putIndexRow(adapter, indexRow, owner)
        entry.indexed++
      }
    })

    for (const index of indexes) {
      if (index.kind === 'rows') {
        entry.pruned += await prune(adapter, index, partition, expected, revisions)
      }
    }

    const complete = indexes.filter((index) => !contested.has(index.partition))
    await markIndexesReady(
      adapter,
      complete.map((index) => index.partition),
    )
    entry.ready = complete.map((index) => index.path).sort()
  }

  for (const { indexes, kind, partition, slug } of indexed.values()) {
    if (kind !== 'versions') continue

    const entry: IndexBackfillReport['versions'][string] = {
      indexed: 0,
      pointers: 0,
      pruned: 0,
      scanned: 0,
    }
    report.versions[slug] = entry
    const expected = new Set<string>()
    const revisions = new Map<string, number | undefined>()
    /** Pointer key → the newest row claiming to be that parent's latest. */
    const latest = new Map<string, { pointer: IndexRow; row: Row }>()

    const rows = await queryMatching(adapter, partition, undefined)
    await mapWithConcurrency(rows, WRITE_CONCURRENCY, async (row) => {
      entry.scanned++
      const owner = String(row['id'])
      revisions.set(owner, revisionOf(row))

      const companions = versionCompanionsFor(adapter, partition, row)
      for (const indexRow of companions.rows) {
        expected.add(keyOf(indexRow))
        await putIndexRow(adapter, indexRow, owner)
        entry.indexed++
      }
      if (companions.pointer) {
        // Rows from before pointers existed can include two "latest" for one
        // parent; the newer one is the one to point at.
        const held = latest.get(companions.pointer.sk)
        if (!held || String(row['createdAt']) > String(held.row['createdAt'])) {
          latest.set(companions.pointer.sk, { pointer: companions.pointer, row })
        }
      }
    })

    await mapWithConcurrency([...latest.values()], WRITE_CONCURRENCY, async ({ pointer, row }) => {
      // Only where there is none: a pointer that exists was put by a live
      // write and is newer than anything this scan saw.
      if (await claimPointer(adapter, pointer, String(row['id']))) entry.pointers++
    })

    for (const index of indexes) {
      if (index.kind === 'rows') {
        entry.pruned += await prune(adapter, index, partition, expected, revisions)
      }
    }

    await markIndexesReady(
      adapter,
      indexes.map((index) => index.partition),
    )
  }

  return report
}

/** @deprecated Use `backfillIndexes`, which also builds index rows. */
export const backfillUniqueGuards = backfillIndexes
