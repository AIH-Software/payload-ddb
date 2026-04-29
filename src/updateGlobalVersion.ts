import type { UpdateGlobalVersion } from 'payload'

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from './types.js'

import { findFirst } from './utilities/findFirst.js'
import { normalizeForDynamo } from './utilities/normalizeForDynamo.js'
import { stripInternalKeys } from './utilities/stripInternalKeys.js'

/**
 * Same read-merge-write semantics as `updateVersion`. Doesn't cascade
 * `latest` flips for the same reason: Payload owns that contract by issuing
 * paired updates.
 */
export const updateGlobalVersion: UpdateGlobalVersion = async function updateGlobalVersion(
  this: DynamoAdapter,
  args,
) {
  const docClient = this.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  const partition = this.resolveVersionsPartition(args.global)

  let target: null | Record<string, unknown> = null

  if (args.id !== undefined && args.id !== null) {
    const result = await docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: partition, sk: String(args.id) },
        ConsistentRead: true,
      }),
    )
    target = result.Item ? stripInternalKeys(result.Item) : null
  } else if (args.where) {
    target = await findFirst(this, { partition, where: args.where })
  }

  if (!target) {
    return null as never
  }

  const merged: Record<string, unknown> = {
    ...target,
    ...args.versionData,
    id: target['id'],
  }

  await docClient.send(
    new PutCommand({
      TableName: this.tableName,
      Item: normalizeForDynamo({
        ...merged,
        pk: partition,
        sk: String(merged['id']),
      }),
    }),
  )

  if (args.returning === false) {
    return null as never
  }
  return merged as never
}
