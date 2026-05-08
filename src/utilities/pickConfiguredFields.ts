import type { Field, FlattenedField } from 'payload'

import { flattenTopLevelFields } from 'payload'

import { ROW_RESERVED_KEYS, VERSION_ROW_RESERVED_KEYS } from './resolveSchema.js'

/**
 * Project an arbitrary `data` object onto the keys declared by a Payload
 * collection or global's `fields` config, recursively. Mongoose's `strict`
 * mode and Drizzle's column allow-list give the other adapters this behavior
 * for free; DynamoDB has no schema layer, so without this projection any
 * stray request-body field rides into the row verbatim. Most visibly,
 * registration-form `confirm-password` would persist alongside the auth
 * collection's actual fields and surface back through `/api/users/me` —
 * leaking a plaintext credential.
 *
 * Allowed top-level keys at each level are derived from
 * `flattenTopLevelFields`, which already inlines unnamed containers (row,
 * collapsible, unnamed tabs) and drops `ui` fields. We additionally skip
 * `join` (read-side virtual relation, never persisted) and recurse into
 * named containers (`group`, `tab`, `array`, `blocks`).
 *
 * `localized: true` short-circuits recursion: persisted localized values are
 * `{ [locale]: value }` maps and we don't introspect locale codes here.
 * Top-level allow-listing still drops the unknown sibling fields the bug
 * actually surfaces.
 *
 * Reserved keys passed via `extraAllowed` (e.g. `id`, `createdAt`,
 * `updatedAt`, `_status`) are passed through unchanged. They aren't always
 * declared in `fields` but are owned by Payload's framework layer.
 */

const PRESENTATIONAL_OR_VIRTUAL = new Set(['ui', 'join'])

export function pickConfiguredFields(
  data: Record<string, unknown>,
  fields: Field[],
  extraAllowed: readonly string[] = [],
): Record<string, unknown> {
  return pickAtLevel(data, fields, extraAllowed) as Record<string, unknown>
}

function pickAtLevel(
  data: unknown,
  fields: Field[],
  extraAllowed: readonly string[] = [],
): unknown {
  if (!isPlainRecord(data)) return data

  const out: Record<string, unknown> = {}

  for (const key of extraAllowed) {
    if (key in data) out[key] = data[key]
  }

  for (const field of flattenTopLevelFields(fields) as FlattenedField[]) {
    if (PRESENTATIONAL_OR_VIRTUAL.has(field.type)) continue
    const name = (field as { name?: string }).name
    if (!name || !(name in data)) continue

    const value = data[name]

    // Localized values are `{ locale: value }` maps; we don't recurse into
    // locale codes. Top-level field name is allow-listed, which is what
    // closes the credential-leak class.
    if ((field as { localized?: boolean }).localized) {
      out[name] = value
      continue
    }

    if (field.type === 'group' || field.type === 'tab') {
      out[name] = pickAtLevel(value, field.fields ?? [])
    } else if (field.type === 'array') {
      out[name] = pickArrayItems(value, field.fields ?? [])
    } else if (field.type === 'blocks') {
      out[name] = pickBlockItems(value, field.blocks ?? [])
    } else {
      out[name] = value
    }
  }

  return out
}

function pickArrayItems(value: unknown, fields: Field[]): unknown {
  if (!Array.isArray(value)) return value
  return value.map((item) => {
    if (!isPlainRecord(item)) return item
    // Array items get an auto-generated `id` from Payload that isn't in `fields`.
    return pickAtLevel(item, fields, ['id']) as Record<string, unknown>
  })
}

function pickBlockItems(
  value: unknown,
  blocks: { slug: string; fields: Field[] }[],
): unknown {
  if (!Array.isArray(value)) return value
  const bySlug = new Map(blocks.map((b) => [b.slug, b]))
  return value.map((item) => {
    if (!isPlainRecord(item)) return item
    const blockType = item['blockType']
    const block = typeof blockType === 'string' ? bySlug.get(blockType) : undefined
    // Unknown blockType: pass through. Mirrors Mongo's behavior — a stale
    // blockType lingering in data after a config change shouldn't be
    // silently nuked by the adapter.
    if (!block) return item
    return pickAtLevel(item, block.fields ?? [], ['id', 'blockType']) as Record<string, unknown>
  })
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
}

/**
 * Strip a version row to its declared shape. Allow-lists Payload's
 * version-row metadata (`parent`, `latest`, `autosave`, etc.) and recurses
 * into the inner `version` snapshot against the parent collection/global's
 * own fields.
 */
export function pickConfiguredVersionRow(
  row: Record<string, unknown>,
  parentFields: Field[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of VERSION_ROW_RESERVED_KEYS) {
    if (key in row) out[key] = row[key]
  }
  if (isPlainRecord(out['version'])) {
    out['version'] = pickConfiguredFields(out['version'], parentFields, ROW_RESERVED_KEYS)
  }
  return out
}
