import type { UpdateMany } from 'payload'

import type { DynamoAdapter } from './types.js'

import { applySorts } from './utilities/applySorts.js'
import { mapWithConcurrency } from './utilities/mapWithConcurrency.js'
import { matchesWhere } from './utilities/matchesWhere.js'
import { getById, writeWithRetry } from './utilities/optimistic.js'
import { prepareCollectionWhere, prepareSort } from './utilities/prepareWhere.js'
import { queryMatching } from './utilities/queryMatching.js'
import { projectForCollection } from './utilities/resolveSchema.js'
import { rethrowUniqueViolation } from './utilities/writeErrors.js'
import { putItem, WRITE_CONCURRENCY } from './utilities/writeItems.js'

/**
 * v1 strategy: query-and-collect matches, sort, slice to `limit`, then
 * read-merge-write each, at most `WRITE_CONCURRENCY` at a time. Same merge
 * semantics as `updateOne`: `data` is overlaid on the target and `id` is
 * preserved from the target.
 *
 * Each write is conditional on its row being unchanged since it was read. A
 * row that changed underneath is re-read and re-checked against `where`: if
 * it still matches, the patch is re-applied to the fresh row; if it no longer
 * matches (or is gone), it is skipped and left out of the result.
 *
 * `mapWithConcurrency` is order-preserving, so the returned array matches the
 * sorted target order. Bulk DynamoDB transact-writes (`TransactWriteItems`,
 * 100-item / 4 MB cap) are the natural next optimization but require the
 * transaction wiring we deliberately stubbed out for now.
 */
export const updateMany: UpdateMany = async function updateMany(
  this: DynamoAdapter,
  { collection, data, limit, locale, req, returning, sort, where: rawWhere },
) {
  const where = await prepareCollectionWhere(this, collection, rawWhere, locale)
  const partition = this.resolvePartition(collection)
  const matched = await queryMatching(this, partition, where)
  applySorts(matched, prepareSort(this, { kind: 'collection', slug: collection }, sort, locale))

  const targets = limit && limit > 0 ? matched.slice(0, limit) : matched

  // Hoisted so every row in the batch shares one timestamp — keeps audit-style
  // queries deterministic. Explicit `updatedAt` in `data` still wins.
  const updatedAt = data['updatedAt'] ?? new Date().toISOString()

  let updated: (null | Record<string, unknown>)[]
  try {
    updated = await mapWithConcurrency(targets, WRITE_CONCURRENCY, (target) =>
      writeWithRetry(
        target,
        async () => {
          const fresh = await getById(this, partition, target['id'])
          return fresh && matchesWhere(fresh, where) ? fresh : null
        },
        async (current) => {
          const merged: Record<string, unknown> = {
            ...current,
            ...data,
            id: current['id'],
            updatedAt,
          }
          const projected = projectForCollection(this, collection, merged)
          await putItem(this, partition, projected, { replaces: current, unique: { collection } })
          return projected
        },
      ),
    )
  } catch (err) {
    rethrowUniqueViolation(err, collection, req)
    throw err
  }

  return returning === false ? null : updated.filter((doc) => doc !== null)
}
