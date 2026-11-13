import type { Create } from 'payload'

import { randomUUID } from 'node:crypto'

import type { DynamoAdapter } from './types.js'

import { backoff, conflictError, getById, MAX_WRITE_ATTEMPTS } from './utilities/optimistic.js'
import { projectForCollection } from './utilities/resolveSchema.js'
import { mustBeUniqueError, rethrowUniqueViolation } from './utilities/writeErrors.js'
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
  const partition = this.resolvePartition(collection)

  for (let attempt = 1; ; attempt++) {
    try {
      // Insert-only: a plain `PutItem` would replace whatever row already
      // sits at this id, so a caller-supplied id that collides with an
      // existing doc would silently destroy it. `unique` adds a guard row per
      // unique field in the same transaction.
      await putItem(this, partition, projected, { mustNotExist: true, unique: { collection } })
      break
    } catch (err) {
      rethrowUniqueViolation(err, collection, req)
      if (!isConditionalCheckFailed(err)) throw err

      // Either the id is taken, or this write collided with a concurrent one
      // over a unique value. Surface the first the way the Mongo and Postgres
      // adapters surface a duplicate primary key — a `ValidationError` on
      // `id` — and retry the second, which resolves to a clean success or a
      // unique violation.
      if (await getById(this, partition, id)) throw mustBeUniqueError('id', collection, req)
      if (attempt >= MAX_WRITE_ATTEMPTS) throw conflictError()
      await backoff(attempt)
    }
  }

  return returning === false ? (null as never) : projected
}
