import type { DeleteVersions } from 'payload'

import { DeleteCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from './types.js'

import { queryMatching } from './utilities/queryMatching.js'

/**
 * Same query + parallel delete pattern as `deleteMany`, but routes to the
 * versions partition for either a collection (`collection`) or a global
 * (`globalSlug`). Payload guarantees exactly one of those two slugs is
 * present.
 */
export const deleteVersions: DeleteVersions = async function deleteVersions(
  this: DynamoAdapter,
  { collection, globalSlug, where },
) {
  const docClient = this.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  const slug = collection ?? globalSlug
  if (!slug) {
    throw new Error('payload-ddb: deleteVersions requires either `collection` or `globalSlug`.')
  }

  const partition = this.resolveVersionsPartition(slug)
  const matched = await queryMatching(this, partition, where)

  await Promise.all(
    matched.map((target) =>
      docClient.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk: partition, sk: String(target['id']) },
        }),
      ),
    ),
  )
}
