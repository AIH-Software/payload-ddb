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
  // Spread `data` first, then nullish-coalesce timestamps. Explicit values
  // in `data` (versions/restore, migrations backdating) still win, but a
  // payload-passed `data.createdAt = undefined` no longer wipes the default
  // back to undefined — which the marshaller would then drop with
  // `removeUndefinedValues: true`, leaving the row without timestamps.
  const item: Record<string, unknown> = {
    ...data,
    id,
    createdAt: data['createdAt'] ?? now,
    updatedAt: data['updatedAt'] ?? now,
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
