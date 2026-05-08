import type { Payload, SanitizedGlobalConfig } from 'payload'

import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from '../types.js'

import {
  pickConfiguredFields,
  pickConfiguredVersionRow,
} from './pickConfiguredFields.js'
import { ROW_RESERVED_KEYS } from './resolveSchema.js'
import { stripInternalKeys } from './stripInternalKeys.js'

/**
 * One-shot cleanup pass for rows that were written before write-time
 * projection landed. Walks every collection, global, and versions partition
 * the adapter knows about, applies the same projection that today's writes
 * use, and re-`Put`s rows that changed. Rows whose contents are already
 * clean stay untouched.
 *
 * Intended to be called once after upgrading; not on every boot. The
 * adapter's regular write paths now project on every mutation, so once a
 * row has been written under the new code it stays clean. This helper
 * exists for the static legacy data that hasn't been touched since the bug
 * was active.
 *
 * @example
 *   import { getPayload } from 'payload'
 *   import config from './payload.config'
 *   import { scrubUnknownFields } from '@aih-software/payload-ddb'
 *
 *   const payload = await getPayload({ config })
 *   const report = await scrubUnknownFields(payload)
 *   console.log(report)
 *   await payload.destroy()
 */
export interface ScrubReport {
  collections: Record<string, { scanned: number; modified: number }>
  collectionVersions: Record<string, { scanned: number; modified: number }>
  globals: Record<string, { scanned: number; modified: number }>
  globalVersions: Record<string, { scanned: number; modified: number }>
}

export async function scrubUnknownFields(payload: Payload): Promise<ScrubReport> {
  const adapter = payload.db as DynamoAdapter
  if (!adapter.docClient) {
    throw new Error('payload-ddb: scrubUnknownFields requires a connected adapter.')
  }

  const report: ScrubReport = {
    collections: {},
    collectionVersions: {},
    globals: {},
    globalVersions: {},
  }

  const collections = adapter.payload?.collections ?? {}
  for (const [slug, collection] of Object.entries(collections)) {
    const fields = collection.config.fields
    report.collections[slug] = await scrubPartition(
      adapter,
      adapter.resolvePartition(slug),
      (row) => pickConfiguredFields(row, fields, ROW_RESERVED_KEYS),
    )

    if (collection.config.versions) {
      report.collectionVersions[slug] = await scrubPartition(
        adapter,
        adapter.resolveVersionsPartition(slug),
        (row) => pickConfiguredVersionRow(row, fields),
      )
    }
  }

  const globals: SanitizedGlobalConfig[] = adapter.payload?.config?.globals ?? []
  for (const global of globals) {
    const fields = global.fields
    report.globals[global.slug] = await scrubPartition(
      adapter,
      adapter.resolvePartition(global.slug),
      (row) => pickConfiguredFields(row, fields, ROW_RESERVED_KEYS),
    )

    if (global.versions) {
      report.globalVersions[global.slug] = await scrubPartition(
        adapter,
        adapter.resolveVersionsPartition(global.slug),
        (row) => pickConfiguredVersionRow(row, fields),
      )
    }
  }

  return report
}

async function scrubPartition(
  adapter: DynamoAdapter,
  partition: string,
  project: (row: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ scanned: number; modified: number }> {
  let scanned = 0
  let modified = 0
  let exclusiveStartKey: Record<string, unknown> | undefined

  do {
    const result = await adapter.docClient!.send(
      new QueryCommand({
        TableName: adapter.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': partition },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    )

    for (const item of result.Items ?? []) {
      scanned++
      const sansInternal = stripInternalKeys(item)
      const projected = project(sansInternal)
      if (stableStringify(sansInternal) !== stableStringify(projected)) {
        // Re-attach pk/sk explicitly. They aren't part of the projection's
        // domain (those keys are adapter-internal partition coordinates),
        // and their values must come from the original item to keep the
        // row addressable at the same key.
        await adapter.docClient!.send(
          new PutCommand({
            TableName: adapter.tableName,
            Item: { ...projected, pk: item['pk'], sk: item['sk'] },
          }),
        )
        modified++
      }
    }

    exclusiveStartKey = result.LastEvaluatedKey
  } while (exclusiveStartKey)

  return { scanned, modified }
}

/**
 * Sorted-key JSON serialization for stable deep equality. The projection
 * drops keys at any depth (nested groups, array items, blocks), so a
 * top-level key compare wouldn't detect leaks buried inside a `meta` or
 * `tags` field. Sort keys before stringifying so insertion-order
 * differences between the original row and the freshly-built projection
 * don't register as a false-positive diff.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`
}
