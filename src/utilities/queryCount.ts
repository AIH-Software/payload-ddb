import type { Where } from 'payload'

import { QueryCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from '../types.js'

import { buildFilterExpression } from './buildFilterExpression.js'
import { whereHasJsOnlyOperator } from './operators.js'
import { queryMatching } from './queryMatching.js'

/**
 * Paginated count over a single partition with optional `FilterExpression`
 * pushdown. Uses `Select: 'COUNT'` so DynamoDB doesn't ship item bytes —
 * only the post-filter `Count` per page comes back over the wire.
 */
export async function queryCount(
  adapter: DynamoAdapter,
  partition: string,
  where: undefined | Where,
): Promise<number> {
  const docClient = adapter.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  // JS-only operators (e.g. `like`) can't be expressed in `FilterExpression`,
  // so the only correct count is "fetch and count the matches in memory".
  // Loses the `Select: 'COUNT'` byte-savings but keeps semantics consistent
  // with `queryMatching`.
  if (whereHasJsOnlyOperator(where)) {
    const matched = await queryMatching(adapter, partition, where)
    return matched.length
  }

  const filter = buildFilterExpression(where)
  // Always-false predicate (e.g. `in: []`) → zero rows without a round-trip.
  if (filter === null) return 0
  let totalDocs = 0
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
        // Strong consistency — see `queryMatching` for rationale.
        ConsistentRead: true,
        Select: 'COUNT',
        ...(filter ? { FilterExpression: filter.expression } : {}),
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    )

    totalDocs += result.Count ?? 0

    if (!result.LastEvaluatedKey) break
    exclusiveStartKey = result.LastEvaluatedKey
  }

  return totalDocs
}
