import type { FindGlobal } from 'payload'

import { GetCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from './types.js'

import { matchesWhere } from './utilities/matchesWhere.js'
import { stripInternalKeys } from './utilities/stripInternalKeys.js'

/**
 * Globals are singleton documents. Each lives at `pk = slug, sk = slug`, so
 * reads are a single `GetItem`.
 *
 * The optional `where` is applied as a post-filter via `matchesWhere` —
 * Payload uses it sparingly (mostly for guards) and the row is already
 * in-memory, so a JS check is fine.
 */
export const findGlobal: FindGlobal = async function findGlobal(
  this: DynamoAdapter,
  { slug, where },
) {
  const docClient = this.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: this.tableName,
      Key: { pk: this.resolvePartition(slug), sk: slug },
      ConsistentRead: true,
    }),
  )

  if (!result.Item) {
    return null as never
  }
  const item = stripInternalKeys(result.Item)
  if (where && !matchesWhere(item, where)) {
    return null as never
  }
  return item as never
}
