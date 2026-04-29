import type { Upsert } from 'payload'

import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'

import type { DynamoAdapter } from './types.js'

import { findFirst } from './utilities/findFirst.js'
import { normalizeForDynamo } from './utilities/normalizeForDynamo.js'

/**
 * Locate by `where`; merge-and-put if found, put-with-fresh-id otherwise.
 *
 * Inlined rather than dispatching to `create`/`updateOne` via `.call(this)` —
 * piping through their `this`-typed signatures requires casts that obscure
 * the small amount of logic this function actually owns.
 */
export const upsert: Upsert = async function upsert(
  this: DynamoAdapter,
  { collection, data, returning, where },
) {
  const docClient = this.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  const partition = this.resolvePartition(collection)
  const found = await findFirst(this, { partition, where })

  const now = new Date().toISOString()
  let item: Record<string, unknown>
  if (found) {
    // Bump `updatedAt` automatically; explicit value in `data` still wins.
    item = {
      ...found,
      ...data,
      id: found['id'],
      updatedAt: data['updatedAt'] ?? now,
    }
  } else {
    const id = data['id'] ?? randomUUID()
    // Default both timestamps; `data` overrides if present (matches `create`).
    item = {
      createdAt: now,
      updatedAt: now,
      ...data,
      id,
    }
  }

  await docClient.send(
    new PutCommand({
      TableName: this.tableName,
      Item: normalizeForDynamo({
        ...item,
        pk: partition,
        sk: String(item['id']),
      }),
    }),
  )

  return returning === false ? (null as never) : (item as never)
}
