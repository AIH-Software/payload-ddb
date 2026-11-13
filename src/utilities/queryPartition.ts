import { QueryCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from '../types.js'
import type { FilterExpression } from './buildFilterExpression.js'

export type PartitionPage = {
  /** Rows on this page that passed the filter (`Count`). */
  count: number
  /** The rows themselves; empty when `countOnly` is set. */
  items: Record<string, unknown>[]
}

/**
 * Walk one partition (`pk = :partition`) page by page with an optional
 * `FilterExpression`. The single place the adapter issues a `Query`, shared
 * by `queryMatching`, `queryCount` and `findFirst` — each decides what to do
 * with the pages (collect, count, stop at the first hit).
 *
 * Cost note: `FilterExpression` reduces network bytes but not RCU
 * consumption. DynamoDB still reads every row in the partition before
 * filtering. Lookups that can avoid that — by id, unique value or indexed
 * value — never get here; see `indexLookup`.
 *
 * With `countOnly`, `Select: 'COUNT'` keeps DynamoDB from shipping item
 * bytes — only the post-filter `Count` per page comes back over the wire.
 */
export async function* partitionPages(
  adapter: DynamoAdapter,
  partition: string,
  filter: FilterExpression | undefined,
  options: { countOnly?: boolean } = {},
): AsyncGenerator<PartitionPage> {
  const docClient = adapter.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  let exclusiveStartKey: Record<string, unknown> | undefined

  do {
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
        ...(options.countOnly ? { Select: 'COUNT' as const } : {}),
        ...(filter ? { FilterExpression: filter.expression } : {}),
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    )

    yield { count: result.Count ?? 0, items: result.Items ?? [] }
    exclusiveStartKey = result.LastEvaluatedKey
  } while (exclusiveStartKey)
}
