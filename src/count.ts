import type { Count } from 'payload'

import type { DynamoAdapter } from './types.js'

import { queryCount } from './utilities/queryCount.js'

export const count: Count = async function count(this: DynamoAdapter, { collection, where }) {
  const totalDocs = await queryCount(this, this.resolvePartition(collection), where)
  return { totalDocs }
}
