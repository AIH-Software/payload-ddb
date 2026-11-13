import type { Where } from 'payload'

import type { DynamoAdapter } from '../types.js'

import { buildFilterExpression } from './buildFilterExpression.js'
import { findByIndex } from './indexLookup.js'
import { matchesWhere } from './matchesWhere.js'
import { partitionPages } from './queryPartition.js'
import { stripInternalKeys } from './stripInternalKeys.js'

/**
 * Every row of a partition that matches `where`, materialized in memory —
 * suitable for callers that need the full set (sort, paginate, bulk-mutate).
 *
 * When a clause pins the rows down by key — an id, a unique value, an
 * indexed value — they are read by key (`findByIndex`). Otherwise the
 * partition is walked, pushing as much of `where` into `FilterExpression` as
 * DynamoDB can express so non-matching rows are skipped server-side.
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
  /** `skipIndex`: the caller already tried `findByIndex` and it passed. */
  options: { skipIndex?: boolean } = {},
): Promise<Record<string, unknown>[]> {
  const compiled = buildFilterExpression(where)
  // Always-false predicate (e.g. `id: { in: [] }` from access control).
  // Short-circuit so we don't pay for a Query just to return nothing.
  if (compiled.never) return []

  const viaIndex = options.skipIndex ? null : await findByIndex(adapter, partition, where)
  if (viaIndex) return viaIndex

  const matched: Record<string, unknown>[] = []
  for await (const page of partitionPages(adapter, partition, compiled.filter)) {
    for (const item of page.items) {
      const row = stripInternalKeys(item)
      if (compiled.exact || matchesWhere(row, where)) matched.push(row)
    }
  }
  return matched
}
