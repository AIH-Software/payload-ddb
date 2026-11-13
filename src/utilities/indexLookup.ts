import type { Where } from 'payload'

import { QueryCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from '../types.js'

import { batchGet } from './batchGet.js'
import { type FieldIndex, indexesOf, indexValueKey } from './fieldIndexes.js'
import { isIndexReady } from './indexState.js'
import { mapWithConcurrency } from './mapWithConcurrency.js'
import { matchesWhere } from './matchesWhere.js'
import { stripInternalKeys } from './stripInternalKeys.js'
import { encodeValue } from './uniqueGuards.js'

/**
 * Answer a `where` without reading the whole partition, when one of its
 * AND-ed clauses pins the documents down by key:
 *
 *  - `id equals / in` — the ids *are* the row keys;
 *  - `equals / in` on a `unique: true` field — one guard row per value names
 *    the document (`uniqueGuards`);
 *  - `equals / in` on an `index: true` field — the index rows under each
 *    value name the documents (`fieldIndexes`).
 *
 * The clause only produces *candidate* ids. The documents are then read by
 * key and the full `where` is evaluated on each with `matchesWhere`, so the
 * remaining clauses are honoured and a stale index row can't add a result.
 * Every read is strongly consistent, and index rows are written in the same
 * transaction as their document, so the answer is the one a partition read
 * would have given.
 *
 * Returns `null` when no clause qualifies, the index isn't complete yet
 * (`indexState`), or the clause matches so many documents that reading the
 * partition is the better deal — the caller then reads the partition.
 */

/**
 * Past this many candidates a lookup gives up. Reading documents one key at
 * a time is billed per document (at least one read unit each), while a
 * partition read is billed by size — so for a clause that matches a large
 * share of a partition the lookup would cost more, not less.
 */
export const INDEX_LOOKUP_LIMIT = 256

/** An `in` list on an index-row field costs one `Query` per value. */
const MAX_PREFIX_QUERIES = 100
const QUERY_CONCURRENCY = 10

type Row = Record<string, unknown>
type Key = number | string
type Clause = { equals: boolean; path: string; values: Key[] }
type Plan = Clause & { index: FieldIndex | null; rank: number }

const isKey = (value: unknown): value is Key =>
  (typeof value === 'string' && value !== '') ||
  (typeof value === 'number' && Number.isFinite(value))

/** Collect the `equals` / `in` clauses every matching document must satisfy. */
function keyClauses(where: Where, out: Clause[]): void {
  for (const [key, raw] of Object.entries(where)) {
    if (key === 'and' || key === 'or') {
      if (!Array.isArray(raw)) continue
      // Every branch of an `and` constrains the result; an `or` only does
      // when it has a single branch.
      if (key === 'or' && raw.length !== 1) continue
      for (const sub of raw) {
        if (sub && typeof sub === 'object') keyClauses(sub, out)
      }
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue

    const operators = raw as Record<string, unknown>
    const list = operators['in']
    if (isKey(operators['equals'])) {
      out.push({ equals: true, path: key, values: [operators['equals']] })
    } else if (Array.isArray(list) && list.length > 0 && list.every(isKey)) {
      out.push({ equals: false, path: key, values: [...new Set(list)] })
    }
  }
}

/** Cheapest first: fewer round trips, then fewer candidates. */
function rank(clause: Clause, index: FieldIndex | null): number {
  if (!index) return clause.equals ? 0 : 2
  if (index.kind === 'unique') return clause.equals ? 1 : 4
  return clause.equals ? 3 : 5
}

export async function findByIndex(
  adapter: DynamoAdapter,
  partition: string,
  where: undefined | Where,
): Promise<null | Row[]> {
  if (!where) return null

  const clauses: Clause[] = []
  keyClauses(where, clauses)
  if (clauses.length === 0) return null

  const indexes = indexesOf(adapter, partition)
  const plans: Plan[] = []
  for (const clause of clauses) {
    const index = clause.path === 'id' ? null : indexes?.get(clause.path)
    if (index === undefined) continue
    plans.push({ ...clause, index, rank: rank(clause, index) })
  }
  plans.sort((a, b) => a.rank - b.rank || a.values.length - b.values.length)

  for (const plan of plans) {
    const ids = await candidateIds(adapter, plan)
    if (ids === null) continue

    const items = await batchGet(
      adapter,
      ids.map((id) => ({ pk: partition, sk: id })),
    )
    const rows = items.map(stripInternalKeys).filter((row) => matchesWhere(row, where))
    // A partition read returns rows in key order; keep that, so callers that
    // take "the first match" get the same one either way.
    return rows.sort((a, b) => compareKeys(String(a['id']), String(b['id'])))
  }

  return null
}

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The sort keys of the documents a plan's clause can match, or `null` to pass. */
async function candidateIds(adapter: DynamoAdapter, plan: Plan): Promise<null | string[]> {
  const { index, values } = plan

  if (!index) {
    return values.length > INDEX_LOOKUP_LIMIT ? null : values.map(String)
  }
  if (!(await isIndexReady(adapter, index))) return null

  if (index.kind === 'unique') {
    if (values.length > INDEX_LOOKUP_LIMIT) return null
    const guards = await batchGet(
      adapter,
      values.map((value) => ({ pk: index.partition, sk: encodeValue(value)! })),
    )
    return owners(guards)
  }

  if (values.length > MAX_PREFIX_QUERIES) return null
  const found = new Set<string>()
  let tooMany = false
  await mapWithConcurrency(values, QUERY_CONCURRENCY, async (value) => {
    for await (const page of prefixPages(adapter, index.partition, `${indexValueKey(value)!}#`)) {
      if (tooMany) return
      for (const owner of owners(page)) found.add(owner)
      if (found.size > INDEX_LOOKUP_LIMIT) {
        tooMany = true
        return
      }
    }
  })
  return tooMany ? null : [...found]
}

const owners = (items: Row[]): string[] => [
  ...new Set(items.map((item) => item['owner']).filter((owner) => owner != null).map(String)),
]

/** Page through the rows of `partition` whose sort key starts with `prefix`. */
async function* prefixPages(
  adapter: DynamoAdapter,
  partition: string,
  prefix: string,
): AsyncGenerator<Row[]> {
  const docClient = adapter.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  let exclusiveStartKey: Record<string, unknown> | undefined
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: adapter.tableName,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
        ExpressionAttributeNames: { '#owner': 'owner', '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: { ':pk': partition, ':prefix': prefix },
        ProjectionExpression: '#owner',
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    )
    yield result.Items ?? []
    exclusiveStartKey = result.LastEvaluatedKey
  } while (exclusiveStartKey)
}
