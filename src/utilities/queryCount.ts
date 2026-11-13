import type { Where } from 'payload'

import type { DynamoAdapter } from '../types.js'

import { buildFilterExpression } from './buildFilterExpression.js'
import { queryMatching } from './queryMatching.js'
import { partitionPages } from './queryPartition.js'

/**
 * Count the rows of a partition matching `where`.
 *
 * When the whole `where` can be pushed down, DynamoDB does the counting
 * (`Select: 'COUNT'`) and no item bytes cross the wire. Otherwise the only
 * correct count is "fetch the candidates and count the ones `matchesWhere`
 * accepts" — which is exactly what `queryMatching` does.
 */
export async function queryCount(
  adapter: DynamoAdapter,
  partition: string,
  where: undefined | Where,
): Promise<number> {
  const compiled = buildFilterExpression(where)
  // Always-false predicate (e.g. `in: []`) → zero rows without a round-trip.
  if (compiled.never) return 0

  if (!compiled.exact) {
    return (await queryMatching(adapter, partition, where)).length
  }

  let totalDocs = 0
  for await (const page of partitionPages(adapter, partition, compiled.filter, {
    countOnly: true,
  })) {
    totalDocs += page.count
  }
  return totalDocs
}
