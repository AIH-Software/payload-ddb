import type { PaginatedDocs, QueryDrafts } from 'payload'

import type { DynamoAdapter } from './types.js'

import { applySorts } from './utilities/applySorts.js'
import { matchesWhere } from './utilities/matchesWhere.js'
import { queryMatching } from './utilities/queryMatching.js'

/**
 * Return the latest version of every doc as a paginated, doc-shaped result.
 *
 * Strategy:
 *  1. Query the versions partition for `latest=true` rows (one per parent).
 *  2. Project each row's `version` payload up to top-level so the result
 *     looks like a doc — this lets the user's `where` / `sort` operate in
 *     doc-field terms instead of `version.x` paths.
 *  3. Fill in any docs that have a row in the *main* partition but no
 *     `latest=true` version row. This covers two cases:
 *     - documents created before versioning was enabled
 *     - data orphaned by historical adapter bugs that dropped version writes
 *  4. Apply `where` post-projection, sort, paginate.
 *
 * No `_status` filter is applied — `queryDrafts` returns the latest version
 * regardless of draft/published state. Payload's higher-level code decides
 * how to use the result.
 */
export const queryDrafts: QueryDrafts = async function queryDrafts(
  this: DynamoAdapter,
  { collection, limit = 10, page = 1, pagination = true, sort, where },
) {
  const versionsPartition = this.resolveVersionsPartition(collection)
  const docsPartition = this.resolvePartition(collection)

  const [latestRows, mainRows] = await Promise.all([
    queryMatching(this, versionsPartition, { latest: { equals: true } }),
    queryMatching(this, docsPartition, undefined),
  ])

  // Latest-version rows win. We key by parent id so `mainRows` only fills
  // entries that have no version backing.
  const docsByParent = new Map<unknown, Record<string, unknown>>()
  for (const row of latestRows) {
    const version = row['version']
    if (!version || typeof version !== 'object') continue
    docsByParent.set(row['parent'], {
      ...(version as Record<string, unknown>),
      id: row['parent'],
    })
  }

  for (const doc of mainRows) {
    if (!docsByParent.has(doc['id'])) {
      docsByParent.set(doc['id'], doc)
    }
  }

  const projected = [...docsByParent.values()]
  const matched = where ? projected.filter((doc) => matchesWhere(doc, where)) : projected

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
