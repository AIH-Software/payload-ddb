import type { CountVersions } from 'payload'

import type { DynamoAdapter } from './types.js'

import { castVersionsWhere } from './utilities/castWhere.js'
import { queryCount } from './utilities/queryCount.js'

export const countVersions: CountVersions = async function countVersions(
  this: DynamoAdapter,
  { collection, where: rawWhere },
) {
  const where = castVersionsWhere(this, { kind: 'collection', slug: collection }, rawWhere)
  const totalDocs = await queryCount(this, this.resolveVersionsPartition(collection), where)
  return { totalDocs }
}
