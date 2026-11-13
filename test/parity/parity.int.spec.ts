import type { Where } from 'payload'

import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DynamoAdapter } from '../../src/index.js'

import { initPayloadTest, type TestHandle } from '../__helpers/initPayload.js'
import { config } from './config.js'

/**
 * The adapter has two `where` evaluators: `buildFilterExpression` compiles a
 * predicate for DynamoDB to run, and `matchesWhere` runs the same predicate
 * in JS. Callers can't tell which one a given query takes — a `like` anywhere
 * in the `where`, or a drafts-enabled collection, switches paths — so the two
 * must return the same rows for the same `where`. This suite runs every case
 * through both and pins them to one expected answer.
 */

let handle: TestHandle
const ids: Record<string, number | string> = {}

const JAN = '2026-01-01T00:00:00.000Z'
const MAR = '2026-03-01T00:00:00.000Z'
const JUN = '2026-06-01T00:00:00.000Z'

/**
 * `Where` is typed for JSON values, but the local API hands whatever it's
 * given straight to the adapter — and a `Date` is the natural thing to pass
 * for a date field.
 */
const date = (iso: string) => new Date(iso) as unknown as string

beforeAll(async () => {
  handle = await initPayloadTest('parity', config)

  // Three rows that differ in exactly the ways the evaluators have disagreed
  // about: a real value, an explicit `null` (what Payload writes when a field
  // is cleared), and an attribute that was never written at all.
  const seed = [
    { name: 'value', note: 'hello', count: 1, dueAt: JAN, meta: { kind: 'a', rank: 1 } },
    { name: 'null', note: null, count: 2, dueAt: JUN, meta: { kind: 'b', rank: 2 } },
    { name: 'missing', count: 3 },
  ]
  for (const data of seed) {
    const doc = await handle.payload.create({ collection: 'things', data })
    ids[data.name] = doc.id
  }
})

afterAll(async () => {
  // `handle` is undefined when beforeAll threw before assignment. Guard so
  // afterAll's TypeError doesn't mask the real error from beforeAll.
  await (handle as TestHandle | undefined)?.cleanup()
})

async function names(where: Where): Promise<string[]> {
  const result = await handle.payload.find({
    collection: 'things',
    limit: 0,
    pagination: false,
    where,
  })
  return result.docs.map((doc) => String(doc.name)).sort()
}

/** Rows matched when DynamoDB evaluates `where` as a `FilterExpression`. */
const viaPushdown = (where: Where) => names(where)

/**
 * Rows matched when the adapter evaluates the same `where` in JS. An empty
 * `like` is a no-op constraint, but its presence is what routes the whole
 * query through `matchesWhere`.
 */
const viaJs = (where: Where) => names({ and: [where, { name: { like: '' } }] })

describe('seed rows', () => {
  it('store an explicit null as a NULL attribute and an omitted field as no attribute', async () => {
    // The cases below only mean something if these two rows really differ on
    // disk, so pin the raw shapes rather than trusting the write path.
    const adapter = handle.payload.db as DynamoAdapter
    const raw = async (name: string) => {
      const result = await adapter.docClient!.send(
        new GetCommand({
          TableName: handle.tableName,
          Key: { pk: 'things', sk: String(ids[name]) },
        }),
      )
      return result.Item ?? {}
    }

    const withNull = await raw('null')
    expect('note' in withNull).toBe(true)
    expect(withNull.note).toBeNull()

    const withNothing = await raw('missing')
    expect('note' in withNothing).toBe(false)
    expect('dueAt' in withNothing).toBe(false)
  })
})

describe('pushdown and JS evaluators agree', () => {
  const cases: { expected: string[]; title: string; where: Where }[] = [
    {
      title: 'exists: true skips a field that was cleared to null',
      where: { note: { exists: true } },
      expected: ['value'],
    },
    {
      title: 'exists: false matches both a null field and a missing one',
      where: { note: { exists: false } },
      expected: ['missing', 'null'],
    },
    {
      title: 'equals with a Date value',
      where: { dueAt: { equals: date(JAN) } },
      expected: ['value'],
    },
    {
      title: 'not_equals with a Date value',
      where: { dueAt: { not_equals: date(JAN) } },
      expected: ['missing', 'null'],
    },
    {
      title: 'greater_than with a Date value',
      where: { dueAt: { greater_than: date(MAR) } },
      expected: ['null'],
    },
    {
      title: 'less_than_equal with a Date value',
      where: { dueAt: { less_than_equal: date(JUN) } },
      expected: ['null', 'value'],
    },
    {
      title: 'in with Date values',
      where: { dueAt: { in: [date(JAN), date(MAR)] } },
      expected: ['value'],
    },
    {
      title: 'not_in with Date values',
      where: { dueAt: { not_in: [date(JAN)] } },
      expected: ['missing', 'null'],
    },
    // Object operands — the shape a polymorphic relationship query takes
    // (`{ relationTo, value }`). DynamoDB compares maps by content, not by
    // key order.
    {
      title: 'equals with an object value, regardless of key order',
      where: { meta: { equals: { rank: 1, kind: 'a' } } },
      expected: ['value'],
    },
    {
      title: 'not_equals with an object value',
      where: { meta: { not_equals: { kind: 'a', rank: 1 } } },
      expected: ['missing', 'null'],
    },
    {
      title: 'in with object values',
      where: { meta: { in: [{ kind: 'b', rank: 2 }, { kind: 'z', rank: 9 }] } },
      expected: ['null'],
    },
    {
      title: 'equals with an object that only partially matches',
      where: { meta: { equals: { kind: 'a' } } },
      expected: [],
    },
    // Operands of a different type than the stored value. DynamoDB never
    // orders a number against a string; the JS evaluator used to fall back
    // to comparing both as text and matched rows the pushdown rejected.
    {
      title: 'less_than with a string that is not a number, against a number field',
      where: { count: { less_than: 'abc' } },
      expected: [],
    },
    {
      title: 'greater_than with a number, against a text field',
      where: { note: { greater_than: 5 } },
      expected: [],
    },
    {
      title: 'not_equals matches rows where the field is null or missing',
      where: { note: { not_equals: 'hello' } },
      expected: ['missing', 'null'],
    },
    {
      title: 'not_in matches rows where the field is null or missing',
      where: { note: { not_in: ['hello'] } },
      expected: ['missing', 'null'],
    },
  ]

  it.each(cases)('$title', async ({ expected, where }) => {
    expect(await viaPushdown(where), 'pushdown (FilterExpression)').toEqual(expected)
    expect(await viaJs(where), 'JS (matchesWhere)').toEqual(expected)
  })
})
