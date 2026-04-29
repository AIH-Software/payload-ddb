import type { CountGlobalVersions } from 'payload'

import type { DynamoAdapter } from './types.js'

import { queryCount } from './utilities/queryCount.js'

export const countGlobalVersions: CountGlobalVersions = async function countGlobalVersions(
  this: DynamoAdapter,
  { global, where },
) {
  const totalDocs = await queryCount(this, this.resolveVersionsPartition(global), where)
  return { totalDocs }
}
