import { BatchGetCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from '../types.js'

import { mapWithConcurrency } from './mapWithConcurrency.js'

export type RowKey = { pk: string; sk: string }

/** `BatchGetItem` takes at most 100 keys per call. */
const BATCH_SIZE = 100
/** Batches in flight at once — each can return up to 16 MB. */
const BATCH_CONCURRENCY = 4
const MAX_ATTEMPTS = 8

/**
 * Read rows by their full keys with strongly consistent `BatchGetItem`s.
 * Keys that don't exist are simply absent from the result, and the order of
 * the result is unspecified.
 *
 * DynamoDB may hand part of a batch back as "unprocessed" (throttling, or a
 * response over 16 MB); those keys are retried with a short backoff.
 */
export async function batchGet(
  adapter: DynamoAdapter,
  keys: RowKey[],
): Promise<Record<string, unknown>[]> {
  const docClient = adapter.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  // `BatchGetItem` rejects a request that names the same key twice.
  const unique = [...new Map(keys.map((key) => [`${key.pk}\u0000${key.sk}`, key])).values()]
  const batches: RowKey[][] = []
  for (let start = 0; start < unique.length; start += BATCH_SIZE) {
    batches.push(unique.slice(start, start + BATCH_SIZE))
  }

  const pages = await mapWithConcurrency(batches, BATCH_CONCURRENCY, async (batch) => {
    const found: Record<string, unknown>[] = []
    let pending: Record<string, unknown>[] = batch

    for (let attempt = 1; pending.length > 0; attempt++) {
      const result = await docClient.send(
        new BatchGetCommand({
          RequestItems: {
            // Strong consistency — same stance as every other read here.
            [adapter.tableName]: { ConsistentRead: true, Keys: pending },
          },
        }),
      )
      found.push(...(result.Responses?.[adapter.tableName] ?? []))
      pending = result.UnprocessedKeys?.[adapter.tableName]?.Keys ?? []

      if (pending.length > 0) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new Error(
            `payload-ddb: DynamoDB left ${pending.length} keys of a batch read unprocessed after ${MAX_ATTEMPTS} attempts.`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt * Math.random()))
      }
    }
    return found
  })

  return pages.flat()
}
