import type { Config, Payload } from 'payload'

import { getPayload } from 'payload'

import type { DynamoAdapter } from '../../src/index.js'

import { buildConfigWithDefaults } from './buildConfigWithDefaults.js'
import { deleteTable } from './deleteTable.js'
import { randomTableName } from './randomTableName.js'

export type TestHandle = {
  payload: Payload
  tableName: string
  /** Tear down: destroy payload (drops the AWS clients) then drop the table. */
  cleanup: () => Promise<void>
}

/**
 * Boot a Payload instance against DynamoDB Local with a unique table name.
 * Returns a `cleanup` that should be called from `afterAll` so the suite
 * leaves no tables behind in the shared dev DB.
 *
 * The `suite` arg only seeds the table name (`payload-test-<suite>-<rand>`)
 * — purely a debugging convenience when listing tables.
 */
export async function initPayloadTest(
  suite: string,
  testConfig: Partial<Config>,
): Promise<TestHandle> {
  const tableName = randomTableName(suite)
  const sanitized = await buildConfigWithDefaults(testConfig, { tableName })
  const payload = await getPayload({ config: sanitized })

  const cleanup = async () => {
    // Pull the live client off the adapter *before* destroy nulls it out,
    // so we can issue the table-delete after payload has released ownership.
    const adapter = payload.db as DynamoAdapter
    const client = adapter.client
    await payload.destroy()
    if (client) {
      await deleteTable(client, tableName).catch(() => {
        // Ignore — the test container is `-inMemory` so the table dies with
        // the container anyway. Failing here would mask the real test error.
      })
      client.destroy()
    }
  }

  return { payload, tableName, cleanup }
}
