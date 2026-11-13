import type { CountGlobalVersions } from 'payload'

import type { DynamoAdapter } from './types.js'

import { prepareVersionsWhere } from './utilities/prepareWhere.js'
import { queryCount } from './utilities/queryCount.js'

export const countGlobalVersions: CountGlobalVersions = async function countGlobalVersions(
  this: DynamoAdapter,
  { global, locale, where: rawWhere },
) {
  const where = await prepareVersionsWhere(this, { kind: 'global', slug: global }, rawWhere, locale)
  const totalDocs = await queryCount(this, this.resolveVersionsPartition(global), where)
  return { totalDocs }
}
