import type { Find, PaginatedDocs } from 'payload'

import type { DynamoAdapter } from './types.js'

import { applySorts } from './utilities/applySorts.js'
import { collectionHasDrafts, fetchDraftsOnlySupplements } from './utilities/draftsFallback.js'
import { queryMatching } from './utilities/queryMatching.js'

/**
 * v2 strategy: paginated `Query` over the collection's partition (`pk = slug`)
 * with `where` translated to `FilterExpression`, then in-memory sort and page
 * slice. `Query` reads only the rows in this collection's partition, so we no
 * longer pay to walk the whole table.
 *
 * For collections with `versions.drafts: true`, also pull `latest=true` rows
 * from the versions partition and union in any whose parent isn't already
 * represented in the main partition. This catches drafts-only docs (created
 * but never published) that would otherwise be invisible to `find`.
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

  if (collectionHasDrafts(this, collection)) {
    const supplements = await fetchDraftsOnlySupplements(this, collection, matched, where)
    matched.push(...supplements)
  }

  applySorts(matched, sort)

  const totalDocs = matched.length
  // `limit: 0` disables the cap. When pagination is false, limit/page still
  // control the slice; the flag only gates total-count metadata.
  const useLimit = limit > 0
  const safePage = useLimit ? Math.max(1, page) : 1

  const start = useLimit ? (safePage - 1) * limit : 0
  const end = useLimit ? start + limit : totalDocs
  const docs = matched.slice(start, end)

  const effectiveLimit = useLimit ? limit : totalDocs
  const totalPages = pagination && useLimit ? Math.max(1, Math.ceil(totalDocs / limit)) : 1
  const hasNextPage = pagination && useLimit && safePage < totalPages
  const hasPrevPage = pagination && useLimit && safePage > 1

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
