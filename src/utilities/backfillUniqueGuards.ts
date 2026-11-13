import type { Payload } from 'payload'

import type { DynamoAdapter } from '../types.js'

import { mapWithConcurrency } from './mapWithConcurrency.js'
import { queryMatching } from './queryMatching.js'
import { hasUniqueFields, uniqueGuardsFor } from './uniqueGuards.js'
import { claimGuard, WRITE_CONCURRENCY } from './writeItems.js'

/**
 * One-shot pass that creates unique-field guard rows for documents written
 * before the adapter enforced `unique: true`.
 *
 * Guards are created as documents are written, so a document that hasn't
 * been touched since upgrading holds its unique values without a guard — a
 * new document could still take the same value. Running this once closes
 * that gap: it walks every collection that declares unique fields and claims
 * a guard for each value each document holds.
 *
 * Safe to re-run; claiming a guard the document already owns is a no-op.
 *
 * Existing duplicates can't both be guarded. The first document reached
 * keeps the value and the others are listed under `conflicts` — fix those by
 * hand (change or clear the duplicated value) and run the pass again.
 *
 * @example
 *   import { getPayload } from 'payload'
 *   import config from './payload.config'
 *   import { backfillUniqueGuards } from '@aih-software/payload-ddb'
 *
 *   const payload = await getPayload({ config })
 *   const report = await backfillUniqueGuards(payload)
 *   console.log(JSON.stringify(report, null, 2))
 *   await payload.destroy()
 */
export interface UniqueBackfillReport {
  collections: Record<
    string,
    {
      /** Values another document already holds a guard for. */
      conflicts: { heldBy: string; id: unknown; path: string }[]
      /** Guards this pass created or confirmed. */
      guarded: number
      scanned: number
    }
  >
}

export async function backfillUniqueGuards(payload: Payload): Promise<UniqueBackfillReport> {
  const adapter = payload.db as DynamoAdapter
  if (!adapter.docClient) {
    throw new Error('payload-ddb: backfillUniqueGuards requires a connected adapter.')
  }

  const report: UniqueBackfillReport = { collections: {} }

  for (const slug of Object.keys(adapter.payload?.collections ?? {})) {
    if (!hasUniqueFields(adapter, slug)) continue

    const partition = adapter.resolvePartition(slug)
    const entry: UniqueBackfillReport['collections'][string] = {
      conflicts: [],
      guarded: 0,
      scanned: 0,
    }
    report.collections[slug] = entry

    const rows = await queryMatching(adapter, partition, undefined)
    await mapWithConcurrency(rows, WRITE_CONCURRENCY, async (row) => {
      entry.scanned++
      for (const guard of uniqueGuardsFor(adapter, slug, partition, row)) {
        const heldBy = await claimGuard(adapter, guard, String(row['id']))
        if (heldBy === null) entry.guarded++
        else entry.conflicts.push({ heldBy, id: row['id'], path: guard.path })
      }
    })
  }

  return report
}
