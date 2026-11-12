import type { CreateGlobal } from 'payload'

import type { DynamoAdapter } from './types.js'

import { projectForGlobal } from './utilities/resolveSchema.js'
import { putItem } from './utilities/writeItems.js'

/**
 * Insert a global's singleton row. The slug is forced as the row's `id` —
 * this is what makes `findGlobal`/`updateGlobal` deterministic single-key
 * reads (`pk = slug`, `sk = slug`).
 */
export const createGlobal: CreateGlobal = async function createGlobal(
  this: DynamoAdapter,
  { slug, data, returning },
) {
  const item: Record<string, unknown> = { ...data, id: slug }
  const projected = projectForGlobal(this, slug, item)

  await putItem(this, this.resolvePartition(slug), projected)

  return returning === false ? (null as never) : (projected as never)
}
