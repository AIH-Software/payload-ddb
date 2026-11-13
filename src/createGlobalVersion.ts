import type { CreateGlobalVersion } from 'payload'

import { randomUUID } from 'node:crypto'

import type { DynamoAdapter } from './types.js'

import { backoff, conflictError, MAX_WRITE_ATTEMPTS } from './utilities/optimistic.js'
import { projectVersionSnapshot } from './utilities/resolveSchema.js'
import { findLatestVersion } from './utilities/versionIndex.js'
import { isConditionalCheckFailed, putVersionAsLatest } from './utilities/writeItems.js'

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

  for (let attempt = 1; ; attempt++) {
    // A global has one stream of versions, so one pointer and no parent.
    const { pointer, previous } = await findLatestVersion(this, partition, undefined)
    try {
      await putVersionAsLatest(this, partition, item, previous, pointer)
      break
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err
      if (attempt >= MAX_WRITE_ATTEMPTS) throw conflictError()
      await backoff(attempt)
    }
  }

  return returning === false ? (null as never) : (item as never)
}
