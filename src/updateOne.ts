import type { UpdateOne } from 'payload'

import type { DynamoAdapter } from './types.js'

import { findFirst } from './utilities/findFirst.js'
import { getById, writeWithRetry } from './utilities/optimistic.js'
import { prepareCollectionWhere } from './utilities/prepareWhere.js'
import { projectForCollection } from './utilities/resolveSchema.js'
import { rethrowUniqueViolation } from './utilities/writeErrors.js'
import { putItem } from './utilities/writeItems.js'

/**
 * v1 strategy: read-merge-write rather than building an `UpdateExpression`.
 * Payload sends a partial `data` patch; DynamoDB `UpdateItem` would let us
 * push the diff server-side, but its expression syntax (reserved words,
 * nested attribute paths, list indexing, removal semantics) is enough work to
 * earn its own milestone.
 *
 * The write is conditional on the row still being at the revision that was
 * read. If another writer got in first, the patch is re-applied to the fresh
 * row (`writeWithRetry`), so concurrent updates to different fields both
 * land.
 *
 * `id` on the resulting item always comes from the located target — we don't
 * let `data` rewrite the primary key, which would silently orphan the row.
 */
export const updateOne: UpdateOne = async function updateOne(this: DynamoAdapter, args) {
  const { collection, data } = args
  const partition = this.resolvePartition(collection)

  const byId = args.id !== undefined && args.id !== null
  const where = byId
    ? undefined
    : await prepareCollectionWhere(this, collection, args.where, args.locale)
  const read = () => {
    if (byId) return getById(this, partition, args.id)
    return where ? findFirst(this, { partition, where }) : Promise.resolve(null)
  }

  let updated: null | Record<string, unknown>
  try {
    updated = await writeWithRetry(await read(), read, async (target) => {
      const merged: Record<string, unknown> = {
        ...target,
        ...data,
        id: target['id'],
        // Bump `updatedAt` automatically. Explicit timestamps in `data` (e.g.
        // from version restores or migrations) still win because they land in
        // the spread above and we only override here when `data` didn't
        // supply one.
        updatedAt: data['updatedAt'] ?? new Date().toISOString(),
      }
      // Strip the merged result against the collection schema. Catches both
      // unknown keys in the incoming patch and any pre-existing leaked keys
      // on the persisted target — every update doubles as incremental cleanup.
      const projected = projectForCollection(this, collection, merged)
      await putItem(this, partition, projected, { collection, replaces: target })
      return projected
    })
  } catch (err) {
    rethrowUniqueViolation(err, collection, args.req)
    throw err
  }

  if (!updated || args.returning === false) {
    return null as never
  }
  return updated as never
}
