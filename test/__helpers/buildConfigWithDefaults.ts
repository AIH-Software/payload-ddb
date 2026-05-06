import type { Config, SanitizedConfig } from 'payload'

import { buildConfig } from 'payload'

import { dynamoAdapter } from '../../src/index.js'
import { TEST_DDB_ENDPOINT } from './assertDbReachable.js'

/**
 * Build a sanitized payload config wired to DynamoDB Local with `ensureTables`
 * enabled, so each suite can boot against a freshly-provisioned table without
 * any external setup. Mirrors the shape of payload's own
 * `test/buildConfigWithDefaults.ts` — caller passes a partial config and we
 * fill in the adapter, secret, and other test-environment defaults.
 */
export async function buildConfigWithDefaults(
  testConfig: Partial<Config>,
  options: { tableName: string },
): Promise<SanitizedConfig> {
  const config: Config = {
    db: dynamoAdapter({
      tableName: options.tableName,
      ensureTables: true,
      clientConfig: {
        endpoint: TEST_DDB_ENDPOINT,
        region: 'us-east-1',
        // DynamoDB Local accepts any non-empty credentials when `-sharedDb`
        // is set. Hardcoding here keeps tests independent of whatever AWS
        // profile a developer might have on their machine.
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      },
    }),
    secret: 'TEST_SECRET',
    telemetry: false,
    ...testConfig,
    typescript: {
      declare: false,
      ...testConfig.typescript,
    },
  }

  return buildConfig(config)
}
