import type { DeleteOne } from 'payload'

import type { DynamoAdapter } from './types.js'

import { findFirst } from './utilities/findFirst.js'
import { whereToId } from './utilities/whereToId.js'
import { deleteItem } from './utilities/writeItems.js'

export const deleteOne: DeleteOne = async function deleteOne(
  this: DynamoAdapter,
  { collection, returning, where },
) {
  const partition = this.resolvePartition(collection)
  const idFromWhere = whereToId(where)

  // Fast path — pure id-equality lets us delete and capture the doc in one call.
  if (idFromWhere !== null) {
    const deleted = await deleteItem(this, partition, idFromWhere, { returnOld: true })
    if (returning === false) {
      return null as never
    }
    return deleted as never
  }

  // Slow path — locate by query, then delete by composite key.
  const found = await findFirst(this, { partition, where })
  if (!found) {
    return null as never
  }

  await deleteItem(this, partition, found['id'])

  if (returning === false) {
    return null as never
  }
  return found as never
}
