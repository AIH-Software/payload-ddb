import type { Find, PaginatedDocs, Sort, Where } from 'payload'

import type { DynamoAdapter } from './types.js'

import { applySorts } from './utilities/applySorts.js'
import { buildFilterExpression } from './utilities/buildFilterExpression.js'
import { collectionHasDrafts, fetchDraftsOnlySupplements } from './utilities/draftsFallback.js'
import { findByIndex, findOrderedPage } from './utilities/indexLookup.js'
import { prepareCollectionWhere, prepareSort } from './utilities/prepareWhere.js'
import { queryCount } from './utilities/queryCount.js'
import { queryMatching } from './utilities/queryMatching.js'
import { resolveJoins } from './utilities/resolveJoins.js'

type Row = Record<string, unknown>

/**
 * Three ways to produce a page, cheapest first:
 *
 *  1. **By key.** A clause of `where` pins the documents down — an id, a
 *     unique value, an indexed value or range (`findByIndex`). They are read
 *     by key, then sorted and sliced in memory.
 *  2. **In index order.** The sort is on a single-valued indexed field, so
 *     that field's index is walked in order and only as far as the page
 *     reaches (`findOrderedPage`). The total is counted separately when the
 *     caller wants pagination metadata.
 *  3. **The whole partition.** `where` is pushed into `FilterExpression` as
 *     far as DynamoDB can express it, and the matches are sorted and sliced
 *     in memory.
 *
 * For collections with `versions.drafts: true`, the `latest=true` version
 * rows of documents not already matched are unioned in. This catches
 * drafts-only docs (created but never published) that would otherwise be
 * invisible to `find`. That union has to be sorted as a whole, so those
 * collections don't take the second route.
 */
export const find: Find = async function find(
  this: DynamoAdapter,
  { collection, joins, limit = 10, locale, page = 1, pagination = true, sort, where: rawWhere },
) {
  const where = await prepareCollectionWhere(this, collection, rawWhere, locale)
  const partition = this.resolvePartition(collection)
  const preparedSort = prepareSort(this, { kind: 'collection', slug: collection }, sort, locale)

  // `limit: 0` disables the cap. When pagination is false, limit/page still
  // control the slice; the flag only gates total-count metadata.
  const useLimit = limit > 0
  const safePage = useLimit ? Math.max(1, page) : 1
  const start = useLimit ? (safePage - 1) * limit : 0

  const compiled = buildFilterExpression(where)
  const viaIndex = compiled.never ? [] : await findByIndex(this, partition, where)
  const hasDrafts = collectionHasDrafts(this, collection)

  let docs: Row[] | undefined
  let totalDocs = 0

  if (!viaIndex && !hasDrafts && useLimit) {
    const ordered = await orderedPage(this, partition, {
      // Counting needs a `where` DynamoDB can evaluate on its own; otherwise
      // the count would read every match anyway.
      countable: compiled.exact,
      pagination,
      skip: start,
      sort: preparedSort,
      take: limit,
      where,
    })
    if (ordered) ({ docs, totalDocs } = ordered)
  }

  if (!docs) {
    const matched = viaIndex ?? (await queryMatching(this, partition, where, { skipIndex: true }))
    if (hasDrafts) {
      const supplements = await fetchDraftsOnlySupplements(this, collection, matched, where)
      matched.push(...supplements)
    }
    applySorts(matched, preparedSort)

    totalDocs = matched.length
    docs = matched.slice(start, useLimit ? start + limit : totalDocs)
  }

  // Only the page being returned — joins cost a lookup per target collection.
  await resolveJoins(this, { collectionSlug: collection, docs, joins, locale })

  const effectiveLimit = useLimit ? limit : totalDocs
  const totalPages = pagination && useLimit ? Math.max(1, Math.ceil(totalDocs / limit)) : 1
  const hasNextPage = pagination && useLimit && safePage < totalPages
  const hasPrevPage = pagination && useLimit && safePage > 1

  const result: PaginatedDocs<Row> = {
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

/**
 * A page read in index order, with its total, or `null` when the sort
 * can't be answered that way.
 *
 * With pagination the total is a `COUNT` of the partition: DynamoDB still
 * walks it, but sends no documents back. Without pagination nothing is
 * counted and the total is the size of the page, as Payload's SQL adapters
 * report it.
 */
async function orderedPage(
  adapter: DynamoAdapter,
  partition: string,
  args: {
    countable: boolean
    pagination: boolean
    skip: number
    sort: Sort | undefined
    take: number
    where: undefined | Where
  },
): Promise<null | { docs: Row[]; totalDocs: number }> {
  const keys = (Array.isArray(args.sort) ? args.sort : [args.sort]).filter(Boolean)
  if (keys.length !== 1) return null
  if (args.pagination && !args.countable) return null

  const key = keys[0] as string
  const descending = key.startsWith('-')
  const docs = await findOrderedPage(adapter, partition, {
    descending,
    path: descending ? key.slice(1) : key,
    skip: args.skip,
    take: args.take,
    where: args.where,
  })
  if (!docs) return null

  const totalDocs = args.pagination
    ? await queryCount(adapter, partition, args.where, { skipIndex: true })
    : docs.length
  return { docs, totalDocs }
}
