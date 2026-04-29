import type { Find, PaginatedDocs } from 'payload'

import type { DynamoAdapter } from './types.js'

import { applySorts } from './utilities/applySorts.js'
import { queryMatching } from './utilities/queryMatching.js'

/**
 * v2 strategy: paginated `Query` over the collection's partition (`pk = slug`)
 * with `where` translated to `FilterExpression`, then in-memory sort and page
 * slice. `Query` reads only the rows in this collection's partition, so we no
 * longer pay to walk the whole table.
 *
 * Optimizations to land later:
 *  - Use `Query` against a GSI when the predicate matches an indexed key
 *    (e.g. `email` for auth, `slug` for public-facing collections).
 *  - Stream pages instead of materializing all matches when `pagination=false`
 *    and `limit` is small.
 */
export const find: Find = async function find(
  this: DynamoAdapter,
  { collection, limit = 10, page = 1, pagination = true, sort, where },
) {
  const matched = await queryMatching(this, this.resolvePartition(collection), where)
  applySorts(matched, sort)

  const totalDocs = matched.length
  // `limit: 0` disables the cap (Payload convention); pagination flag controls
  // whether we slice at all.
  const useLimit = pagination && limit > 0
  const effectiveLimit = useLimit ? limit : totalDocs
  const totalPages = useLimit ? Math.max(1, Math.ceil(totalDocs / limit)) : 1
  const safePage = useLimit ? Math.max(1, page) : 1

  const start = useLimit ? (safePage - 1) * limit : 0
  const end = useLimit ? start + limit : totalDocs
  const docs = matched.slice(start, end)

  const hasNextPage = useLimit && safePage < totalPages
  const hasPrevPage = useLimit && safePage > 1

  const result: PaginatedDocs<Record<string, unknown>> = {
    docs,
    hasNextPage,
    hasPrevPage,
    limit: effectiveLimit,
    nextPage: hasNextPage ? safePage + 1 : null,
    page: safePage,
    pagingCounter: useLimit ? (safePage - 1) * limit + 1 : 1,
    prevPage: hasPrevPage ? safePage - 1 : null,
    totalDocs,
    totalPages,
  }
  return result as never
}
