import type { FindGlobalVersions, PaginatedDocs } from 'payload'

import type { DynamoAdapter } from './types.js'

import { applySorts } from './utilities/applySorts.js'
import { queryMatching } from './utilities/queryMatching.js'

export const findGlobalVersions: FindGlobalVersions = async function findGlobalVersions(
  this: DynamoAdapter,
  { global, limit = 10, page = 1, pagination = true, sort, where },
) {
  const partition = this.resolveVersionsPartition(global)
  const matched = await queryMatching(this, partition, where)
  applySorts(matched, sort)

  const totalDocs = matched.length
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
