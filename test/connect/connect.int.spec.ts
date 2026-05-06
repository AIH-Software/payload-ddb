import { DescribeTableCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DynamoAdapter } from '../../src/index.js'

import { ensureTable } from '../../src/utilities/ensureTable.js'
import { initPayloadTest, type TestHandle } from '../__helpers/initPayload.js'
import { config } from './config.js'

let handle: TestHandle

beforeAll(async () => {
  handle = await initPayloadTest('connect', config)
})

afterAll(async () => {
  await handle.cleanup()
})

describe('connect / lifecycle', () => {
  it('boots payload and exposes a docClient on the adapter', () => {
    const adapter = handle.payload.db as DynamoAdapter
    expect(adapter.client).toBeDefined()
    expect(adapter.docClient).toBeDefined()
    expect(adapter.tableName).toBe(handle.tableName)
  })

  it('provisioned the table when ensureTables=true', async () => {
    const adapter = handle.payload.db as DynamoAdapter
    const client = adapter.client as DynamoDBClient
    const result = await client.send(new DescribeTableCommand({ TableName: handle.tableName }))
    expect(result.Table?.TableStatus).toBe('ACTIVE')
    expect(result.Table?.KeySchema).toEqual([
      { AttributeName: 'pk', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ])
  })

  it('ensureTable is idempotent — re-running does not throw', async () => {
    // Re-invoking on an existing table is the dev-loop case (restart payload
    // against a still-warm container). DescribeTable returns ACTIVE and
    // ensureTable returns early without trying to CreateTable a second time.
    const adapter = handle.payload.db as DynamoAdapter
    await expect(ensureTable(adapter, handle.tableName)).resolves.toBeUndefined()
    await expect(ensureTable(adapter, handle.tableName)).resolves.toBeUndefined()
  })

  it('round-trips a basic create → findOne via the adapter', async () => {
    const created = await handle.payload.create({
      collection: 'items',
      data: { name: 'hello', value: 1 },
    })
    expect(created.id).toBeTruthy()

    const found = await handle.payload.findByID({
      collection: 'items',
      id: created.id,
    })
    expect(found).toMatchObject({ name: 'hello', value: 1 })
  })
})
