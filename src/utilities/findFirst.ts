import type { Where } from 'payload'

import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from '../types.js'

import { buildFilterExpression } from './buildFilterExpression.js'
import { matchesWhere } from './matchesWhere.js'
import { whereHasJsOnlyOperator } from './operators.js'
import { queryMatching } from './queryMatching.js'
import { stripInternalKeys } from './stripInternalKeys.js'
import { whereToId } from './whereToId.js'

/**
 * Locate the first item in a partition matching `where`. Used by `findOne`
 * directly and by `deleteOne`/`updateOne` to capture the doc before mutating.
 *
 * Fast path: if `where` is a pure id-equality, do a single `GetItem` with the
 * full composite key.
 * Slow path: paginate `Query` (scoped by `pk = partition`) with
 * `FilterExpression` pushdown and stop on the first matching row in any page.
 */
export async function findFirst(
  adapter: DynamoAdapter,
  args: { partition: string; where: undefined | Where },
): Promise<null | Record<string, unknown>> {
  const docClient = adapter.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  const { partition } = args
  const id = whereToId(args.where)

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

  // JS-only operator (e.g. `like`) somewhere in `where` — fetch the partition
  // and pick the first JS match. Loses the "stop on first hit per page"
  // optimization but keeps semantics consistent with `queryMatching`.
  if (whereHasJsOnlyOperator(args.where)) {
    const all = await queryMatching(adapter, partition, undefined)
    for (const row of all) {
      if (matchesWhere(row, args.where)) return row
    }
    return null
  }

  const filter = buildFilterExpression(args.where)
  // Always-false predicate (e.g. `in: []`) → no document can match.
  if (filter === null) return null
  let exclusiveStartKey: Record<string, unknown> | undefined

  while (true) {
    const result = await docClient.send(
      new QueryCommand({
        TableName: adapter.tableName,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: {
          '#pk': 'pk',
          ...(filter?.names ?? {}),
        },
        ExpressionAttributeValues: {
          ':pk': partition,
          ...(filter?.values ?? {}),
        },
        ConsistentRead: true,
        ...(filter ? { FilterExpression: filter.expression } : {}),
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    )
    for (const item of result.Items ?? []) {
      return stripInternalKeys(item)
    }
    if (!result.LastEvaluatedKey) {
      return null
    }
    exclusiveStartKey = result.LastEvaluatedKey
  }
}
