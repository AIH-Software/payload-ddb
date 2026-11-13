import type { Upsert } from 'payload'

import { randomUUID } from 'node:crypto'

import type { DynamoAdapter } from './types.js'

import { findFirst } from './utilities/findFirst.js'
import { backoff, conflictError, MAX_WRITE_ATTEMPTS } from './utilities/optimistic.js'
import { prepareCollectionWhere } from './utilities/prepareWhere.js'
import { projectForCollection } from './utilities/resolveSchema.js'
import { rethrowUniqueViolation } from './utilities/writeErrors.js'
import { isConditionalCheckFailed, putItem } from './utilities/writeItems.js'

/**
 * Locate by `where`; merge-and-put if found, put-with-fresh-id otherwise.
 *
 * Both branches are conditional — the update on the row being unchanged
 * since it was read, the insert on no row having appeared at that id — and
 * the whole locate-then-write is retried when the condition fails, so two
 * concurrent upserts of the same thing converge instead of clobbering each
 * other.
 *
 * Inlined rather than dispatching to `create`/`updateOne` via `.call(this)` —
 * piping through their `this`-typed signatures requires casts that obscure
 * the small amount of logic this function actually owns.
 */
export const upsert: Upsert = async function upsert(
  this: DynamoAdapter,
  { collection, data, locale, req, returning, where: rawWhere },
) {
  const where = await prepareCollectionWhere(this, collection, rawWhere, locale)
  const partition = this.resolvePartition(collection)

  for (let attempt = 1; ; attempt++) {
    const found = await findFirst(this, { partition, where })

    const now = new Date().toISOString()
    let item: Record<string, unknown>
    if (found) {
      // Bump `updatedAt` automatically; explicit value in `data` still wins.
      item = {
        ...found,
        ...data,
        id: found['id'],
        updatedAt: data['updatedAt'] ?? now,
      }
    } else {
      const id = data['id'] ?? randomUUID()
      // Same nullish-coalesce pattern as `create`: explicit values in `data`
      // win, but a payload-passed `undefined` doesn't wipe the default.
      item = {
        ...data,
        id,
        createdAt: data['createdAt'] ?? now,
        updatedAt: data['updatedAt'] ?? now,
      }
    }

    const projected = projectForCollection(this, collection, item)

    try {
      await putItem(this, partition, projected, {
        ...(found ? { replaces: found } : { mustNotExist: true }),
        collection,
      })
      return returning === false ? (null as never) : (projected as never)
    } catch (err) {
      rethrowUniqueViolation(err, collection, req)
      if (!isConditionalCheckFailed(err)) throw err
      if (attempt >= MAX_WRITE_ATTEMPTS) throw conflictError()
      await backoff(attempt)
    }
  }
}
