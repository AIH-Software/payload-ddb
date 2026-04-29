import {
  CreateTableCommand,
  DescribeTableCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb'

import type { DynamoAdapter } from '../types.js'

/**
 * Idempotently provision the single backing table with our composite-key
 * schema: `pk` (String) partition + `sk` (String) sort, on-demand
 * (`PAY_PER_REQUEST`) billing.
 *
 * Behavior:
 *  - DescribeTable first; return early if the table already exists.
 *  - Otherwise CreateTable + wait until ACTIVE (up to 60s).
 *
 * Sort key is always String. Collections that opt into Number IDs still work
 * — the adapter coerces ids into strings for `sk` while keeping the original
 * type on the `id` attribute.
 */
export async function ensureTable(adapter: DynamoAdapter, tableName: string): Promise<void> {
  const client = adapter.client
  if (!client) {
    throw new Error('payload-ddb: client is not initialized — call connect() first.')
  }

  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }))
    return
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'ResourceNotFoundException') {
      throw err
    }
  }

  adapter.payload.logger.info(`payload-ddb: creating table \`${tableName}\``)

  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  )

  await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName: tableName })
}
