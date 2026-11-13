import type { DeleteOne } from 'payload'

import type { DynamoAdapter } from './types.js'

import { hasCompanionRows } from './utilities/fieldIndexes.js'
import { findFirst } from './utilities/findFirst.js'
import { prepareCollectionWhere } from './utilities/prepareWhere.js'
import { whereToId } from './utilities/whereToId.js'
import { deleteItem } from './utilities/writeItems.js'

export const deleteOne: DeleteOne = async function deleteOne(
  this: DynamoAdapter,
  { collection, returning, where: rawWhere },
) {
  const where = await prepareCollectionWhere(this, collection, rawWhere)
  const partition = this.resolvePartition(collection)
  const idFromWhere = whereToId(where)
  // Removing a document's unique guards and index rows needs its values, so
  // collections that have either always read the document first.
  const guarded = hasCompanionRows(this, collection)

  // Fast path — pure id-equality lets us delete and capture the doc in one call.
  if (idFromWhere !== null && !guarded) {
    const deleted = await deleteItem(this, partition, idFromWhere, { returnOld: true })
    if (returning === false) {
      return null as never
    }
    return deleted as never
  }

  // Slow path — locate (a `GetItem` when `where` is an id), then delete by
  // composite key.
  const found = await findFirst(this, { partition, where })
  if (!found) {
    return null as never
  }

  await deleteItem(
    this,
    partition,
    found['id'],
    guarded ? { companions: { collection, doc: found } } : {},
  )

  if (returning === false) {
    return null as never
  }
  return found as never
}
