import type { FindVersions, PaginatedDocs } from 'payload'

import type { DynamoAdapter } from './types.js'

import { applySorts } from './utilities/applySorts.js'
import { queryMatching } from './utilities/queryMatching.js'

/**
 * Same shape as `find` but routed at the versions partition. Could share
 * more code with `find` via a `paginatedQuery(adapter, partition, args)`
 * helper, but keeping them separate makes per-method tweaks (e.g.
 * version-only filters, eventual draft-aware logic) easier to land without
 * refactoring.
 */
export const findVersions: FindVersions = async function findVersions(
  this: DynamoAdapter,
  { collection, limit = 10, page = 1, pagination = true, sort, where },
) {
  const partition = this.resolveVersionsPartition(collection)
  const matched = await queryMatching(this, partition, where)
  applySorts(matched, sort)

  const totalDocs = matched.length
  // `limit: 0` disables the cap. When pagination is false, limit/page still
  // control the slice (e.g. enforceMaxVersions fetches page max+1 with limit 1
  // to find the oldest doc to prune). The pagination flag only gates whether
  // we compute meaningful total-count metadata.
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
