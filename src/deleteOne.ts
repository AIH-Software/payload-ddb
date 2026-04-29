import type { DeleteOne } from 'payload'

import { DeleteCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from './types.js'

import { findFirst } from './utilities/findFirst.js'
import { stripInternalKeys } from './utilities/stripInternalKeys.js'
import { whereToId } from './utilities/whereToId.js'

export const deleteOne: DeleteOne = async function deleteOne(
  this: DynamoAdapter,
  { collection, returning, where },
) {
  const docClient = this.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  const partition = this.resolvePartition(collection)
  const idFromWhere = whereToId(where)

  // Fast path — pure id-equality lets us delete and capture the doc in one call.
  if (idFromWhere !== null) {
    const result = await docClient.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: partition, sk: String(idFromWhere) },
        ReturnValues: 'ALL_OLD',
      }),
    )
    if (returning === false) {
      return null as never
    }
    return (result.Attributes ? stripInternalKeys(result.Attributes) : null) as never
  }

  // Slow path — locate by query, then delete by composite key.
  const found = await findFirst(this, { partition, where })
  if (!found) {
    return null as never
  }

  await docClient.send(
    new DeleteCommand({
      TableName: this.tableName,
      Key: { pk: partition, sk: String(found['id']) },
    }),
  )

  if (returning === false) {
    return null as never
  }
  return found as never
}
