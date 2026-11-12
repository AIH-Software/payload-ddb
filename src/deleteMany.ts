import type { DeleteMany } from 'payload'

import type { DynamoAdapter } from './types.js'

import { queryMatching } from './utilities/queryMatching.js'
import { deleteItems } from './utilities/writeItems.js'

/**
 * v1 strategy: query-and-collect matches, then delete each by composite key
 * in parallel. See `deleteItems` for why this isn't a `BatchWriteItem`.
 */
export const deleteMany: DeleteMany = async function deleteMany(
  this: DynamoAdapter,
  { collection, where },
) {
  const partition = this.resolvePartition(collection)
  const matched = await queryMatching(this, partition, where)

  await deleteItems(
    this,
    partition,
    matched.map((target) => target['id']),
  )
}
