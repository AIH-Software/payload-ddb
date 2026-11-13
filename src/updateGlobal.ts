import type { UpdateGlobal } from 'payload'

import type { DynamoAdapter } from './types.js'

import { getById, writeWithRetry } from './utilities/optimistic.js'
import { projectForGlobal } from './utilities/resolveSchema.js'
import { putItem } from './utilities/writeItems.js'

/**
 * Read-merge-write for the global's singleton row, retried if the row changes
 * between the read and the write. Per Payload's contract, if the global
 * doesn't exist callers should use `createGlobal` first — we surface the
 * missing case as `null` cast (matching `updateOne`) rather than silently
 * upserting, which would mask programmer errors.
 */
export const updateGlobal: UpdateGlobal = async function updateGlobal(
  this: DynamoAdapter,
  { slug, data, returning },
) {
  const partition = this.resolvePartition(slug)
  const read = () => getById(this, partition, slug)

  const updated = await writeWithRetry(await read(), read, async (existing) => {
    const merged: Record<string, unknown> = { ...existing, ...data, id: slug }
    const projected = projectForGlobal(this, slug, merged)
    await putItem(this, partition, projected, { replaces: existing })
    return projected
  })

  if (!updated || returning === false) {
    return null as never
  }
  return updated as never
}
