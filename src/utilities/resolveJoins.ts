import type { JoinQuery, SanitizedJoins, Where } from 'payload'

import { fieldShouldBeLocalized } from 'payload/shared'

import type { DynamoAdapter } from '../types.js'

import { applySorts } from './applySorts.js'
import { candidatesAt } from './matchesWhere.js'
import {
  effectiveLocale,
  prepareCollectionWhere,
  prepareSort,
  resolveStoredPath,
} from './prepareWhere.js'
import { queryMatching } from './queryMatching.js'

type SanitizedJoin = SanitizedJoins[string][number]

/**
 * Fill in `join` fields on documents that have just been read.
 *
 * A join field stores nothing on its own document: `category.posts` is
 * "every post whose `category` points at this category". Payload hands the
 * adapter the joins it wants (`joins`, keyed by join path) and expects each
 * document to come back with
 *
 *     { docs: [...ids], hasNextPage: boolean, totalDocs?: number }
 *
 * at that path — ids only; core populates them to the requested depth. For a
 * polymorphic join (`collection: [...]`) each entry is
 * `{ relationTo, value }` instead.
 *
 * Strategy, following the JS join resolution in Payload's Mongo adapter: one
 * query per target collection for *all* parents at once (`on in [parent
 * ids]`, AND-ed with the join's own `where`), then group the results by
 * parent in memory. Sorting, paging and counting are done per parent, so
 * `limit` means "this many per document", as it does with the other
 * adapters' native joins.
 *
 * Only joins named in `joins` with a truthy value run; `joins: false` and
 * `joins[path]: false` leave documents untouched. Joined documents are read
 * from the target's main partition — drafts that were never published are
 * not included.
 *
 * Mutates `docs` in place.
 */
export async function resolveJoins(
  adapter: DynamoAdapter,
  args: {
    collectionSlug: string
    docs: Record<string, unknown>[]
    joins: JoinQuery | undefined
    locale?: string | undefined
  },
): Promise<void> {
  const { collectionSlug, docs, joins, locale } = args
  if (!joins || docs.length === 0) return

  const collectionConfig = adapter.payload?.collections?.[collectionSlug]?.config
  if (!collectionConfig) return

  const definitions = new Map<string, { join: SanitizedJoin; targets: string[] }>()
  for (const [target, list] of Object.entries(collectionConfig.joins ?? {})) {
    for (const join of list) definitions.set(join.joinPath, { join, targets: [target] })
  }
  for (const join of collectionConfig.polymorphicJoins ?? []) {
    const { collection } = join.field
    definitions.set(join.joinPath, {
      join,
      targets: Array.isArray(collection) ? collection : [collection],
    })
  }

  const parentIds = docs.map((doc) => doc['id'])
  const parentKeys = new Set(parentIds.map(String))

  for (const [joinPath, joinQuery] of Object.entries(joins as Record<string, unknown>)) {
    if (!joinQuery || typeof joinQuery !== 'object') continue
    const definition = definitions.get(joinPath)
    if (!definition) continue

    const { join } = definition
    const query = joinQuery as {
      count?: boolean
      limit?: number
      page?: number
      sort?: string
      where?: Where
    }
    const polymorphicJoin = Array.isArray(join.field.collection)
    const limit = query.limit ?? join.field.defaultLimit ?? 10
    const skip = (Math.max(1, query.page ?? 1) - 1) * limit

    const { targets, where: joinWhere } = polymorphicJoin
      ? narrowTargets(definition.targets, query.where)
      : { targets: definition.targets, where: query.where }

    // parent key → joined rows, in the order the targets were read.
    const grouped = new Map<string, { relationTo: string; row: Record<string, unknown> }[]>()

    for (const target of targets) {
      const targetConfig = adapter.payload.collections?.[target]?.config
      if (!targetConfig) continue

      const on = join.field.on
      // Look the `on` field up on each target: a polymorphic join has no
      // single target field, and the path may need a locale key.
      const stored = resolveStoredPath(adapter, { kind: 'collection', slug: target }, on, locale)
      const polymorphicTarget =
        stored.field !== null &&
        'relationTo' in stored.field &&
        Array.isArray(stored.field.relationTo)
      const pointsAtParents: Where = polymorphicTarget
        ? {
            [`${on}.relationTo`]: { equals: collectionSlug },
            [`${on}.value`]: { in: parentIds as never },
          }
        : { [on]: { in: parentIds as never } }

      const rows = await queryMatching(
        adapter,
        adapter.resolvePartition(target),
        await prepareCollectionWhere(
          adapter,
          target,
          joinWhere ? { and: [joinWhere, pointsAtParents] } : pointsAtParents,
          locale,
        ),
      )

      const sort =
        query.sort || join.field.defaultSort || targetConfig.defaultSort || '-createdAt'
      applySorts(rows, prepareSort(adapter, { kind: 'collection', slug: target }, sort, locale))

      for (const row of rows) {
        // A hasMany `on` field can name several parents; a row joins each of
        // them once.
        const owners = new Set<string>()
        for (const candidate of candidatesAt(row, stored.path)) {
          const key = ownerKey(candidate, collectionSlug)
          if (key !== null && parentKeys.has(key)) owners.add(key)
        }
        for (const key of owners) {
          const list = grouped.get(key) ?? []
          list.push({ relationTo: target, row })
          grouped.set(key, list)
        }
      }
    }

    const joinLocale =
      fieldShouldBeLocalized({ field: join.field, parentIsLocalized: join.parentIsLocalized }) &&
      effectiveLocale(adapter, locale)
    const writePath = joinLocale ? `${joinPath}.${joinLocale}` : joinPath

    for (const doc of docs) {
      const all = grouped.get(String(doc['id'])) ?? []
      const page = limit === 0 ? all : all.slice(skip, skip + limit)
      setByPath(doc, writePath, {
        docs: page.map(({ relationTo, row }) =>
          polymorphicJoin ? { relationTo, value: row['id'] } : row['id'],
        ),
        hasNextPage: limit !== 0 && all.length > skip + page.length,
        ...(query.count ? { totalDocs: all.length } : {}),
      })
    }
  }
}

/**
 * The parent a stored `on` value points at, as a string key: a bare id, or
 * the `value` of a polymorphic `{ relationTo, value }` aimed at this
 * collection. `null` for anything else.
 */
function ownerKey(candidate: unknown, collectionSlug: string): null | string {
  if (typeof candidate === 'string' || typeof candidate === 'number') return String(candidate)
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const { relationTo, value } = candidate as { relationTo?: unknown; value?: unknown }
    if (relationTo === collectionSlug && (typeof value === 'string' || typeof value === 'number')) {
      return String(value)
    }
  }
  return null
}

/**
 * A polymorphic join's `where` may carry a top-level `relationTo` clause to
 * pick which target collections to read. It isn't a field on the targets, so
 * lift it out and return the rest.
 */
function narrowTargets(
  targets: string[],
  where: undefined | Where,
): { targets: string[]; where: undefined | Where } {
  const clause = where?.['relationTo']
  if (!where || !clause || typeof clause !== 'object' || Array.isArray(clause)) {
    return { targets, where }
  }
  const { equals, in: within } = clause as { equals?: unknown; in?: unknown }
  const wanted = Array.isArray(within) ? within : equals !== undefined ? [equals] : null
  const { relationTo: _relationTo, ...rest } = where
  return {
    targets: wanted ? targets.filter((target) => wanted.includes(target)) : targets,
    where: Object.keys(rest).length > 0 ? (rest as Where) : undefined,
  }
}

function setByPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.')
  let cursor = target
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cursor[segment] = {}
    }
    cursor = cursor[segment] as Record<string, unknown>
  }
  cursor[segments[segments.length - 1]!] = value
}
