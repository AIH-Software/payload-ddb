import type { UpdateJobs } from 'payload'

import type { DynamoAdapter } from './types.js'

import { applySorts } from './utilities/applySorts.js'
import { mapWithConcurrency } from './utilities/mapWithConcurrency.js'
import { matchesWhere } from './utilities/matchesWhere.js'
import { getById, writeWithRetry } from './utilities/optimistic.js'
import { prepareCollectionWhere, prepareSort } from './utilities/prepareWhere.js'
import { queryMatching } from './utilities/queryMatching.js'
import { projectForCollection } from './utilities/resolveSchema.js'
import { putItem, WRITE_CONCURRENCY } from './utilities/writeItems.js'

/** Slug of Payload's jobs collection (core doesn't export the constant). */
const JOBS_COLLECTION = 'payload-jobs'

/**
 * Update rows of Payload's jobs queue (`payload-jobs`).
 *
 * The queue calls this to *claim* work: "set `processing: true` on up to N
 * jobs where `processing` is false". With several workers polling at once,
 * that only stays correct if a job can be claimed once. Each write is
 * therefore conditional on its row being unchanged since it was read; a
 * worker that loses the race re-reads the job, sees it no longer matches
 * `where`, and leaves it out of its result instead of running it a second
 * time. (Core's generic fallback for this method reads and then overwrites,
 * so two workers could both walk away with the same job.)
 *
 * `data` is merged onto each row, with two queue-specific rules taken from
 * Payload's Mongo adapter:
 *  - `log: { $push: entry }` appends to the job's log instead of replacing it;
 *    a non-empty array replaces it; anything else leaves the log alone.
 *  - a missing or `null` `updatedAt` means "now".
 */
export const updateJobs: UpdateJobs = async function updateJobs(
  this: DynamoAdapter,
  { id, data, limit, returning, sort, where: rawWhere },
) {
  const collection = JOBS_COLLECTION
  const partition = this.resolvePartition(collection)
  const byId = id !== undefined && id !== null
  const where = byId ? undefined : await prepareCollectionWhere(this, collection, rawWhere)

  let targets: Record<string, unknown>[]
  if (byId) {
    const job = await getById(this, partition, id)
    targets = job ? [job] : []
  } else {
    const matched = await queryMatching(this, partition, where)
    const defaultSort = this.payload.collections?.[collection]?.config.defaultSort
    applySorts(
      matched,
      prepareSort(this, { kind: 'collection', slug: collection }, sort ?? defaultSort ?? '-createdAt'),
    )
    targets = limit && limit > 0 ? matched.slice(0, limit) : matched
  }

  const updated = await mapWithConcurrency(targets, WRITE_CONCURRENCY, (target) =>
    writeWithRetry(
      target,
      async () => {
        const fresh = await getById(this, partition, target['id'])
        // Someone else changed it out from under us — if it no longer
        // qualifies, it isn't ours to update.
        return fresh && (!where || matchesWhere(fresh, where)) ? fresh : null
      },
      async (current) => {
        const projected = projectForCollection(this, collection, applyJobData(current, data))
        await putItem(this, partition, projected, { replaces: current })
        return projected
      },
    ),
  )

  return returning === false ? null : (updated.filter((job) => job !== null) as never)
}

function applyJobData(
  current: Record<string, unknown>,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const { log, updatedAt, ...rest } = data
  const merged: Record<string, unknown> = {
    ...current,
    ...rest,
    id: current['id'],
    updatedAt: updatedAt ?? new Date().toISOString(),
  }

  if (Array.isArray(log)) {
    if (log.length > 0) merged['log'] = log
  } else if (log && typeof log === 'object' && '$push' in log) {
    const pushed = (log as { $push: unknown }).$push
    merged['log'] = [
      ...(Array.isArray(current['log']) ? current['log'] : []),
      ...(Array.isArray(pushed) ? pushed : [pushed]),
    ]
  }

  return merged
}
