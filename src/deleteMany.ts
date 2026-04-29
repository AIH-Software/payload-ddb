import type { DeleteMany } from 'payload'

import { DeleteCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from './types.js'

import { queryMatching } from './utilities/queryMatching.js'

/**
 * v1 strategy: query-and-collect matches, then delete each by composite key
 * in parallel.
 *
 * `BatchWriteItem` could halve the request count (25 deletes per call) but
 * has partial-failure semantics that need retry logic — out of scope until
 * we wire up retries. Sequential parallel `DeleteCommand`s are simple and
 * correct.
 */
export const deleteMany: DeleteMany = async function deleteMany(
  this: DynamoAdapter,
  { collection, where },
) {
  const docClient = this.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  const partition = this.resolvePartition(collection)
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
