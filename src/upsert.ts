import type { Upsert } from 'payload'

import { PutCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'

import type { DynamoAdapter } from './types.js'

import { findFirst } from './utilities/findFirst.js'
import { normalizeForDynamo } from './utilities/normalizeForDynamo.js'
import { projectForCollection } from './utilities/resolveSchema.js'

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
    // Same nullish-coalesce pattern as `create`: explicit values in `data`
    // win, but a payload-passed `undefined` doesn't wipe the default.
    item = {
      ...data,
      id,
      createdAt: data['createdAt'] ?? now,
      updatedAt: data['updatedAt'] ?? now,
    }
  }

  const projected = projectForCollection(this, collection, item)

  await docClient.send(
    new PutCommand({
      TableName: this.tableName,
      Item: normalizeForDynamo({
        ...projected,
        pk: partition,
        sk: String(projected['id']),
      }),
    }),
  )

  return returning === false ? (null as never) : (projected as never)
}
