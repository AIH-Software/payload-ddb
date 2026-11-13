import type { Where } from 'payload'

import { GetCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from '../types.js'

import { buildFilterExpression } from './buildFilterExpression.js'
import { matchesWhere } from './matchesWhere.js'
import { partitionPages } from './queryPartition.js'
import { stripInternalKeys } from './stripInternalKeys.js'
import { whereToId } from './whereToId.js'

/**
 * Locate the first item in a partition matching `where`. Used by `findOne`
 * directly and by `deleteOne`/`updateOne` to capture the doc before mutating.
 *
 * Fast path: if `where` is a pure id-equality, do a single `GetItem` with the
 * full composite key.
 * Slow path: walk the partition with as much of `where` pushed down as
 * DynamoDB can express, re-check rows with `matchesWhere` when that pushdown
 * is inexact, and stop on the first match in any page.
 */
export async function findFirst(
  adapter: DynamoAdapter,
  args: { partition: string; where: undefined | Where },
): Promise<null | Record<string, unknown>> {
  const docClient = adapter.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  const { partition, where } = args
  const id = whereToId(where)

  if (id !== null) {
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

  const compiled = buildFilterExpression(where)
  // Always-false predicate (e.g. `in: []`) → no document can match.
  if (compiled.never) return null

  for await (const page of partitionPages(adapter, partition, compiled.filter)) {
    for (const item of page.items) {
      const row = stripInternalKeys(item)
      if (compiled.exact || matchesWhere(row, where)) return row
    }
  }
  return null
}
