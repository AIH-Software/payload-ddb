import type { UpdateVersion } from 'payload'

import type { DynamoAdapter } from './types.js'

import { updateVersionRow } from './utilities/updateVersionRow.js'

/**
 * Read-merge-write against the versions partition. `versionData` is
 * splatted onto the existing row, which means Payload-passed metadata
 * (`createdAt`, `updatedAt`, `latest`, `parent`, `publishedLocale`) and the
 * inner `version` payload all overlay correctly.
 *
 * The adapter does not cascade `latest=true` flips — Payload is responsible
 * for clearing the previous latest by issuing a separate `updateVersion`
 * call. This matches the `createVersion` boundary: `createVersion` owns the
 * cascade because it knows it's making a new latest; `updateVersion` writes
 * exactly what it's told.
 */
export const updateVersion: UpdateVersion = async function updateVersion(
  this: DynamoAdapter,
  args,
) {
  return updateVersionRow(this, { kind: 'collection', slug: args.collection }, args) as never
}
