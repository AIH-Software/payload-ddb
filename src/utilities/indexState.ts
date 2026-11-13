import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from '../types.js'

import { collectionPartitionOf, type FieldIndex, indexedCollections } from './fieldIndexes.js'

/**
 * Which indexes are *complete* — safe to answer lookups from.
 *
 * Index rows and unique guards are written with every document, but
 * documents stored before an index existed have none. A lookup through an
 * index that misses some documents would silently drop them, so an index is
 * only used once it carries a marker row saying every document is in it:
 *
 *     pk = "payload-ddb#indexes"
 *     sk = "<the index's partition>"
 *
 * Markers come from two places:
 *
 *  - **An empty collection.** With no documents there is nothing to miss,
 *    and every document written from then on carries its rows. Checked when
 *    the adapter starts, which covers new tables and new collections.
 *  - **`backfillIndexes`.** Builds the rows for existing documents, then
 *    marks the index.
 *
 * Without a marker the adapter still maintains the index on every write; it
 * just keeps reading the partition for lookups. A marker whose field is no
 * longer indexed — the flag was dropped, or `indexes` is off — is removed,
 * because nothing keeps that index current any more and re-adding it later
 * has to start over. Markers of collections this config doesn't know are
 * left alone: they belong to someone else sharing the table.
 *
 * Markers are read once per process and re-read at most once a minute while
 * a lookup wants an index that isn't ready, so a backfill run elsewhere is
 * picked up without a restart.
 */

const STATE_PARTITION = 'payload-ddb#indexes'
const REFRESH_MS = 60_000

type State = { loadedAt: number; ready: Set<string> }

const states = new WeakMap<DynamoAdapter, { current?: State; loading?: Promise<State> }>()
const announced = new WeakMap<DynamoAdapter, Set<string>>()

function slot(adapter: DynamoAdapter) {
  let entry = states.get(adapter)
  if (!entry) {
    entry = {}
    states.set(adapter, entry)
  }
  return entry
}

function requireDocClient(adapter: DynamoAdapter) {
  const docClient = adapter.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }
  return docClient
}

async function readMarkers(adapter: DynamoAdapter): Promise<Set<string>> {
  const docClient = requireDocClient(adapter)
  const ready = new Set<string>()
  let exclusiveStartKey: Record<string, unknown> | undefined

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: adapter.tableName,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'pk' },
        ExpressionAttributeValues: { ':pk': STATE_PARTITION },
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    )
    for (const item of result.Items ?? []) ready.add(String(item['sk']))
    exclusiveStartKey = result.LastEvaluatedKey
  } while (exclusiveStartKey)

  return ready
}

async function isEmpty(adapter: DynamoAdapter, partition: string): Promise<boolean> {
  const result = await requireDocClient(adapter).send(
    new QueryCommand({
      TableName: adapter.tableName,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': partition },
      ConsistentRead: true,
      Limit: 1,
      Select: 'COUNT',
    }),
  )
  return (result.Count ?? 0) === 0 && !result.LastEvaluatedKey
}

async function writeMarkers(adapter: DynamoAdapter, partitions: string[]): Promise<void> {
  const docClient = requireDocClient(adapter)
  const builtAt = new Date().toISOString()
  await Promise.all(
    partitions.map((partition) =>
      docClient.send(
        new PutCommand({
          TableName: adapter.tableName,
          Item: { pk: STATE_PARTITION, sk: partition, builtAt },
        }),
      ),
    ),
  )
}

async function load(adapter: DynamoAdapter): Promise<State> {
  const docClient = requireDocClient(adapter)
  const ready = await readMarkers(adapter)
  const collections = indexedCollections(adapter)

  // Markers for fields of our collections that are no longer indexed:
  // nothing keeps those indexes up to date any more, so they must not
  // survive a re-add.
  const configured = new Set(
    collections.flatMap(({ indexes }) => indexes.map((index) => index.partition)),
  )
  const stale = [...ready].filter(
    (partition) => !configured.has(partition) && collectionPartitionOf(adapter, partition) !== null,
  )
  await Promise.all(
    stale.map((partition) =>
      docClient.send(
        new DeleteCommand({
          TableName: adapter.tableName,
          Key: { pk: STATE_PARTITION, sk: partition },
        }),
      ),
    ),
  )
  for (const partition of stale) ready.delete(partition)

  for (const { indexes, partition, slug } of collections) {
    const missing = indexes.filter((index) => !ready.has(index.partition))
    if (missing.length === 0) continue

    if (await isEmpty(adapter, partition)) {
      const partitions = missing.map((index) => index.partition)
      await writeMarkers(adapter, partitions)
      for (const built of partitions) ready.add(built)
      continue
    }

    let told = announced.get(adapter)
    if (!told) {
      told = new Set()
      announced.set(adapter, told)
    }
    if (!told.has(slug)) {
      told.add(slug)
      adapter.payload.logger.info(
        `payload-ddb: ${missing.length} index(es) on "${slug}" (${missing
          .map((index) => index.path)
          .join(', ')}) aren't built for its existing documents, so lookups on them read the ` +
          'whole partition. Run `backfillIndexes(payload)` once to build them.',
      )
    }
  }

  return { loadedAt: Date.now(), ready }
}

function refresh(adapter: DynamoAdapter): Promise<State> {
  const entry = slot(adapter)
  if (!entry.loading) {
    entry.loading = load(adapter)
      .then((state) => {
        entry.current = state
        return state
      })
      .finally(() => {
        delete entry.loading
      })
  }
  return entry.loading
}

/**
 * Read the markers at startup and mark the indexes of empty collections.
 * Never throws: if the table can't be read yet, lookups simply stay on the
 * partition and the state is loaded on demand later.
 */
export async function prepareIndexState(adapter: DynamoAdapter): Promise<void> {
  // Even with nothing indexed there may be markers to retire (`indexes` was
  // just turned off), so the state is read regardless — unless the adapter
  // has no collections at all.
  if (!adapter.payload?.config?.collections?.length) return
  try {
    await refresh(adapter)
  } catch (err) {
    adapter.payload.logger.warn(
      `payload-ddb: could not read index state (${
        err instanceof Error ? err.message : String(err)
      }); lookups will read partitions until it can.`,
    )
  }
}

/** Whether `index` is complete and may answer lookups. */
export async function isIndexReady(adapter: DynamoAdapter, index: FieldIndex): Promise<boolean> {
  const entry = slot(adapter)
  try {
    let state = entry.current ?? (await refresh(adapter))
    if (!state.ready.has(index.partition) && Date.now() - state.loadedAt > REFRESH_MS) {
      state = await refresh(adapter)
    }
    return state.ready.has(index.partition)
  } catch {
    // Remember the failure for a while so every lookup doesn't retry it.
    entry.current ??= { loadedAt: Date.now(), ready: new Set() }
    entry.current.loadedAt = Date.now()
    return false
  }
}

/** Record that these indexes now cover every document (used by the backfill). */
export async function markIndexesReady(adapter: DynamoAdapter, partitions: string[]): Promise<void> {
  if (partitions.length === 0) return
  await writeMarkers(adapter, partitions)
  const state = slot(adapter).current
  if (state) for (const partition of partitions) state.ready.add(partition)
}
