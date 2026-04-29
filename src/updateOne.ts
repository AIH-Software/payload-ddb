import type { UpdateOne } from 'payload'

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from './types.js'

import { findFirst } from './utilities/findFirst.js'
import { normalizeForDynamo } from './utilities/normalizeForDynamo.js'
import { stripInternalKeys } from './utilities/stripInternalKeys.js'

/**
 * v1 strategy: read-merge-write rather than building an `UpdateExpression`.
 * Payload sends a partial `data` patch; DynamoDB `UpdateItem` would let us
 * push the diff server-side, but its expression syntax (reserved words,
 * nested attribute paths, list indexing, removal semantics) is enough work to
 * earn its own milestone. Two round-trips is acceptable for now.
 *
 * `id` on the resulting item always comes from the located target — we don't
 * let `data` rewrite the primary key, which would silently orphan the row.
 */
export const updateOne: UpdateOne = async function updateOne(this: DynamoAdapter, args) {
  const docClient = this.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  const partition = this.resolvePartition(args.collection)

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
    ...args.data,
    id: target['id'],
    // Bump `updatedAt` automatically. Explicit timestamps in `data` (e.g. from
    // version restores or migrations) still win because they land in the
    // spread above and we only override here when `data` didn't supply one.
    updatedAt: args.data['updatedAt'] ?? new Date().toISOString(),
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
