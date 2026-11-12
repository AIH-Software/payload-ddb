import type { UpdateMany } from 'payload'

import type { DynamoAdapter } from './types.js'

import { applySorts } from './utilities/applySorts.js'
import { queryMatching } from './utilities/queryMatching.js'
import { projectForCollection } from './utilities/resolveSchema.js'
import { putItem } from './utilities/writeItems.js'

/**
 * v1 strategy: query-and-collect matches, sort, slice to `limit`, then
 * read-merge-write each in parallel. Same merge semantics as `updateOne`:
 * `data` is overlaid on the target and `id` is preserved from the target.
 *
 * `Promise.all` is order-preserving, so the returned array matches the
 * sorted target order. Bulk DynamoDB transact-writes (`TransactWriteItems`,
 * 100-item / 4 MB cap) are the natural next optimization but require the
 * transaction wiring we deliberately stubbed out for now.
 */
export const updateMany: UpdateMany = async function updateMany(
  this: DynamoAdapter,
  { collection, data, limit, returning, sort, where },
) {
  const partition = this.resolvePartition(collection)
  const matched = await queryMatching(this, partition, where)
  applySorts(matched, sort)

  const targets = limit && limit > 0 ? matched.slice(0, limit) : matched

  // Hoisted so every row in the batch shares one timestamp — keeps audit-style
  // queries deterministic. Explicit `updatedAt` in `data` still wins.
  const updatedAt = data['updatedAt'] ?? new Date().toISOString()

  const updated = await Promise.all(
    targets.map(async (target) => {
      const merged: Record<string, unknown> = {
        ...target,
        ...data,
        id: target['id'],
        updatedAt,
      }
      const projected = projectForCollection(this, collection, merged)
      await putItem(this, partition, projected)
      return projected
    }),
  )

  return returning === false ? null : updated
}
