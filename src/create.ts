import type { Create } from 'payload'

import { randomUUID } from 'node:crypto'

import type { DynamoAdapter } from './types.js'

import { projectForCollection } from './utilities/resolveSchema.js'
import { putItem } from './utilities/writeItems.js'

export const create: Create = async function create(
  this: DynamoAdapter,
  { collection, customID, data, returning },
) {
  const id = customID ?? data['id'] ?? randomUUID()
  const now = new Date().toISOString()
  // Spread `data` first, then nullish-coalesce timestamps. Explicit values
  // in `data` (versions/restore, migrations backdating) still win, but a
  // payload-passed `data.createdAt = undefined` no longer wipes the default
  // back to undefined — which the marshaller would then drop with
  // `removeUndefinedValues: true`, leaving the row without timestamps.
  const item: Record<string, unknown> = {
    ...data,
    id,
    createdAt: data['createdAt'] ?? now,
    updatedAt: data['updatedAt'] ?? now,
  }
  // Project against the collection's declared fields. DDB has no schema
  // layer, so without this any stray request-body key (notoriously the
  // registration form's `confirm-password`) would persist verbatim.
  const projected = projectForCollection(this, collection, item)

  await putItem(this, this.resolvePartition(collection), projected)

  return returning === false ? (null as never) : projected
}
