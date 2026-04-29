import type { Where } from 'payload'

import { PutCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from '../types.js'

import { findFirst } from './findFirst.js'
import { normalizeForDynamo } from './normalizeForDynamo.js'

/**
 * Locate the row matching `match` in the given partition (typically the
 * current `latest=true` row for some scope) and put it back with
 * `latest: false`. Used by `createVersion` and `createGlobalVersion` to
 * maintain the invariant that exactly one version per scope carries
 * `latest=true`.
 *
 * Not atomic with the subsequent insert. A `TransactWriteItems` rewrite is
 * the natural follow-up once the transaction methods are wired.
 */
export async function flipPreviousLatest(
  adapter: DynamoAdapter,
  partition: string,
  match: Where,
): Promise<void> {
  const previous = await findFirst(adapter, { partition, where: match })
  if (!previous) return

  const docClient = adapter.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  await docClient.send(
    new PutCommand({
      TableName: adapter.tableName,
      Item: normalizeForDynamo({
        ...previous,
        pk: partition,
        sk: String(previous['id']),
        latest: false,
      }),
    }),
  )
}
