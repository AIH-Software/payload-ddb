import type { CreateVersion } from 'payload'

import { randomUUID } from 'node:crypto'

import type { DynamoAdapter } from './types.js'

import { findFirst } from './utilities/findFirst.js'
import { projectVersionSnapshot } from './utilities/resolveSchema.js'
import { putVersionAsLatest } from './utilities/writeItems.js'

/**
 * Insert a new version for a collection's parent doc, maintaining the
 * `latest=true` invariant per parent.
 *
 * Two round trips:
 *  1. `Query` the versions partition for the previous `latest=true` row.
 *  2. `putVersionAsLatest` flips that row's `latest` to false and puts the
 *     new row in one atomic `TransactWriteItems` call. If a crash occurs
 *     mid-flow neither mutation lands, so we never end up with two
 *     `latest=true` rows or zero. The flip carries `attribute_exists(pk)` so
 *     the transaction fails cleanly if the previous row was deleted between
 *     (1) and (2).
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

  const previousLatest = await findFirst(this, {
    partition,
    where: { and: [{ parent: { equals: parent } }, { latest: { equals: true } }] },
  })

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

  await putVersionAsLatest(this, partition, item, previousLatest)

  return returning === false ? (null as never) : (item as never)
}
