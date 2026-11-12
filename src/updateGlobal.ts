import type { UpdateGlobal } from 'payload'

import { GetCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from './types.js'

import { projectForGlobal } from './utilities/resolveSchema.js'
import { stripInternalKeys } from './utilities/stripInternalKeys.js'
import { putItem } from './utilities/writeItems.js'

/**
 * Read-merge-write for the global's singleton row. Per Payload's contract,
 * if the global doesn't exist callers should use `createGlobal` first — we
 * surface the missing case as `null` cast (matching `updateOne`) rather than
 * silently upserting, which would mask programmer errors.
 */
export const updateGlobal: UpdateGlobal = async function updateGlobal(
  this: DynamoAdapter,
  { slug, data, returning },
) {
  const docClient = this.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  const partition = this.resolvePartition(slug)

  const result = await docClient.send(
    new GetCommand({
      TableName: this.tableName,
      Key: { pk: partition, sk: slug },
      ConsistentRead: true,
    }),
  )

  if (!result.Item) {
    return null as never
  }

  const existing = stripInternalKeys(result.Item)
  const merged: Record<string, unknown> = { ...existing, ...data, id: slug }
  const projected = projectForGlobal(this, slug, merged)

  await putItem(this, partition, projected)

  return returning === false ? (null as never) : (projected as never)
}
