import type { DeleteMany } from 'payload'

import type { DynamoAdapter } from './types.js'

import { prepareCollectionWhere } from './utilities/prepareWhere.js'
import { queryMatching } from './utilities/queryMatching.js'
import { hasUniqueFields } from './utilities/uniqueGuards.js'
import { deleteItems } from './utilities/writeItems.js'

/**
 * v1 strategy: query-and-collect matches, then delete each by composite key
 * in parallel. See `deleteItems` for why this isn't a `BatchWriteItem`.
 */
export const deleteMany: DeleteMany = async function deleteMany(
  this: DynamoAdapter,
  { collection, where: rawWhere },
) {
  const where = await prepareCollectionWhere(this, collection, rawWhere)
  const partition = this.resolvePartition(collection)
  const matched = await queryMatching(this, partition, where)

  await deleteItems(
    this,
    partition,
    matched,
    // Unique guards are released together with the documents that hold them.
    hasUniqueFields(this, collection) ? collection : undefined,
  )
}
