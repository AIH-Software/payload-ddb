import type { CountVersions } from 'payload'

import type { DynamoAdapter } from './types.js'

import { queryCount } from './utilities/queryCount.js'

export const countVersions: CountVersions = async function countVersions(
  this: DynamoAdapter,
  { collection, where },
) {
  const totalDocs = await queryCount(this, this.resolveVersionsPartition(collection), where)
  return { totalDocs }
}
