import type { Where } from 'payload'

import type { DynamoAdapter } from '../types.js'

import { findFirst } from './findFirst.js'
import { getById, writeWithRetry } from './optimistic.js'
import { prepareVersionsWhere } from './prepareWhere.js'
import { projectVersionRow } from './resolveSchema.js'
import { putItem } from './writeItems.js'

/**
 * The shared body of `updateVersion` and `updateGlobalVersion`: locate one
 * version row (by id, else by `where`), overlay `versionData`, and write it
 * back — conditional on the row being unchanged since it was read, and
 * retried on the fresh row when it wasn't.
 */
export async function updateVersionRow(
  adapter: DynamoAdapter,
  parent: { kind: 'collection' | 'global'; slug: string },
  args: {
    id?: number | string
    locale?: string
    returning?: boolean
    versionData: Record<string, unknown>
    where?: Where
  },
): Promise<null | Record<string, unknown>> {
  const partition = adapter.resolveVersionsPartition(parent.slug)

  const byId = args.id !== undefined && args.id !== null
  const where = byId
    ? undefined
    : await prepareVersionsWhere(adapter, parent, args.where, args.locale)
  const read = () => {
    if (byId) return getById(adapter, partition, args.id)
    return where ? findFirst(adapter, { partition, where }) : Promise.resolve(null)
  }

  const updated = await writeWithRetry(await read(), read, async (target) => {
    const merged: Record<string, unknown> = {
      ...target,
      ...args.versionData,
      id: target['id'],
    }
    // Project both the version-row metadata layer and the inner `version`
    // snapshot. Catches stray keys at either layer plus stale leaks already
    // persisted on the target.
    const projected = projectVersionRow(adapter, parent, merged)
    await putItem(adapter, partition, projected, { replaces: target })
    return projected
  })

  return args.returning === false ? null : updated
}
