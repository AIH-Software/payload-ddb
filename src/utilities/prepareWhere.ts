import type { FlattenedField, Sort, Where } from 'payload'

import { buildVersionCollectionFields, buildVersionGlobalFields } from 'payload'

import type { DynamoAdapter } from '../types.js'

import {
  type CastContext,
  castWhere,
  type IdType,
  type ResolvedPath,
  resolvePath,
} from './castWhere.js'
import { queryMatching } from './queryMatching.js'

/**
 * Adapter-facing entry points that turn the `where` (and `sort`) Payload
 * hands a method into what the stored rows can answer. Every method that
 * takes a `where` calls one of the `prepare*Where` functions first.
 *
 * Preparation is two passes:
 *
 *  1. **Relationship paths are resolved.** `author.name equals 'x'` can't be
 *     answered from a row that only stores the author's id, so the nested
 *     part runs as its own query against the related collection and the
 *     clause becomes `author in [matching ids]`. Multi-hop paths recurse.
 *     This is the same strategy as Payload's Mongo adapter.
 *  2. **`castWhere`** casts operands, inserts locale keys and marks paths the
 *     pushdown can't address.
 *
 * Each entry point returns `where` untouched when the slug isn't in the
 * config — same "skip, don't kill the operation" stance as `resolveSchema`.
 */

/** What a `where` is aimed at: one of the four kinds of partition. */
export type QueryTarget =
  | { kind: 'collection'; slug: string }
  | { kind: 'collectionVersions'; slug: string }
  | { kind: 'global'; slug: string }
  | { kind: 'globalVersions'; slug: string }

/** `where` in document terms, against a collection's main partition. */
export function prepareCollectionWhere(
  adapter: DynamoAdapter,
  slug: string,
  where: undefined | Where,
  locale?: string,
): Promise<undefined | Where> {
  return prepareWhere(adapter, { kind: 'collection', slug }, where, locale)
}

/** `where` against a global's singleton row. */
export function prepareGlobalWhere(
  adapter: DynamoAdapter,
  slug: string,
  where: undefined | Where,
  locale?: string,
): Promise<undefined | Where> {
  return prepareWhere(adapter, { kind: 'global', slug }, where, locale)
}

/**
 * `where` in version-row terms (`parent`, `latest`, `version.<field>`, …),
 * against the versions partition of a collection or global.
 */
export function prepareVersionsWhere(
  adapter: DynamoAdapter,
  parent: { kind: 'collection' | 'global'; slug: string },
  where: undefined | Where,
  locale?: string,
): Promise<undefined | Where> {
  return prepareWhere(
    adapter,
    { kind: parent.kind === 'collection' ? 'collectionVersions' : 'globalVersions', slug: parent.slug },
    where,
    locale,
  )
}

export async function prepareWhere(
  adapter: DynamoAdapter,
  target: QueryTarget,
  where: undefined | Where,
  locale?: string,
): Promise<undefined | Where> {
  if (!where) return where
  const ctx = contextFor(adapter, target, locale)
  if (!ctx) return where
  return castWhere(await resolveRelationshipPaths(adapter, where, ctx, locale), ctx)
}

/**
 * Give each sort key its stored path — today that means inserting the locale
 * key after a localized field, so `title` sorts by `title.en` rather than by
 * the `{ en, es }` map it lives in.
 */
export function prepareSort(
  adapter: DynamoAdapter,
  target: QueryTarget,
  sort: Sort | undefined,
  locale?: string,
): Sort | undefined {
  if (!sort) return sort
  const ctx = contextFor(adapter, target, locale)
  if (!ctx?.localization) return sort

  const localize = (key: string): string => {
    if (!key) return key
    const descending = key.startsWith('-')
    const { path } = resolvePath(ctx.fields, descending ? key.slice(1) : key, ctx.localization)
    return descending ? `-${path}` : path
  }
  return Array.isArray(sort) ? sort.map(localize) : localize(sort)
}

/**
 * Look a path up in a target's schema for this request: the field it names,
 * and the path its value is actually stored under (`title` → `title.en`).
 * For callers that read values back out of rows rather than filter on them.
 */
export function resolveStoredPath(
  adapter: DynamoAdapter,
  target: QueryTarget,
  path: string,
  locale?: string,
): ResolvedPath {
  const ctx = contextFor(adapter, target, locale)
  return ctx
    ? resolvePath(ctx.fields, path, ctx.localization)
    : { field: null, multi: false, path }
}

/** The locale a request resolves to, or `null` when localization is off. */
export function effectiveLocale(adapter: DynamoAdapter, locale?: string): null | string {
  const localization = adapter.payload?.config?.localization
  if (!localization) return null
  return locale && locale !== 'all' && locale !== '*' ? locale : localization.defaultLocale
}

// ---------------------------------------------------------------------------
// Relationship paths
// ---------------------------------------------------------------------------

type RelationshipHop = {
  /** Path of the relationship field itself, e.g. `author`. */
  prefix: string
  relationTo: string
  /** What's left to ask of the related collection, e.g. `name`. */
  rest: string
}

/**
 * Find the first point where a path steps through a relationship into the
 * related collection's own fields. Polymorphic relationships are skipped:
 * their sub-keys (`.value`, `.relationTo`) are stored on the row itself, and
 * a path through them doesn't say which collection to ask.
 */
function findRelationshipHop(fields: FlattenedField[], path: string): null | RelationshipHop {
  const segments = path.split('.')
  let current = fields

  for (let index = 0; index < segments.length - 1; index++) {
    const field = current.find((candidate) => candidate.name === segments[index])
    if (!field) return null

    if (field.type === 'relationship' || field.type === 'upload') {
      if (typeof field.relationTo !== 'string') return null
      return {
        prefix: segments.slice(0, index + 1).join('.'),
        relationTo: field.relationTo,
        rest: segments.slice(index + 1).join('.'),
      }
    }

    if ('flattenedFields' in field) {
      current = field.flattenedFields
    } else if (field.type === 'blocks') {
      current = field.blocks.flatMap((block) => block.flattenedFields)
    } else {
      return null
    }
  }

  return null
}

async function resolveRelationshipPaths(
  adapter: DynamoAdapter,
  where: Where,
  ctx: CastContext,
  locale: string | undefined,
): Promise<Where> {
  const out: Where = {}
  const resolved: Where[] = []

  for (const [key, raw] of Object.entries(where)) {
    if (key === 'and' || key === 'or') {
      out[key] = Array.isArray(raw)
        ? await Promise.all(
            raw.map((sub) =>
              sub && typeof sub === 'object'
                ? resolveRelationshipPaths(adapter, sub, ctx, locale)
                : sub,
            ),
          )
        : (raw as Where[])
      continue
    }

    const hop =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? findRelationshipHop(ctx.fields, key)
        : null
    if (!hop) {
      out[key] = raw as Where[string]
      continue
    }

    if (hop.rest === 'id') {
      // `author.id` is the value the row already stores under `author`.
      resolved.push({ [hop.prefix]: raw as Where[string] })
      continue
    }

    const related = await queryMatching(
      adapter,
      adapter.resolvePartition(hop.relationTo),
      // Preparing against the related collection is what makes multi-hop
      // paths (`author.team.name`) work: the next hop resolves there.
      await prepareCollectionWhere(
        adapter,
        hop.relationTo,
        { [hop.rest]: raw as Where[string] },
        locale,
      ),
    )
    // No matches leaves `in: []`, which both evaluators read as "match
    // nothing" — the right answer.
    resolved.push({ [hop.prefix]: { in: related.map((doc) => doc['id']) as never } })
  }

  if (resolved.length > 0) {
    // AND-ed alongside the rest, so a resolved clause can't overwrite one
    // the caller put on the relationship field directly.
    out.and = [...(Array.isArray(out.and) ? out.and : []), ...resolved]
  }
  return out
}

// ---------------------------------------------------------------------------
// Schema lookup
// ---------------------------------------------------------------------------

function idTypeOf(adapter: DynamoAdapter, collectionSlug: string): IdType {
  return adapter.payload?.collections?.[collectionSlug]?.customIDType ?? adapter.defaultIDType
}

function contextFor(
  adapter: DynamoAdapter,
  target: QueryTarget,
  locale: string | undefined,
): CastContext | null {
  const fields = fieldsFor(adapter, target)
  if (!fields) return null

  const localization = adapter.payload.config.localization
  return {
    fields,
    // Only a collection's own rows can have numeric ids; globals are keyed
    // by slug and version rows by UUIDs the adapter generates.
    idType: target.kind === 'collection' ? idTypeOf(adapter, target.slug) : 'text',
    idTypeOf: (related) => idTypeOf(adapter, related),
    ...(localization
      ? {
          localization: {
            // `all` / `*` ask for every locale at once, which a single stored
            // path can't express; fall back to the default like a missing one.
            locale: effectiveLocale(adapter, locale) ?? localization.defaultLocale,
            localeCodes: localization.localeCodes,
          },
        }
      : {}),
  }
}

const versionFieldsCache = new WeakMap<DynamoAdapter, Map<string, FlattenedField[]>>()

function fieldsFor(adapter: DynamoAdapter, target: QueryTarget): FlattenedField[] | null {
  const config = adapter.payload?.config
  if (!config) return null

  const collection = () => adapter.payload.collections?.[target.slug]?.config
  const global = () => config.globals?.find((candidate) => candidate.slug === target.slug)

  switch (target.kind) {
    case 'collection':
      return collection()?.flattenedFields ?? null
    case 'global':
      return global()?.flattenedFields ?? null
    default: {
      // Version-row fields are derived, so build them once per slug.
      let cache = versionFieldsCache.get(adapter)
      if (!cache) {
        cache = new Map()
        versionFieldsCache.set(adapter, cache)
      }
      const cacheKey = `${target.kind}:${target.slug}`
      const cached = cache.get(cacheKey)
      if (cached) return cached

      let fields: FlattenedField[] | null = null
      if (target.kind === 'collectionVersions') {
        const entity = collection()
        if (entity) fields = buildVersionCollectionFields(config, entity, true)
      } else {
        const entity = global()
        if (entity) fields = buildVersionGlobalFields(config, entity, true)
      }
      if (fields) cache.set(cacheKey, fields)
      return fields
    }
  }
}
