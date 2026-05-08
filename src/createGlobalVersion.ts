import type { CreateGlobalVersion } from 'payload'

import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'

import type { DynamoAdapter } from './types.js'

import { findFirst } from './utilities/findFirst.js'
import { normalizeForDynamo } from './utilities/normalizeForDynamo.js'
import { projectVersionSnapshot } from './utilities/resolveSchema.js'

/**
 * Like `createVersion` but for global singletons: there's no `parent`, and
 * the "latest" scope is the entire global's versions partition. Same atomic
 * flip+put via `TransactWriteItems`. See `createVersion` for rationale.
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

  const putItem = normalizeForDynamo({
    ...item,
    pk: partition,
    sk: id,
  })

  const transactItems: NonNullable<
    ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
  > = []

  if (previousLatest) {
    transactItems.push({
      Update: {
        TableName: this.tableName,
        Key: { pk: partition, sk: String(previousLatest['id']) },
        UpdateExpression: 'SET #latest = :false',
        ExpressionAttributeNames: { '#latest': 'latest' },
        ExpressionAttributeValues: { ':false': false },
        ConditionExpression: 'attribute_exists(pk)',
      },
    })
  }

  transactItems.push({
    Put: {
      TableName: this.tableName,
      Item: putItem,
    },
  })

  await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }))

  return returning === false ? (null as never) : (item as never)
}
