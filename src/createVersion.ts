import type { CreateVersion } from 'payload'

import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'

import type { DynamoAdapter } from './types.js'

import { findFirst } from './utilities/findFirst.js'
import { normalizeForDynamo } from './utilities/normalizeForDynamo.js'

/**
 * Insert a new version for a collection's parent doc, maintaining the
 * `latest=true` invariant per parent.
 *
 * Two round trips:
 *  1. `Query` the versions partition for the previous `latest=true` row.
 *  2. `TransactWriteItems` to flip that row's `latest` to false and put the
 *     new row in one atomic call. If a crash occurs mid-flow neither
 *     mutation lands, so we never end up with two `latest=true` rows or
 *     zero. The Update carries `attribute_exists(pk)` so the transaction
 *     fails cleanly if the previous row was deleted between (1) and (2).
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

  const previousLatest = await findFirst(this, {
    partition,
    where: { and: [{ parent: { equals: parent } }, { latest: { equals: true } }] },
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
        // Fail the whole transaction if the previous row was deleted between
        // our read and this transaction. Better to error and let the caller
        // retry than to silently leave the new version with a phantom flip.
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
