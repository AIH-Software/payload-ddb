import type { FindOne } from 'payload'

import type { DynamoAdapter } from './types.js'

import { collectionHasDrafts, fetchDraftsOnlySupplements } from './utilities/draftsFallback.js'
import { findFirst } from './utilities/findFirst.js'
import { prepareCollectionWhere } from './utilities/prepareWhere.js'
import { resolveJoins } from './utilities/resolveJoins.js'

/**
 * Locate one doc in `collection` matching `where`. For drafts-enabled
 * collections, fall back to the `latest=true` version row when no main
 * partition row matches — that's how drafts-only docs (saved but never
 * published) become findable.
 */
export const findOne: FindOne = async function findOne(
  this: DynamoAdapter,
  { collection, joins, locale, where: rawWhere },
) {
  const where = await prepareCollectionWhere(this, collection, rawWhere, locale)
  const partition = this.resolvePartition(collection)

  let doc = await findFirst(this, { partition, where })
  if (!doc && collectionHasDrafts(this, collection)) {
    const supplements = await fetchDraftsOnlySupplements(this, collection, [], where)
    doc = supplements[0] ?? null
  }
  if (!doc) return null as never

  await resolveJoins(this, { collectionSlug: collection, docs: [doc], joins, locale })
  return doc as never
}
