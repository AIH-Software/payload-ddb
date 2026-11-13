import type { Where } from 'payload'

import type { DynamoAdapter } from '../types.js'

import { buildFilterExpression } from './buildFilterExpression.js'
import { matchesWhere } from './matchesWhere.js'
import { partitionPages } from './queryPartition.js'
import { stripInternalKeys } from './stripInternalKeys.js'

/**
 * Walk a partition, pushing as much of the caller's `where` into
 * `FilterExpression` as DynamoDB can express so non-matching rows are skipped
 * server-side. Returns every matching item materialized in memory — suitable
 * for callers that need the full set (sort, paginate, bulk-mutate).
 *
 * When the pushed-down filter isn't the whole `where` (a JS-only operator
 * such as `like`, or a path through an array), each returned row is
 * re-checked with `matchesWhere`. The expressible clauses still narrow the
 * read, so a `where` that mixes both kinds no longer pulls the entire
 * partition over the wire.
 *
 * Use `findFirst` instead when you only need the first match: that helper
 * stops on the first hit.
 */
export async function queryMatching(
  adapter: DynamoAdapter,
  partition: string,
  where: undefined | Where,
): Promise<Record<string, unknown>[]> {
  const compiled = buildFilterExpression(where)
  // Always-false predicate (e.g. `id: { in: [] }` from access control).
  // Short-circuit so we don't pay for a Query just to return nothing.
  if (compiled.never) return []

  const matched: Record<string, unknown>[] = []
  for await (const page of partitionPages(adapter, partition, compiled.filter)) {
    for (const item of page.items) {
      const row = stripInternalKeys(item)
      if (compiled.exact || matchesWhere(row, where)) matched.push(row)
    }
  }
  return matched
}
