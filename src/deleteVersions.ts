import type { DeleteVersions } from 'payload'

import type { DynamoAdapter } from './types.js'

import { castVersionsWhere } from './utilities/castWhere.js'
import { queryMatching } from './utilities/queryMatching.js'
import { deleteItems } from './utilities/writeItems.js'

/**
 * Same query + parallel delete pattern as `deleteMany`, but routes to the
 * versions partition for either a collection (`collection`) or a global
 * (`globalSlug`). Payload guarantees exactly one of those two slugs is
 * present.
 */
export const deleteVersions: DeleteVersions = async function deleteVersions(
  this: DynamoAdapter,
  { collection, globalSlug, where },
) {
  const slug = collection ?? globalSlug
  if (!slug) {
    throw new Error('payload-ddb: deleteVersions requires either `collection` or `globalSlug`.')
  }

  const partition = this.resolveVersionsPartition(slug)
  const matched = await queryMatching(
    this,
    partition,
    castVersionsWhere(this, { kind: collection ? 'collection' : 'global', slug }, where),
  )

  await deleteItems(
    this,
    partition,
    matched.map((target) => target['id']),
  )
}
