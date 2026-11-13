import type { Payload } from 'payload'

import type { DynamoAdapter } from '../types.js'

import { indexedCollections, indexRowsFor } from './fieldIndexes.js'
import { markIndexesReady } from './indexState.js'
import { mapWithConcurrency } from './mapWithConcurrency.js'
import { queryMatching } from './queryMatching.js'
import { hasUniqueFields, uniqueGuardsFor } from './uniqueGuards.js'
import { claimGuard, putIndexRow, WRITE_CONCURRENCY } from './writeItems.js'

/**
 * One-shot pass that builds unique guards and index rows for documents
 * written before the adapter kept them, then marks each index as complete
 * so lookups start using it.
 *
 * Both kinds of row are written with every document, so a document that
 * hasn't been saved since upgrading has neither. Until this runs:
 *
 *  - a new document could take a unique value such a document already holds;
 *  - lookups by a `unique: true` or `index: true` field keep reading the
 *    whole collection, because an index that misses documents can't be
 *    trusted (see `indexState`).
 *
 * The pass walks every collection that has unique or indexed fields. It is
 * safe to re-run, and safe to run while the application is serving: writes
 * keep their own rows current, and a row this pass writes for a value that
 * has just changed is only a stray that lookups ignore.
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
      /** Stored paths of the indexes that are now complete and in use. */
      ready: string[]
      scanned: number
    }
  >
}

/** @deprecated Use `IndexBackfillReport`. */
export type UniqueBackfillReport = IndexBackfillReport

export async function backfillIndexes(payload: Payload): Promise<IndexBackfillReport> {
  const adapter = payload.db as DynamoAdapter
  if (!adapter.docClient) {
    throw new Error('payload-ddb: backfillIndexes requires a connected adapter.')
  }

  const report: IndexBackfillReport = { collections: {} }
  const indexed = new Map(indexedCollections(adapter).map((entry) => [entry.slug, entry.indexes]))

  for (const slug of Object.keys(adapter.payload?.collections ?? {})) {
    const indexes = indexed.get(slug) ?? []
    if (!hasUniqueFields(adapter, slug) && indexes.length === 0) continue

    const partition = adapter.resolvePartition(slug)
    const entry: IndexBackfillReport['collections'][string] = {
      conflicts: [],
      guarded: 0,
      indexed: 0,
      ready: [],
      scanned: 0,
    }
    report.collections[slug] = entry
    /** Guard partitions where some document couldn't claim its value. */
    const contested = new Set<string>()

    const rows = await queryMatching(adapter, partition, undefined)
    await mapWithConcurrency(rows, WRITE_CONCURRENCY, async (row) => {
      entry.scanned++
      const owner = String(row['id'])

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
        await putIndexRow(adapter, indexRow, owner)
        entry.indexed++
      }
    })

    const complete = indexes.filter((index) => !contested.has(index.partition))
    await markIndexesReady(
      adapter,
      complete.map((index) => index.partition),
    )
    entry.ready = complete.map((index) => index.path).sort()
  }

  return report
}

/** @deprecated Use `backfillIndexes`, which also builds index rows. */
export const backfillUniqueGuards = backfillIndexes
