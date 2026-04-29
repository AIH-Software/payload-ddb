import type { Init } from 'payload'

import type { DynamoAdapter } from './types.js'

import { ensureConnected } from './utilities/ensureConnected.js'
import { ensureTable } from './utilities/ensureTable.js'

/**
 * Lifecycle hook called once after the factory `init` returns the adapter.
 * Payload's order is `init → connect`, so we call `ensureConnected` here
 * to populate the client before any DynamoDB operations.
 *
 * In single-table mode, every collection, global, and versions stream lives
 * under a different `pk` value in the same physical table — so provisioning
 * just means making sure that one table exists.
 *
 * Provisioning is opt-in because real deployments typically manage tables
 * out-of-band (CDK, Terraform, CloudFormation). It's a meaningful dev-loop
 * convenience for local testing against DynamoDB Local.
 */
export const init: Init = async function (this: DynamoAdapter) {
  ensureConnected(this)

  this.payload.logger.debug(
    `payload-ddb: init using table \`${this.tableName}\`; ensureTables=${this.ensureTables}`,
  )

  if (this.ensureTables) {
    await ensureTable(this, this.tableName)
    this.payload.logger.debug('payload-ddb: table ready')
  }
}
