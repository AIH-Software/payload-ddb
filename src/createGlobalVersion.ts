import type { CreateGlobalVersion } from 'payload'

import { randomUUID } from 'node:crypto'

import type { DynamoAdapter } from './types.js'

import { findFirst } from './utilities/findFirst.js'
import { projectVersionSnapshot } from './utilities/resolveSchema.js'
import { putVersionAsLatest } from './utilities/writeItems.js'

/**
 * Like `createVersion` but for global singletons: there's no `parent`, and
 * the "latest" scope is the entire global's versions partition. Same atomic
 * flip+put via `putVersionAsLatest`. See `createVersion` for rationale.
 */
export const createGlobalVersion: CreateGlobalVersion = async function createGlobalVersion(
  this: DynamoAdapter,
  {
    autosave,
    createdAt,
    globalSlug,
    publishedLocale,
    returning,
    snapshot,
    updatedAt,
    versionData,
  },
) {
  const partition = this.resolveVersionsPartition(globalSlug)

  const previousLatest = await findFirst(this, {
    partition,
    where: { latest: { equals: true } },
  })

  const id = randomUUID()
  const sanitizedVersionData = projectVersionSnapshot(
    this,
    { kind: 'global', slug: globalSlug },
    versionData as Record<string, unknown>,
  )
  const item: Record<string, unknown> = {
    id,
    version: sanitizedVersionData,
    createdAt,
    updatedAt,
    latest: true,
    autosave,
    ...(snapshot ? { snapshot: true } : {}),
    ...(publishedLocale !== undefined ? { publishedLocale } : {}),
  }

  await putVersionAsLatest(this, partition, item, previousLatest)

  return returning === false ? (null as never) : (item as never)
}
