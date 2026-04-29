import type { CreateGlobal } from 'payload'

import { PutCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from './types.js'

import { normalizeForDynamo } from './utilities/normalizeForDynamo.js'

/**
 * Insert a global's singleton row. The slug is forced as the row's `id` —
 * this is what makes `findGlobal`/`updateGlobal` deterministic single-key
 * reads (`pk = slug`, `sk = slug`).
 */
export const createGlobal: CreateGlobal = async function createGlobal(
  this: DynamoAdapter,
  { slug, data, returning },
) {
  const docClient = this.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  const item: Record<string, unknown> = { ...data, id: slug }

  await docClient.send(
    new PutCommand({
      TableName: this.tableName,
      Item: normalizeForDynamo({
        ...item,
        pk: this.resolvePartition(slug),
        sk: slug,
      }),
    }),
  )

  return returning === false ? (null as never) : (item as never)
}
