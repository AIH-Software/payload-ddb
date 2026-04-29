import type { FindDistinct, PaginatedDistinctDocs } from 'payload'

import type { DynamoAdapter } from './types.js'

import { applySorts } from './utilities/applySorts.js'
import { getByPath } from './utilities/getByPath.js'
import { queryMatching } from './utilities/queryMatching.js'

/**
 * v2 strategy: paginated `Query` over the collection's partition, JS `where`
 * filter has already been pushed down via `FilterExpression`, then dedup via
 * `Set` and sort + paginate the resulting value list.
 *
 * Dedup uses primitive equality. Object- or array-valued fields would compare
 * by reference, so if you `findDistinct` over a non-primitive field you'll
 * get one entry per item (no real dedup). Stringification-based dedup can
 * land if it turns out to matter.
 */
export const findDistinct: FindDistinct = async function findDistinct(
  this: DynamoAdapter,
  { collection, field, limit = 10, page = 1, sort, where },
) {
  const matched = await queryMatching(this, this.resolvePartition(collection), where)

  const seen = new Set<unknown>()
  const values: Record<string, unknown>[] = []
  for (const item of matched) {
    const value = getByPath(item, field)
    if (value === undefined) continue
    if (seen.has(value)) continue
    seen.add(value)
    values.push({ [field]: value })
  }

  applySorts(values, sort)

  const totalDocs = values.length
  const useLimit = limit > 0
  const effectiveLimit = useLimit ? limit : totalDocs
  const totalPages = useLimit ? Math.max(1, Math.ceil(totalDocs / limit)) : 1
  const safePage = useLimit ? Math.max(1, page) : 1

  const start = useLimit ? (safePage - 1) * limit : 0
  const end = useLimit ? start + limit : totalDocs
  const paged = values.slice(start, end)

  const hasNextPage = useLimit && safePage < totalPages
  const hasPrevPage = useLimit && safePage > 1

  const result: PaginatedDistinctDocs<Record<string, unknown>> = {
    values: paged,
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
  return result
}
