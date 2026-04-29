import type { Where } from 'payload'

import { QueryCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from '../types.js'

import { buildFilterExpression } from './buildFilterExpression.js'
import { matchesWhere } from './matchesWhere.js'
import { whereHasJsOnlyOperator } from './operators.js'
import { stripInternalKeys } from './stripInternalKeys.js'

/**
 * Walk a partition via paginated `Query` (`pk = :partition`), pushing the
 * caller's `where` into `FilterExpression` so non-matching rows are skipped
 * server-side. Returns every matching item materialized in memory — suitable
 * for callers that need the full set (sort, paginate, bulk-mutate).
 *
 * Use `findFirst` instead when you only need the first match: that helper
 * stops on the first hit.
 *
 * Cost note: `FilterExpression` reduces network bytes but not RCU
 * consumption. DynamoDB still reads every row in the partition before
 * filtering. The next meaningful optimization is GSIs that mirror specific
 * access patterns (e.g. `email` for auth, `slug` for public collections).
 */
export async function queryMatching(
  adapter: DynamoAdapter,
  partition: string,
  where: undefined | Where,
): Promise<Record<string, unknown>[]> {
  const docClient = adapter.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  // When `where` uses an operator we can't faithfully push down (today: `like`,
  // because Payload's contract is case-insensitive while DynamoDB's
  // `contains()` isn't), we fetch the whole partition and evaluate in JS.
  // Recurse with `where = undefined` to reuse the standard pagination loop.
  if (whereHasJsOnlyOperator(where)) {
    const all = await queryMatching(adapter, partition, undefined)
    return all.filter((row) => matchesWhere(row, where))
  }

  const filter = buildFilterExpression(where)
  // `null` signals an always-false predicate (e.g. `id: { in: [] }` from
  // access control). Short-circuit so we don't pay for a Query just to
  // return nothing.
  if (filter === null) return []
  const matched: Record<string, unknown>[] = []
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
        // Strong consistency by default — Payload assumes read-after-write
        // visibility (Mongo/Postgres do), and DynamoDB's default eventual
        // consistency breaks "create-then-list" flows. 2x RCU but correct.
        ConsistentRead: true,
        ...(filter ? { FilterExpression: filter.expression } : {}),
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    )
    for (const item of result.Items ?? []) {
      matched.push(stripInternalKeys(item))
    }
    if (!result.LastEvaluatedKey) break
    exclusiveStartKey = result.LastEvaluatedKey
  }

  return matched
}
