import type { Where } from 'payload'

import { QueryCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from '../types.js'

import { batchGet } from './batchGet.js'
import {
  type FieldIndex,
  indexesOf,
  isTruncatedKey,
  keyOfRow,
  NO_VALUE_KEY,
  valueKey,
} from './fieldIndexes.js'
import { getByPath } from './getByPath.js'
import { isIndexReady } from './indexState.js'
import { mapWithConcurrency } from './mapWithConcurrency.js'
import { matchesWhere } from './matchesWhere.js'
import { stripInternalKeys } from './stripInternalKeys.js'
import { encodeValue } from './uniqueGuards.js'

/**
 * Answer a `where` without reading the whole partition, when one of its
 * AND-ed clauses pins the rows down by key:
 *
 *  - `id equals / in` — the ids *are* the row keys;
 *  - `equals / in` on a `unique: true` field — one guard row per value names
 *    the document (`uniqueGuards`);
 *  - `equals / in` on an indexed field — the index rows under each value
 *    name the documents (`fieldIndexes`);
 *  - `greater_than(_equal) / less_than(_equal)` on an indexed field — index
 *    rows are in value order, so the range is one stretch of them;
 *  - an `or` whose every branch has such a clause — the candidates are the
 *    union of the branches'. This is how Payload looks an upload up by
 *    filename: `filename` or any of the image sizes' filenames.
 *
 * The clause only produces *candidate* ids. The rows are then read by key
 * and the full `where` is evaluated on each with `matchesWhere`, so the
 * remaining clauses are honoured and a stale index row can't add a result.
 * Every read is strongly consistent, and index rows are written in the same
 * transaction as their row, so the answer is the one a partition read would
 * have given.
 *
 * Returns `null` when no clause qualifies, the index isn't complete yet
 * (`indexState`), or the clause matches so many rows that reading the
 * partition is the better deal — the caller then reads the partition.
 */

/**
 * Past this many candidates a lookup gives up. Reading rows one key at a
 * time is billed per row (at least one read unit each), while a partition
 * read is billed by size — so for a clause that matches a large share of a
 * partition the lookup would cost more, not less.
 */
export const INDEX_LOOKUP_LIMIT = 256

/** An `in` list on an index-row field costs one `Query` per value. */
const MAX_PREFIX_QUERIES = 100
/** Each branch of an `or` costs at least one round trip of its own. */
const MAX_OR_BRANCHES = 25
const QUERY_CONCURRENCY = 10

type Row = Record<string, unknown>
type Key = number | string
type Bound = { inclusive: boolean; value: Key }
type FieldClause =
  | { kind: 'keys'; equals: boolean; path: string; values: Key[] }
  | { kind: 'range'; lower?: Bound; path: string; upper?: Bound }
/** `any`: an `or` — a row has to satisfy at least one of the branches. */
type Clause = FieldClause | { branches: Where[]; kind: 'any' }
type Plan =
  | { clause: Extract<Clause, { kind: 'any' }>; rank: number }
  | { clause: FieldClause; index: FieldIndex | null; rank: number }

/** A filter operand as the stored value it is compared against. */
function asKey(value: unknown): Key | null {
  // Dates are stored as ISO strings (`normalizeForDynamo`).
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (typeof value === 'string') return value === '' ? null : value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  return null
}

const RANGE_OPERATORS = ['greater_than', 'greater_than_equal', 'less_than', 'less_than_equal']

/** The range a clause's comparison operators describe, if they describe one. */
function rangeOf(operators: Record<string, unknown>): null | { lower?: Bound; upper?: Bound } {
  const present = RANGE_OPERATORS.filter((operator) => operator in operators)
  if (present.length === 0) return null

  const bound = (strict: string, loose: string): Bound | null | undefined => {
    // Both forms on one side is legal but rare; leave it to the partition.
    if (strict in operators && loose in operators) return null
    const operator = strict in operators ? strict : loose in operators ? loose : undefined
    if (!operator) return undefined
    const value = asKey(operators[operator])
    return value === null ? null : { inclusive: operator === loose, value }
  }
  const lower = bound('greater_than', 'greater_than_equal')
  const upper = bound('less_than', 'less_than_equal')
  if (lower === null || upper === null) return null
  // DynamoDB never orders a number against a string; neither does the index.
  if (lower && upper && typeof lower.value !== typeof upper.value) return null
  return { ...(lower ? { lower } : {}), ...(upper ? { upper } : {}) }
}

/** Collect the clauses every matching row must satisfy. */
function keyClauses(where: Where, out: Clause[]): void {
  for (const [key, raw] of Object.entries(where)) {
    if (key === 'and' || key === 'or') {
      if (!Array.isArray(raw)) continue
      // Every branch of an `and` constrains the result, and so does the one
      // branch of a single-branch `or`. A real `or` constrains it as a
      // whole: each row matches some branch.
      if (key === 'or' && raw.length > 1) {
        if (raw.every((sub) => sub && typeof sub === 'object')) {
          out.push({ branches: raw, kind: 'any' })
        }
        continue
      }
      for (const sub of raw) {
        if (sub && typeof sub === 'object') keyClauses(sub, out)
      }
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue

    const operators = raw as Record<string, unknown>
    const single = asKey(operators['equals'])
    const list = Array.isArray(operators['in']) ? operators['in'].map(asKey) : null
    if (single !== null) {
      out.push({ equals: true, kind: 'keys', path: key, values: [single] })
    } else if (list && list.length > 0 && list.every((value) => value !== null)) {
      out.push({ equals: false, kind: 'keys', path: key, values: [...new Set(list as Key[])] })
    }

    const range = rangeOf(operators)
    if (range) out.push({ kind: 'range', path: key, ...range })
  }
}

/** Cheapest first: fewer round trips, then fewer candidates. */
function rank(clause: FieldClause, index: FieldIndex | null): number {
  if (clause.kind === 'range') return 6
  if (!index) return clause.equals ? 0 : 2
  if (index.kind === 'unique') return clause.equals ? 1 : 4
  return clause.equals ? 3 : 5
}

/** An `or` is several lookups: after any single one, before a range walk. */
const OR_RANK = 5.5

export async function findByIndex(
  adapter: DynamoAdapter,
  partition: string,
  where: undefined | Where,
): Promise<null | Row[]> {
  if (!where) return null

  const ids = await candidatesOf(adapter, partition, where)
  if (ids === null) return null

  const items = await batchGet(
    adapter,
    ids.map((id) => ({ pk: partition, sk: id })),
  )
  const rows = items.map(stripInternalKeys).filter((row) => matchesWhere(row, where))
  // A partition read returns rows in key order; keep that, so callers that
  // take "the first match" get the same one either way.
  return rows.sort((a, b) => compareKeys(String(a['id']), String(b['id'])))
}

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The sort keys of every row `where` can match — possibly more, never
 * fewer — or `null` when none of its clauses can supply them.
 */
async function candidatesOf(
  adapter: DynamoAdapter,
  partition: string,
  where: Where,
): Promise<null | string[]> {
  const clauses: Clause[] = []
  keyClauses(where, clauses)
  if (clauses.length === 0) return null

  const indexes = indexesOf(adapter, partition)
  const plans: Plan[] = []
  for (const clause of clauses) {
    if (clause.kind === 'any') {
      plans.push({ clause, rank: OR_RANK })
      continue
    }
    const index = clause.path === 'id' ? null : indexes?.get(clause.path)
    if (index === undefined) continue
    // Ranges need rows in value order: not ids (random), not guards.
    if (clause.kind === 'range' && index?.kind !== 'rows') continue
    plans.push({ clause, index, rank: rank(clause, index) })
  }
  const size = (clause: Clause) => (clause.kind === 'keys' ? clause.values.length : 0)
  plans.sort((a, b) => a.rank - b.rank || size(a.clause) - size(b.clause))

  for (const plan of plans) {
    const ids =
      'index' in plan
        ? await candidateIds(adapter, plan.clause, plan.index)
        : await unionOf(adapter, partition, plan.clause.branches)
    if (ids !== null) return ids
  }
  return null
}

/**
 * Candidates for an `or`: the union of its branches' candidates. Every
 * branch has to supply some — one that can't could match any row at all —
 * and together they have to stay within what a key lookup is worth.
 */
async function unionOf(
  adapter: DynamoAdapter,
  partition: string,
  branches: Where[],
): Promise<null | string[]> {
  if (branches.length > MAX_OR_BRANCHES) return null

  const found = new Set<string>()
  let open = false
  await mapWithConcurrency(branches, QUERY_CONCURRENCY, async (branch) => {
    if (open) return
    const ids = await candidatesOf(adapter, partition, branch)
    if (ids === null) {
      open = true
      return
    }
    for (const id of ids) found.add(id)
  })
  return open || found.size > INDEX_LOOKUP_LIMIT ? null : [...found]
}

/** The sort keys of the rows a field clause can match, or `null` to pass. */
async function candidateIds(
  adapter: DynamoAdapter,
  clause: FieldClause,
  index: FieldIndex | null,
): Promise<null | string[]> {
  if (clause.kind === 'range') {
    if (!index || !(await isIndexReady(adapter, index))) return null
    const [from, to] = rangeSpan(clause)
    // An empty range (`> 5 AND < 3`) matches nothing; DynamoDB rejects it.
    if (from > to) return []
    return collectOwners(adapter, index.partition, [{ from, to }])
  }

  const { values } = clause
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
  return collectOwners(
    adapter,
    index.partition,
    values.map((value) => ({ prefix: `${valueKey(value)!}#` })),
  )
}

/**
 * The stretch of an index a range clause covers, as inclusive sort-key
 * bounds. A row's sort key is `<value key>#<id>`, and `#` sorts below every
 * character a value key can continue with, so:
 *
 *   - `key"` sits just below the rows of `key`;
 *   - `key#` is where they start;
 *   - `key$` sits just above them, and below every longer key.
 *
 * A bound whose key was cut short stands for many values, so it is always
 * taken inclusively; the re-check sorts out the rest.
 */
function rangeSpan(clause: Extract<FieldClause, { kind: 'range' }>): [string, string] {
  const sample = (clause.lower ?? clause.upper)!.value
  const tag = typeof sample === 'number' ? 'n' : 's'

  const edge = (bound: Bound, side: 'lower' | 'upper'): string => {
    const key = valueKey(bound.value)!
    const inclusive = bound.inclusive || isTruncatedKey(key)
    if (side === 'lower') return `${key}${inclusive ? '#' : '$'}`
    return `${key}${inclusive ? '$' : '"'}`
  }
  return [
    clause.lower ? edge(clause.lower, 'lower') : `${tag}:`,
    // `;` is the character after `:` — past every key with this tag.
    clause.upper ? edge(clause.upper, 'upper') : `${tag};`,
  ]
}

type Span = { from: string; to: string } | { prefix: string } | Record<string, never>

/** The owners named by the index rows in `spans`, or `null` past the limit. */
async function collectOwners(
  adapter: DynamoAdapter,
  partition: string,
  spans: Span[],
): Promise<null | string[]> {
  const found = new Set<string>()
  let tooMany = false
  await mapWithConcurrency(spans, QUERY_CONCURRENCY, async (span) => {
    for await (const page of indexPages(adapter, partition, span)) {
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
  ...new Set(
    items
      .map((item) => item['owner'])
      .filter((owner) => owner != null)
      .map(String),
  ),
]

/**
 * Page through the rows of an index partition — all of them, those under a
 * key prefix, or those between two sort keys — in key order, or backwards.
 * Each row comes back as `{ sk, owner }`.
 */
export async function* indexPages(
  adapter: DynamoAdapter,
  partition: string,
  span: Span = {},
  options: { backward?: boolean; pageSize?: number } = {},
): AsyncGenerator<Row[]> {
  const docClient = adapter.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }

  const condition =
    'prefix' in span
      ? { expression: ' AND begins_with(#sk, :prefix)', values: { ':prefix': span.prefix } }
      : 'from' in span
        ? { expression: ' AND #sk BETWEEN :from AND :to', values: { ':from': span.from, ':to': span.to } }
        : { expression: '', values: {} }

  let exclusiveStartKey: Record<string, unknown> | undefined
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: adapter.tableName,
        KeyConditionExpression: `#pk = :pk${condition.expression}`,
        ExpressionAttributeNames: { '#owner': 'owner', '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: { ':pk': partition, ...condition.values },
        ProjectionExpression: '#sk, #owner',
        ConsistentRead: true,
        ...(options.backward ? { ScanIndexForward: false } : {}),
        ...(options.pageSize ? { Limit: options.pageSize } : {}),
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    )
    yield result.Items ?? []
    exclusiveStartKey = result.LastEvaluatedKey
  } while (exclusiveStartKey)
}

// ---------------------------------------------------------------------------
// Sorted pages
// ---------------------------------------------------------------------------

/** Index rows read per round trip while walking an index in order. */
const ORDERED_PAGE_SIZE = 100
/** Deepest position (skip + take) worth walking to instead of reading the partition. */
const ORDERED_DEPTH_LIMIT = 2000

/**
 * One page of a partition's rows, sorted by an indexed field, without
 * reading the rest: walk the field's index in order, fetch the rows it
 * names, keep those matching `where`, and stop once the page is full.
 *
 * Works for a single-valued indexed field (`ordered`): every document has
 * exactly one row there, so the walk visits each once. Rows with equal
 * values come in id order, ascending or descending with the sort — the same
 * tie-break `applySorts` uses, so a page read this way lines up with one
 * that wasn't.
 *
 * Returns `null` when the field has no such index, or when the walk isn't
 * worth it: the page lies too deep, `where` rejects most of what the index
 * offers, or a value was too long for its key to carry the full order.
 */
export async function findOrderedPage(
  adapter: DynamoAdapter,
  partition: string,
  args: { descending: boolean; path: string; skip: number; take: number; where: undefined | Where },
): Promise<null | Row[]> {
  const { descending, path, skip, take, where } = args
  const index = indexesOf(adapter, partition)?.get(path)
  if (!index || index.kind !== 'rows' || !index.ordered) return null

  const wanted = skip + take
  if (take <= 0 || wanted > ORDERED_DEPTH_LIMIT) return null
  if (!(await isIndexReady(adapter, index))) return null

  // How many index rows may be read before concluding that `where` is too
  // selective for this to beat a partition read.
  const budget = Math.max(1000, wanted * 4)
  const matched: Row[] = []
  const seen = new Set<string>()
  let examined = 0

  for await (const page of indexPages(adapter, index.partition, {}, {
    backward: descending,
    pageSize: ORDERED_PAGE_SIZE,
  })) {
    if (page.some((row) => isTruncatedKey(keyOfRow(String(row['sk']))))) return null

    const items = await batchGet(
      adapter,
      owners(page).map((id) => ({ pk: partition, sk: id })),
    )
    const byId = new Map(items.map((item) => [String(item['sk']), item]))

    for (const row of page) {
      examined++
      const id = String(row['owner'])
      const item = byId.get(id)
      if (!item || seen.has(id)) continue
      const doc = stripInternalKeys(item)
      // A stray row (the document has moved on to another value) must not
      // place the document here; its current row will.
      const current = valueKey(getByPath(doc, path)) ?? NO_VALUE_KEY
      if (current !== keyOfRow(String(row['sk']))) continue

      seen.add(id)
      if (!where || matchesWhere(doc, where)) matched.push(doc)
      if (matched.length >= wanted) return matched.slice(skip, wanted)
    }
    if (examined > budget) return null
  }

  return matched.slice(skip, wanted)
}
