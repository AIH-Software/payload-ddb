import type { Create } from 'payload'

import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'

import type { DynamoAdapter } from './types.js'

import { normalizeForDynamo } from './utilities/normalizeForDynamo.js'

export const create: Create = async function create(
  this: DynamoAdapter,
  { collection, customID, data, returning },
) {
  const docClient = this.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  const id = customID ?? data['id'] ?? randomUUID()
  const now = new Date().toISOString()
  // Defaults below `data` so explicit timestamps in `data` win — Payload's
  // versions/restore flows pass them through, and migrations may want to
  // backdate. `id` is last to resolve any clash between `customID` and
  // `data.id`.
  const item: Record<string, unknown> = {
    createdAt: now,
    updatedAt: now,
    ...data,
    id,
  }

  await docClient.send(
    new PutCommand({
      TableName: this.tableName,
      Item: normalizeForDynamo({
        ...item,
        pk: this.resolvePartition(collection),
        sk: String(id),
      }),
    }),
  )

  return returning === false ? (null as never) : item
}
