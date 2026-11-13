import type { Create } from 'payload'

import { randomUUID } from 'node:crypto'
import { ValidationError } from 'payload'

import type { DynamoAdapter } from './types.js'

import { projectForCollection } from './utilities/resolveSchema.js'
import { isConditionalCheckFailed, putItem } from './utilities/writeItems.js'

export const create: Create = async function create(
  this: DynamoAdapter,
  { collection, customID, data, req, returning },
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

  try {
    // Insert-only: a plain `PutItem` would replace whatever row already sits
    // at this id, so a caller-supplied id that collides with an existing doc
    // would silently destroy it.
    await putItem(this, this.resolvePartition(collection), projected, { mustNotExist: true })
  } catch (err) {
    if (!isConditionalCheckFailed(err)) throw err
    // Surface the collision the way the Mongo and Postgres adapters surface a
    // duplicate primary key: a `ValidationError` on `id`, which Payload turns
    // into a 400 with a field-level message.
    throw new ValidationError(
      {
        collection,
        errors: [
          {
            message: req?.t ? req.t('error:valueMustBeUnique') : 'Value must be unique',
            path: 'id',
          },
        ],
        ...(req ? { req } : {}),
      },
      req?.t,
    )
  }

  return returning === false ? (null as never) : projected
}
