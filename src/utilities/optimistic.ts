import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { APIError } from 'payload'

import type { DynamoAdapter } from '../types.js'

import { stripInternalKeys } from './stripInternalKeys.js'
import { isConditionalCheckFailed } from './writeItems.js'

type Row = Record<string, unknown>

/**
 * Read one row by id with a strongly consistent `GetItem`. The returned
 * object carries its revision (see `stripInternalKeys`), so it can be handed
 * to `putItem` as `replaces`.
 */
export async function getById(
  adapter: DynamoAdapter,
  partition: string,
  id: unknown,
): Promise<null | Row> {
  const docClient = adapter.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: adapter.tableName,
      Key: { pk: partition, sk: String(id) },
      // Strong consistency — Payload assumes read-after-write visibility.
      ConsistentRead: true,
    }),
  )
  return result.Item ? stripInternalKeys(result.Item) : null
}

/** Enough to ride out a burst of writers on one row; beyond it something is wrong. */
export const MAX_WRITE_ATTEMPTS = 10

/**
 * Run a read-merge-write until it lands.
 *
 * `write` merges onto the row it's given and puts the result with
 * `replaces: current`. If another writer got in first, the put's revision
 * check fails; `reread` then fetches the row as it is now and the merge is
 * redone on top of it — so two concurrent patches to different fields both
 * survive, instead of the second silently overwriting the first.
 *
 * `reread` returning `null` means the row is gone or no longer qualifies;
 * the result is then `null` and nothing is written.
 */
export async function writeWithRetry<T>(
  first: null | Row,
  reread: () => Promise<null | Row>,
  write: (current: Row) => Promise<T>,
): Promise<null | T> {
  let current = first

  for (let attempt = 1; current; attempt++) {
    try {
      return await write(current)
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err
      if (attempt >= MAX_WRITE_ATTEMPTS) throw conflictError()
      await backoff(attempt)
      current = await reread()
    }
  }

  return null
}

export function conflictError(): APIError {
  return new APIError(
    `payload-ddb: the document kept changing while it was being written; gave up after ${MAX_WRITE_ATTEMPTS} attempts.`,
    409,
    null,
    true,
  )
}

/** A short random pause so writers that collided don't collide again in step. */
export function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.random() * 5 * attempt))
}
