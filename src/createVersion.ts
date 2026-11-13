import type { CreateVersion } from 'payload'

import { randomUUID } from 'node:crypto'

import type { DynamoAdapter } from './types.js'

import { backoff, conflictError, MAX_WRITE_ATTEMPTS } from './utilities/optimistic.js'
import { projectVersionSnapshot } from './utilities/resolveSchema.js'
import { findLatestVersion } from './utilities/versionIndex.js'
import { isConditionalCheckFailed, putVersionAsLatest } from './utilities/writeItems.js'

/**
 * Insert a new version for a collection's parent doc, maintaining the
 * `latest=true` invariant per parent.
 *
 * Two steps:
 *  1. Find the previous `latest=true` row — through the parent's pointer
 *     (two key reads), or by reading the versions partition while pointers
 *     aren't complete yet (`findLatestVersion`).
 *  2. `putVersionAsLatest` flips that row's `latest` to false, puts the new
 *     row and moves the pointer in one atomic `TransactWriteItems` call. If
 *     a crash occurs mid-flow none of it lands, so we never end up with two
 *     `latest=true` rows or zero.
 *
 * If another save of the same document got in between the two steps, the
 * transaction's conditions fail and both steps are repeated.
 *
 * `autosave` is persisted on the row even though it isn't surfaced in
 * `TypeWithVersion` — `findVersions` filters by it.
 */
export const createVersion: CreateVersion = async function createVersion(
  this: DynamoAdapter,
  {
    autosave,
    collectionSlug,
    createdAt,
    parent,
    publishedLocale,
    returning,
    snapshot,
    updatedAt,
    versionData,
  },
) {
  const partition = this.resolveVersionsPartition(collectionSlug)

  const id = randomUUID()
  // Project the snapshot against the parent collection's schema so that any
  // unknown keys (e.g. registration-form `confirm-password`) don't ride into
  // the version row alongside the legitimate doc state.
  const sanitizedVersionData = projectVersionSnapshot(
    this,
    { kind: 'collection', slug: collectionSlug },
    versionData as Record<string, unknown>,
  )
  const item: Record<string, unknown> = {
    id,
    parent,
    version: sanitizedVersionData,
    createdAt,
    updatedAt,
    latest: true,
    autosave,
    ...(snapshot ? { snapshot: true } : {}),
    ...(publishedLocale !== undefined ? { publishedLocale } : {}),
  }

  for (let attempt = 1; ; attempt++) {
    const { pointer, previous } = await findLatestVersion(this, partition, parent)
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
