import type { CountVersions } from 'payload'

import type { DynamoAdapter } from './types.js'

import { prepareVersionsWhere } from './utilities/prepareWhere.js'
import { queryCount } from './utilities/queryCount.js'

export const countVersions: CountVersions = async function countVersions(
  this: DynamoAdapter,
  { collection, locale, where: rawWhere },
) {
  const where = await prepareVersionsWhere(this, { kind: 'collection', slug: collection }, rawWhere, locale)
  const totalDocs = await queryCount(this, this.resolveVersionsPartition(collection), where)
  return { totalDocs }
}
