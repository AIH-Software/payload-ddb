import type { UpdateGlobalVersion } from 'payload'

import type { DynamoAdapter } from './types.js'

import { updateVersionRow } from './utilities/updateVersionRow.js'

/**
 * Same read-merge-write semantics as `updateVersion`. Doesn't cascade
 * `latest` flips for the same reason: Payload owns that contract by issuing
 * paired updates.
 */
export const updateGlobalVersion: UpdateGlobalVersion = async function updateGlobalVersion(
  this: DynamoAdapter,
  args,
) {
  return updateVersionRow(this, { kind: 'global', slug: args.global }, args) as never
}
