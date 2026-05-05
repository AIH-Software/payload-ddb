import type { Where } from 'payload'

import type { DynamoAdapter } from '../types.js'

import { matchesWhere } from './matchesWhere.js'
import { queryMatching } from './queryMatching.js'

/**
 * Returns true when the named collection has `versions.drafts` enabled in
 * the Payload config. Read methods that union main-partition rows with
 * latest-version rows gate on this so non-drafts collections stay on the
 * fast single-partition path.
 */
export function collectionHasDrafts(adapter: DynamoAdapter, collectionSlug: string): boolean {
  const cfg = adapter.payload.config.collections.find((c) => c.slug === collectionSlug)
  if (!cfg?.versions) return false
  return cfg.versions.drafts !== false
}

/**
 * Pull `latest=true` rows from the versions partition for any parent that
 * isn't already represented in `mainRows`, project each row's `version`
 * payload up to top-level (so it looks like a doc), filter by `where` in
 * JS, and return the supplemental docs ready to merge into `mainRows`.
 *
 * The intentional asymmetry: when a parent appears in both partitions, the
 * main-partition row wins. `find`/`findOne` reflect persistent state, and
 * for a doc that has been published the main row IS that state. The
 * version-only path is what catches drafts-only docs (created but never
 * published, so no main-partition row exists).
 *
 * `where` was already pushed to DynamoDB for the main-partition Query but
 * can't be reused here — version-row attributes live nested under
 * `version.*` until projection. We re-evaluate in JS against the projected
 * docs to keep semantics consistent.
 */
export async function fetchDraftsOnlySupplements(
  adapter: DynamoAdapter,
  collectionSlug: string,
  mainRows: Record<string, unknown>[],
  where: undefined | Where,
): Promise<Record<string, unknown>[]> {
  const versionsPartition = adapter.resolveVersionsPartition(collectionSlug)
  const latestRows = await queryMatching(adapter, versionsPartition, {
    latest: { equals: true },
  })

  const seen = new Set<unknown>(mainRows.map((row) => row['id']))
  const supplements: Record<string, unknown>[] = []
  for (const row of latestRows) {
    if (seen.has(row['parent'])) continue
    const version = row['version']
    if (!version || typeof version !== 'object') continue
    const projected: Record<string, unknown> = {
      ...(version as Record<string, unknown>),
      id: row['parent'],
    }
    if (where && !matchesWhere(projected, where)) continue
    supplements.push(projected)
  }
  return supplements
}
