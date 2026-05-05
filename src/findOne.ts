import type { FindOne } from 'payload'

import type { DynamoAdapter } from './types.js'

import { collectionHasDrafts, fetchDraftsOnlySupplements } from './utilities/draftsFallback.js'
import { findFirst } from './utilities/findFirst.js'

/**
 * Locate one doc in `collection` matching `where`. For drafts-enabled
 * collections, fall back to the `latest=true` version row when no main
 * partition row matches — that's how drafts-only docs (saved but never
 * published) become findable.
 */
export const findOne: FindOne = async function findOne(
  this: DynamoAdapter,
  { collection, where },
) {
  const partition = this.resolvePartition(collection)
  const found = await findFirst(this, { partition, where })
  if (found) return found as never

  if (collectionHasDrafts(this, collection)) {
    const supplements = await fetchDraftsOnlySupplements(this, collection, [], where)
    if (supplements.length > 0) return supplements[0] as never
  }

  return null as never
}
