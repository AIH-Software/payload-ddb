import { GetCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from '../types.js'

import { batchGet } from './batchGet.js'
import { type IndexRow, latestIndexOf, pointerKey } from './fieldIndexes.js'
import { findFirst } from './findFirst.js'
import { indexPages } from './indexLookup.js'
import { isIndexReady } from './indexState.js'
import { getById } from './optimistic.js'
import { queryMatching } from './queryMatching.js'
import { stripInternalKeys } from './stripInternalKeys.js'

/**
 * Finding "the latest version" without reading every version.
 *
 * A versions partition holds every version of every document, so asking it
 * for the rows with `latest = true` means reading all of it — on each save
 * (to find the row to demote) and on each drafts listing. Instead, each
 * versioned document has one *pointer* row naming its latest version (see
 * `fieldIndexes`), kept in step by the same transaction that changes which
 * version is the latest (`putVersionAsLatest`).
 *
 * Like any index, pointers are only trusted once they are known to cover
 * every document (`indexState`); until then these helpers read the
 * partition, exactly as before.
 */

type Row = Record<string, unknown>

/**
 * What a writer saw at a document's pointer, so its write can insist the
 * pointer is still that: `owner` is the version it named, or `null` when
 * there was none. `tracked: false` means the pointers aren't complete yet
 * and can't be used as a check.
 */
export type PointerState = { key: IndexRow; owner: null | string; tracked: true } | { tracked: false }

/**
 * The row currently holding `latest = true` for `parent` (pass `undefined`
 * for a global, which has a single stream of versions).
 */
export async function findLatestVersion(
  adapter: DynamoAdapter,
  versionsPartition: string,
  parent: unknown,
): Promise<{ pointer: PointerState; previous: null | Row }> {
  const pointers = latestIndexOf(adapter, versionsPartition)

  if (!pointers || !(await isIndexReady(adapter, pointers))) {
    const previous = await findFirst(adapter, {
      partition: versionsPartition,
      where:
        parent === undefined
          ? { latest: { equals: true } }
          : { and: [{ parent: { equals: parent as never } }, { latest: { equals: true } }] },
    })
    return { pointer: { tracked: false }, previous }
  }

  const docClient = adapter.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }
  const key = { pk: pointers.partition, sk: pointerKey(parent) }
  const found = await docClient.send(
    new GetCommand({ TableName: adapter.tableName, Key: key, ConsistentRead: true }),
  )
  const owner = found.Item?.['owner'] == null ? null : String(found.Item['owner'])

  // A pointer can outlive its version (the version was deleted); then there
  // is nothing to demote, but the pointer is still what the write replaces.
  const row = owner === null ? null : await getById(adapter, versionsPartition, owner)
  return {
    pointer: { key, owner, tracked: true },
    previous: row && row['latest'] === true ? row : null,
  }
}

/**
 * Every `latest = true` row of a versions partition. `skipParents` leaves
 * out the versions of documents the caller already has.
 */
export async function latestVersionRows(
  adapter: DynamoAdapter,
  versionsPartition: string,
  skipParents?: ReadonlySet<unknown>,
): Promise<Row[]> {
  const wanted = (row: Row) => !skipParents?.has(row['parent'])
  const pointers = latestIndexOf(adapter, versionsPartition)

  if (!pointers || !(await isIndexReady(adapter, pointers))) {
    const rows = await queryMatching(adapter, versionsPartition, { latest: { equals: true } })
    return rows.filter(wanted)
  }

  const skipKeys = new Set([...(skipParents ?? [])].map(pointerKey))
  const ids: string[] = []
  for await (const page of indexPages(adapter, pointers.partition)) {
    for (const pointer of page) {
      if (pointer['owner'] != null && !skipKeys.has(String(pointer['sk']))) {
        ids.push(String(pointer['owner']))
      }
    }
  }

  const items = await batchGet(
    adapter,
    ids.map((id) => ({ pk: versionsPartition, sk: id })),
  )
  return (
    items
      .map(stripInternalKeys)
      // Re-check, as every index lookup does: the row has the final say.
      .filter((row) => row['latest'] === true && wanted(row))
      .sort((a, b) => (String(a['id']) < String(b['id']) ? -1 : 1))
  )
}
