import type { Count } from 'payload'

import type { DynamoAdapter } from './types.js'

import { prepareCollectionWhere } from './utilities/prepareWhere.js'
import { queryCount } from './utilities/queryCount.js'

export const count: Count = async function count(this: DynamoAdapter, { collection, locale, where }) {
  const cast = await prepareCollectionWhere(this, collection, where, locale)
  const totalDocs = await queryCount(this, this.resolvePartition(collection), cast)
  return { totalDocs }
}
