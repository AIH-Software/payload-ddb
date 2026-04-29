import type { CreateGlobalVersion } from 'payload'

import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'

import type { DynamoAdapter } from './types.js'

import { flipPreviousLatest } from './utilities/flipPreviousLatest.js'
import { normalizeForDynamo } from './utilities/normalizeForDynamo.js'

/**
 * Like `createVersion` but for global singletons: there's no `parent`, and
 * the "latest" scope is the entire global's versions partition.
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
  const docClient = this.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  const partition = this.resolveVersionsPartition(globalSlug)

  await flipPreviousLatest(this, partition, { latest: { equals: true } })

  const id = randomUUID()
  const item: Record<string, unknown> = {
    id,
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
