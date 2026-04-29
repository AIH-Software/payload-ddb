import type { CreateVersion } from 'payload'

import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'

import type { DynamoAdapter } from './types.js'

import { flipPreviousLatest } from './utilities/flipPreviousLatest.js'
import { normalizeForDynamo } from './utilities/normalizeForDynamo.js'

/**
 * Insert a new version for a collection's parent doc, maintaining the
 * `latest=true` invariant per parent.
 *
 * Three round-trips: query the partition for the previous latest, put to
 * flip it, put the new row. See `flipPreviousLatest` for the atomicity
 * caveat.
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
  const docClient = this.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  const partition = this.resolveVersionsPartition(collectionSlug)

  await flipPreviousLatest(this, partition, {
    and: [{ parent: { equals: parent } }, { latest: { equals: true } }],
  })

  const id = randomUUID()
  const item: Record<string, unknown> = {
    id,
    parent,
    version: versionData,
    createdAt,
    updatedAt,
    latest: true,
    autosave,
    ...(snapshot ? { snapshot: true } : {}),
    ...(publishedLocale !== undefined ? { publishedLocale } : {}),
  }

  await docClient.send(
    new PutCommand({
      TableName: this.tableName,
      Item: normalizeForDynamo({
        ...item,
        pk: partition,
        sk: id,
      }),
    }),
  )

  return returning === false ? (null as never) : (item as never)
}
