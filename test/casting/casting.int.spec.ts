import type { Where } from 'payload'

import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { handleEndpoints } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DynamoAdapter } from '../../src/index.js'

import { castCollectionWhere } from '../../src/utilities/castWhere.js'
import { initPayloadTest, type TestHandle } from '../__helpers/initPayload.js'
import { config } from './config.js'

/**
 * Operands reach the adapter as strings whenever a query comes in over REST
 * (`?where[count][greater_than]=5` → `'5'`). DynamoDB compares strictly by
 * type, so the adapter casts operands to each field's stored type first.
 *
 * Every case here runs three ways and must give one answer:
 *  - over the real REST handler, from a real query string;
 *  - through the local API with the same string operands, evaluated by
 *    DynamoDB (`FilterExpression` pushdown);
 *  - the same again, evaluated in JS (`matchesWhere`).
 */

let handle: TestHandle
const ids: Record<string, number | string> = {}

beforeAll(async () => {
  handle = await initPayloadTest('casting', config)

  for (const data of [
    { id: 7, name: 'seven' },
    { id: 8, name: 'eight' },
  ]) {
    await handle.payload.create({ collection: 'authors', data })
  }

  const seed = [
    {
      name: 'a',
      note: 'hello',
      count: 1,
      active: true,
      dueAt: '2026-01-01T00:00:00.000Z',
      author: 7,
      meta: { score: 5 },
    },
    {
      name: 'b',
      // What the admin UI leaves behind when a text input is cleared.
      note: '',
      count: 2,
      active: false,
      dueAt: '2026-06-01T00:00:00.000Z',
      author: 8,
      meta: { score: 15 },
    },
    // `count: 10` is the row that separates numeric from string ordering:
    // as text, '10' sorts before '2' and before '9'.
    { name: 'c', count: 10, active: false },
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

/** Serialize a flat `where` the way a REST client would put it in a URL. */
function toQuery(where: Where): string {
  const params = new URLSearchParams()
  for (const [path, operators] of Object.entries(where)) {
    for (const [operator, operand] of Object.entries(operators as Record<string, unknown>)) {
      if (Array.isArray(operand)) {
        operand.forEach((member, index) =>
          params.append(`where[${path}][${operator}][${index}]`, String(member)),
        )
      } else {
        params.append(`where[${path}][${operator}]`, String(operand))
      }
    }
  }
  return params.toString()
}

async function viaRest(collection: string, where: Where): Promise<string[]> {
  const response = await handleEndpoints({
    config: handle.payload.config,
    request: new Request(`http://localhost/api/${collection}?limit=0&${toQuery(where)}`),
  })
  expect(response.status, 'REST status').toBe(200)
  const body = (await response.json()) as { docs: { name?: unknown }[] }
  return body.docs.map((doc) => String(doc.name)).sort()
}

async function viaLocal(collection: string, where: Where): Promise<string[]> {
  const result = await handle.payload.find({
    collection,
    limit: 0,
    pagination: false,
    where,
  })
  return result.docs.map((doc) => String(doc.name)).sort()
}

/** An empty `like` is a no-op constraint that routes the query through JS. */
const viaJs = (collection: string, where: Where) =>
  viaLocal(collection, { and: [where, { name: { like: '' } }] })

describe('seed rows', () => {
  it('store a cleared text field as an empty string', async () => {
    const adapter = handle.payload.db as DynamoAdapter
    const result = await adapter.docClient!.send(
      new GetCommand({
        TableName: handle.tableName,
        Key: { pk: 'things', sk: String(ids['b']) },
      }),
    )
    expect(result.Item?.note).toBe('')
  })
})

describe('string operands are cast to the field type', () => {
  const cases: { collection?: string; expected: string[]; title: string; where: Where }[] = [
    {
      title: 'number: less_than orders numerically, not as text',
      where: { count: { less_than: '9' } },
      expected: ['a', 'b'],
    },
    {
      title: 'number: greater_than orders numerically, not as text',
      where: { count: { greater_than: '5' } },
      expected: ['c'],
    },
    {
      title: 'number: equals',
      where: { count: { equals: '2' } },
      expected: ['b'],
    },
    {
      title: 'number: in as a comma-delimited string',
      where: { count: { in: '1,10' } },
      expected: ['a', 'c'],
    },
    {
      title: 'number: in as a list of strings',
      where: { count: { in: ['1', '2'] } },
      expected: ['a', 'b'],
    },
    {
      title: 'number: not_in as a comma-delimited string',
      where: { count: { not_in: '1,10' } },
      expected: ['b'],
    },
    {
      title: 'number nested in a group',
      where: { 'meta.score': { greater_than: '9' } },
      expected: ['b'],
    },
    {
      title: 'checkbox: equals true',
      where: { active: { equals: 'true' } },
      expected: ['a'],
    },
    {
      title: 'checkbox: equals false',
      where: { active: { equals: 'false' } },
      expected: ['b', 'c'],
    },
    {
      title: 'date: a date-only string compares as a full timestamp',
      where: { dueAt: { greater_than: '2026-03-01' } },
      expected: ['b'],
    },
    {
      title: 'date: a date-only string equals the stored midnight timestamp',
      where: { dueAt: { equals: '2026-01-01' } },
      expected: ['a'],
    },
    {
      title: 'relationship: id of a numeric-id collection',
      where: { author: { equals: '7' } },
      expected: ['a'],
    },
    {
      title: 'relationship: in as a comma-delimited string',
      where: { author: { in: '7,8' } },
      expected: ['a', 'b'],
    },
    {
      title: 'exists: the string "false" means false',
      where: { author: { exists: 'false' } },
      expected: ['c'],
    },
    {
      title: 'exists: true skips a text field holding an empty string',
      where: { note: { exists: 'true' } },
      expected: ['a'],
    },
    {
      title: 'exists: false matches an empty string as well as a missing field',
      where: { note: { exists: 'false' } },
      expected: ['b', 'c'],
    },
    {
      title: 'id: in on a numeric-id collection',
      collection: 'authors',
      where: { id: { in: '7,9' } },
      expected: ['seven'],
    },
    {
      title: 'id: not_equals on a numeric-id collection',
      collection: 'authors',
      where: { id: { not_equals: '7' } },
      expected: ['eight'],
    },
  ]

  it.each(cases)('$title', async ({ collection = 'things', expected, where }) => {
    expect(await viaRest(collection, where), 'REST query string').toEqual(expected)
    expect(await viaLocal(collection, where), 'pushdown (FilterExpression)').toEqual(expected)
    expect(await viaJs(collection, where), 'JS (matchesWhere)').toEqual(expected)
  })

  it('an operand that cannot be cast matches nothing in either evaluator', async () => {
    // Left as the string it is, it has no order against stored numbers —
    // and the JS evaluator must not fall back to comparing as text.
    const where: Where = { count: { less_than: 'abc' } }
    expect(await viaLocal('things', where)).toEqual([])
    expect(await viaJs('things', where)).toEqual([])
  })
})

describe('version and draft queries', () => {
  it('findVersions casts operands on version-row and version.* paths', async () => {
    const note = await handle.payload.create({
      collection: 'notes',
      data: { title: 'n', rank: 1 },
    })
    await handle.payload.update({ collection: 'notes', id: note.id, data: { rank: 10 } })

    const newer = await handle.payload.findVersions({
      collection: 'notes',
      where: { 'version.rank': { greater_than: '9' } },
    })
    expect(newer.totalDocs).toBe(1)
    expect(newer.docs[0]?.version.rank).toBe(10)

    const older = await handle.payload.findVersions({
      collection: 'notes',
      where: { 'version.rank': { less_than: '9' } },
    })
    expect(older.totalDocs).toBe(1)
    expect(older.docs[0]?.version.rank).toBe(1)
  })

  it('draft queries cast operands, on version rows and after the prefix is stripped', async () => {
    const low = await handle.payload.create({
      collection: 'drafts',
      data: { title: 'low', rank: 2 },
    })
    await handle.payload.create({ collection: 'drafts', data: { title: 'high', rank: 10 } })
    await handle.payload.update({ collection: 'drafts', id: low.id, data: { rank: 3 } })

    // `latest` is a checkbox on the version row itself: of the three version
    // rows, one was superseded by the update.
    const latest = await handle.payload.findVersions({
      collection: 'drafts',
      where: { latest: { equals: 'true' } },
    })
    expect(latest.docs.map((doc) => doc.version.title).sort()).toEqual(['high', 'low'])

    // Core rewrites this to `version.rank` before the adapter sees it; the
    // adapter strips the prefix again and must cast against the doc's fields.
    const result = await handle.payload.find({
      collection: 'drafts',
      draft: true,
      where: { rank: { greater_than: '9' } },
    })
    expect(result.docs.map((doc) => doc.title)).toEqual(['high'])
  })
})

describe('castWhere', () => {
  it('returns a new where and leaves the caller’s object untouched', () => {
    const adapter = handle.payload.db as DynamoAdapter
    const where: Where = {
      and: [{ count: { greater_than: '5' } }, { note: { exists: 'false' } }],
    }
    const snapshot = structuredClone(where)

    const cast = castCollectionWhere(adapter, 'things', where)

    expect(where).toEqual(snapshot)
    expect(cast).toEqual({
      and: [
        { count: { greater_than: 5 } },
        { and: [{ or: [{ note: { exists: false } }, { note: { equals: '' } }] }] },
      ],
    })
  })

  it('leaves operands alone when it cannot tell what the path points at', () => {
    const adapter = handle.payload.db as DynamoAdapter
    const where: Where = {
      // Not a declared field.
      mystery: { equals: '5' },
      // Continues past a relationship: the type lives in another collection.
      'author.name': { equals: '5' },
      // A text field keeps numeric-looking strings as strings.
      name: { equals: '5' },
      // Not a number, so nothing to cast it to.
      count: { equals: 'abc' },
    }

    expect(castCollectionWhere(adapter, 'things', where)).toEqual(where)
  })
})
