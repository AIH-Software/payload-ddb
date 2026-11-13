import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { type Args, backfillIndexes, dynamoAdapter, type DynamoAdapter } from '../../src/index.js'
import { valueKey } from '../../src/utilities/fieldIndexes.js'
import { INDEX_LOOKUP_LIMIT } from '../../src/utilities/indexLookup.js'
import { mapWithConcurrency } from '../../src/utilities/mapWithConcurrency.js'
import { TEST_DDB_ENDPOINT } from '../__helpers/assertDbReachable.js'
import { deleteTable } from '../__helpers/deleteTable.js'
import { initPayloadTest, type TestHandle } from '../__helpers/initPayload.js'
import { randomTableName } from '../__helpers/randomTableName.js'
import { makeConfig } from './config.js'

/**
 * Lookups by id, by a `unique: true` field and by an `index: true` field
 * are answered from keys instead of a read of the whole partition. These
 * tests pin both halves of that: the answer is the same one a partition
 * read gives, and the partition isn't read.
 */

let handle: TestHandle
let payload: Payload
let adapter: DynamoAdapter
const ids: Record<string, number | string> = {}
/** Tear-downs for the extra Payload instances some tests boot. */
const closers: (() => Promise<void>)[] = []

beforeAll(async () => {
  handle = await initPayloadTest('indexes', makeConfig())
  payload = handle.payload
  adapter = payload.db as DynamoAdapter

  const ada = await payload.create({ collection: 'authors', data: { name: 'ada' } })
  const bob = await payload.create({ collection: 'authors', data: { name: 'bob' } })
  Object.assign(ids, { ada: ada.id, bob: bob.id })

  const articles = [
    {
      title: 'one',
      slug: 'one',
      author: ada.id,
      featured: true,
      label: 'hello',
      meta: { code: 'm1' },
      rank: 1,
      sku: 'A',
      tags: ['x', 'y'],
    },
    { title: 'two', slug: 'two', author: ada.id, meta: { code: 'm2' }, rank: 2, sku: 'A', tags: ['y'] },
    { title: 'three', slug: 'three', author: bob.id, rank: 2, sku: 'B' },
    // A value that contains the separator index rows use, next to one that
    // is a prefix of it.
    { title: 'four', slug: 'four', sku: 'C#1' },
    { title: 'five', slug: 'five', sku: 'C' },
  ]
  for (const data of articles) {
    const doc = await payload.create({ collection: 'articles', data } as never)
    ids[data.title] = doc.id
  }
  await payload.update({
    id: ids['one']!,
    collection: 'articles',
    data: { label: 'hola' },
    locale: 'es',
  } as never)
})

afterAll(async () => {
  for (const close of closers) await close().catch(() => {})
  // `handle` is undefined when beforeAll threw before assignment. Guard so
  // afterAll's TypeError doesn't mask the real error from beforeAll.
  await (handle as TestHandle | undefined)?.cleanup()
})

type Sent = { input: Record<string, any>; name: string }

/** Run `run` and report the DynamoDB commands `db` sent while it did. */
async function traced<T>(db: DynamoAdapter, run: () => Promise<T>) {
  const spy = vi.spyOn(db.docClient!, 'send')
  try {
    const result = await run()
    const sent: Sent[] = spy.mock.calls.map(([command]) => ({
      name: (command as object).constructor.name,
      input: (command as { input: Record<string, any> }).input,
    }))
    return {
      result,
      sent,
      /**
       * How many `Query`s walked `partition` itself. A `COUNT` walk, which
       * sends no rows back, only counts when `counts` is set.
       */
      partitionReads: (partition: string, counts = true) =>
        sent.filter(
          ({ name, input }) =>
            name === 'QueryCommand' &&
            input['ExpressionAttributeValues']?.[':pk'] === partition &&
            (counts || input['Select'] !== 'COUNT'),
        ).length,
    }
  } finally {
    spy.mockRestore()
  }
}

const find = (where: Record<string, unknown>, args: Record<string, unknown> = {}, on = payload) =>
  on.find({ collection: 'articles', depth: 0, limit: 0, where, ...args } as never)

/** Titles matched by `where`, plus how often the articles partition was read. */
async function lookup(where: Record<string, unknown>, args: Record<string, unknown> = {}) {
  const { partitionReads, result } = await traced(adapter, () => find(where, args))
  return {
    reads: partitionReads('articles'),
    titles: result.docs.map((doc) => (doc as unknown as { title: string }).title).sort(),
  }
}

/** Every row in a partition, straight from the table. */
async function rawPartition(pk: string, db = adapter, tableName = handle.tableName) {
  const result = await db.docClient!.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': pk },
    }),
  )
  return result.Items ?? []
}

/** Boot another Payload instance, on the suite's table or a new one. */
async function boot(key: string, tableName: string, args: Partial<Args> = {}): Promise<Payload> {
  const sanitized = await buildConfig({
    ...makeConfig(),
    db: dynamoAdapter({
      clientConfig: {
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        endpoint: TEST_DDB_ENDPOINT,
        region: 'us-east-1',
      },
      tableName,
      ...args,
    }),
    secret: 'TEST_SECRET',
    telemetry: false,
    typescript: { autoGenerate: false, declare: false },
  })
  const instance = await getPayload({ config: sanitized, key })
  closers.push(() => instance.destroy())
  return instance
}

describe('lookups that skip the partition read', () => {
  it('by a unique field', async () => {
    expect(await lookup({ slug: { equals: 'two' } })).toEqual({ reads: 0, titles: ['two'] })
    expect(await lookup({ slug: { in: ['one', 'three', 'nope'] } })).toEqual({
      reads: 0,
      titles: ['one', 'three'],
    })
    expect(await lookup({ slug: { equals: 'nope' } })).toEqual({ reads: 0, titles: [] })
  })

  it('by an indexed field, with the other clauses still applied', async () => {
    expect(await lookup({ sku: { equals: 'A' } })).toEqual({ reads: 0, titles: ['one', 'two'] })
    expect(
      await lookup({ and: [{ sku: { equals: 'A' } }, { title: { like: 'tw' } }] }),
    ).toEqual({ reads: 0, titles: ['two'] })
    expect(await lookup({ rank: { greater_than: 1 }, sku: { equals: 'A' } })).toEqual({
      reads: 0,
      titles: ['two'],
    })
  })

  it('by an `in` list on an indexed field', async () => {
    expect(await lookup({ sku: { in: ['A', 'B', 'nope'] } })).toEqual({
      reads: 0,
      titles: ['one', 'three', 'two'],
    })
  })

  it('by a number, a group sub-field and one element of a hasMany field', async () => {
    expect(await lookup({ rank: { equals: 2 } })).toEqual({ reads: 0, titles: ['three', 'two'] })
    // Query-string operands are cast before the lookup, like any other filter.
    expect(await lookup({ rank: { equals: '2' } })).toEqual({ reads: 0, titles: ['three', 'two'] })
    expect(await lookup({ 'meta.code': { equals: 'm2' } })).toEqual({ reads: 0, titles: ['two'] })
    expect(await lookup({ tags: { equals: 'y' } })).toEqual({ reads: 0, titles: ['one', 'two'] })
    expect(await lookup({ tags: { in: ['x'] } })).toEqual({ reads: 0, titles: ['one'] })
  })

  it("by a localized field, in the request's locale", async () => {
    expect(await lookup({ label: { equals: 'hola' } }, { locale: 'es' })).toEqual({
      reads: 0,
      titles: ['one'],
    })
    expect(await lookup({ label: { equals: 'hola' } }, { locale: 'en' })).toEqual({
      reads: 0,
      titles: [],
    })
    expect(await lookup({ label: { equals: 'hello' } })).toEqual({ reads: 0, titles: ['one'] })
  })

  it('by a relationship, which is how join fields find their documents', async () => {
    expect(await lookup({ author: { equals: ids['ada'] } })).toEqual({
      reads: 0,
      titles: ['one', 'two'],
    })

    const { partitionReads, result } = await traced(adapter, () =>
      payload.find({ collection: 'authors', depth: 0, where: { name: { equals: 'ada' } } }),
    )
    const joined = (result.docs[0] as unknown as { articles: { docs: unknown[] } }).articles
    expect(joined.docs.map(String).sort()).toEqual([ids['one'], ids['two']].map(String).sort())
    expect(partitionReads('articles')).toBe(0)
  })

  it('by a list of ids', async () => {
    expect(await lookup({ id: { in: [ids['one'], ids['three'], 'missing'] } })).toEqual({
      reads: 0,
      titles: ['one', 'three'],
    })
    // An id among other clauses is still a key lookup.
    expect(
      await lookup({ and: [{ id: { equals: ids['one'] } }, { sku: { equals: 'B' } }] }),
    ).toEqual({ reads: 0, titles: [] })
  })

  it('by an `or`, when every branch is an indexed lookup', async () => {
    expect(await lookup({ or: [{ slug: { equals: 'one' } }, { sku: { equals: 'B' } }] })).toEqual({
      reads: 0,
      titles: ['one', 'three'],
    })
    // A branch may carry more than its key clause, and branches may nest.
    expect(
      await lookup({
        or: [
          { and: [{ sku: { equals: 'A' } }, { title: { equals: 'two' } }] },
          { or: [{ slug: { equals: 'three' } }, { 'meta.code': { equals: 'm1' } }] },
        ],
      }),
    ).toEqual({ reads: 0, titles: ['one', 'three', 'two'] })
  })

  it('by the `or` Payload uses to find an upload under any of its filenames', async () => {
    // The shape of Payload's `checkFileAccess`: one value tried against a
    // unique field and several indexed ones, with more constraints AND-ed on.
    const where = (value: string) => ({
      and: [
        {
          or: [
            { slug: { equals: value } },
            { sku: { equals: value } },
            { 'meta.code': { equals: value } },
          ],
        },
        { title: { exists: true } },
      ],
    })

    const found = await traced(adapter, () =>
      adapter.findOne({ collection: 'articles', where: where('m2') } as never),
    )
    expect((found.result as unknown as { title: string }).title).toBe('two')
    expect(found.partitionReads('articles')).toBe(0)

    const missing = await traced(adapter, () =>
      adapter.findOne({ collection: 'articles', where: where('nope') } as never),
    )
    expect(missing.result).toBeNull()
    expect(missing.partitionReads('articles')).toBe(0)
  })

  it('when counting', async () => {
    const { partitionReads, result } = await traced(adapter, () =>
      payload.count({ collection: 'articles', where: { sku: { equals: 'A' } } }),
    )
    expect(result.totalDocs).toBe(2)
    expect(partitionReads('articles')).toBe(0)
  })

  it('without one value bleeding into another that starts the same', async () => {
    expect(await lookup({ sku: { equals: 'C' } })).toEqual({ reads: 0, titles: ['five'] })
    expect(await lookup({ sku: { equals: 'C#1' } })).toEqual({ reads: 0, titles: ['four'] })
  })
})

describe('lookups that still read the partition', () => {
  it('on a field that has no index', async () => {
    const plain = await lookup({ title: { equals: 'one' } })
    expect(plain.titles).toEqual(['one'])
    expect(plain.reads).toBeGreaterThan(0)

    // `index: true` on a checkbox is ignored: it can't narrow a read.
    const flagged = await lookup({ featured: { equals: true } })
    expect(flagged.titles).toEqual(['one'])
    expect(flagged.reads).toBeGreaterThan(0)
    expect(await rawPartition('articles#index#featured')).toHaveLength(0)
  })

  it('when the indexed clause is only one side of an `or`', async () => {
    const result = await lookup({ or: [{ sku: { equals: 'B' } }, { title: { equals: 'one' } }] })
    expect(result.titles).toEqual(['one', 'three'])
    expect(result.reads).toBeGreaterThan(0)
  })

  it('when a value matches more documents than a key lookup is worth', async () => {
    const total = INDEX_LOOKUP_LIMIT + 5
    await mapWithConcurrency(
      Array.from({ length: total }, (_, index) => index),
      25,
      (index) =>
        adapter.create({
          collection: 'articles',
          data: { slug: `bulk-${index}`, sku: 'bulk', title: 'bulk' },
          req: {} as never,
        }),
    )

    const { partitionReads, result } = await traced(adapter, () => find({ sku: { equals: 'bulk' } }))
    expect(result.docs).toHaveLength(total)
    expect(partitionReads('articles')).toBeGreaterThan(0)
  })
})

describe('index rows follow the document', () => {
  const skuRows = async (value: string) =>
    (await rawPartition('articles#index#sku')).filter((row) =>
      String(row['sk']).startsWith(`${valueKey(value)}#`),
    )

  it('moves them on update and removes them on delete', async () => {
    const doc = await payload.create({
      collection: 'articles',
      data: { slug: 'mover', sku: 'before', title: 'mover' },
    } as never)
    expect(await skuRows('before')).toHaveLength(1)

    await payload.update({ id: doc.id, collection: 'articles', data: { sku: 'after' } } as never)
    expect(await lookup({ sku: { equals: 'before' } })).toEqual({ reads: 0, titles: [] })
    expect(await lookup({ sku: { equals: 'after' } })).toEqual({ reads: 0, titles: ['mover'] })
    expect(await skuRows('before')).toHaveLength(0)
    expect(await skuRows('after')).toHaveLength(1)

    // An update that leaves the indexed fields alone is a plain write.
    const { sent } = await traced(adapter, () =>
      adapter.updateOne({ id: doc.id, collection: 'articles', data: { rank: 7 } } as never),
    )
    const writes = sent.filter(({ name }) => name === 'TransactWriteCommand')
    expect(writes).toHaveLength(1)
    // …the document, its slug guard, and `rank` moving from its "no value"
    // row to the new one — the `sku` row isn't touched.
    expect(writes[0]!.input['TransactItems']).toHaveLength(4)

    await payload.delete({ id: doc.id, collection: 'articles' })
    expect(await lookup({ sku: { equals: 'after' } })).toEqual({ reads: 0, titles: [] })
    expect(await skuRows('after')).toHaveLength(0)
    expect(await lookup({ slug: { equals: 'mover' } })).toEqual({ reads: 0, titles: [] })
  })

  it('ignores a stray row that points at a document without the value', async () => {
    await adapter.docClient!.send(
      new PutCommand({
        TableName: handle.tableName,
        Item: {
          pk: 'articles#index#sku',
          sk: `${valueKey('B')}#${ids['one']}`,
          owner: String(ids['one']),
        },
      }),
    )
    expect(await lookup({ sku: { equals: 'B' } })).toEqual({ reads: 0, titles: ['three'] })
  })

  it('keeps up with a field that changes more rows than one transaction holds', async () => {
    const many = Array.from({ length: 150 }, (_, index) => `t${index}`)
    const doc = await payload.create({
      collection: 'articles',
      data: { slug: 'wide', tags: many, title: 'wide' },
    } as never)
    const tagRows = async () =>
      (await rawPartition('articles#index#tags')).filter((row) => row['owner'] === String(doc.id))
    expect(await lookup({ tags: { equals: 't0' } })).toEqual({ reads: 0, titles: ['wide'] })
    expect(await lookup({ tags: { equals: 't149' } })).toEqual({ reads: 0, titles: ['wide'] })
    expect(await tagRows()).toHaveLength(150)

    await payload.update({ id: doc.id, collection: 'articles', data: { tags: ['only'] } } as never)
    expect(await lookup({ tags: { equals: 't149' } })).toEqual({ reads: 0, titles: [] })
    expect(await lookup({ tags: { equals: 'only' } })).toEqual({ reads: 0, titles: ['wide'] })
    // The removals one transaction had no room for are cleaned up after it.
    expect(await tagRows()).toHaveLength(1)

    await payload.update({ id: doc.id, collection: 'articles', data: { tags: many } } as never)
    await payload.delete({ id: doc.id, collection: 'articles' })
    expect(await tagRows()).toHaveLength(0)
  })

  it('agrees with the documents after concurrent updates and deletes', async () => {
    const values = ['w1', 'w2', 'w3']
    const docIds = Array.from({ length: 12 }, (_, index) => `w-${index}`)
    await Promise.all(
      docIds.map((id, index) =>
        adapter.create({
          collection: 'articles',
          data: { id, slug: id, sku: values[index % 3], title: 'w' },
          req: {} as never,
        }),
      ),
    )

    // Every document is rewritten twice at once; every fourth is also deleted.
    await Promise.all(
      docIds.flatMap((id, index) => [
        adapter.updateOne({
          id,
          collection: 'articles',
          data: { sku: values[(index + 1) % 3] },
        } as never),
        adapter.updateOne({
          id,
          collection: 'articles',
          data: { sku: values[(index + 2) % 3] },
        } as never),
        ...(index % 4 === 0
          ? [adapter.deleteOne({ collection: 'articles', where: { id: { equals: id } } })]
          : []),
      ]),
    )

    // `title` has no index, so this is the partition's own account.
    const truth = (await find({ title: { equals: 'w' } })).docs as unknown as {
      id: string
      sku: string
    }[]
    expect(truth.length).toBe(9)

    for (const value of values) {
      const { partitionReads, result } = await traced(adapter, () => find({ sku: { equals: value } }))
      expect(result.docs.map((doc) => String(doc.id)).sort()).toEqual(
        truth
          .filter((doc) => doc.sku === value)
          .map((doc) => doc.id)
          .sort(),
      )
      expect(partitionReads('articles')).toBe(0)
    }
  })
})

describe('stray index rows', () => {
  it('are removed by the backfill, which leaves real rows alone', async () => {
    const stray = { pk: 'articles#index#sku', sk: `${valueKey('ghost')}#${ids['two']}` }
    await adapter.docClient!.send(
      new PutCommand({ TableName: handle.tableName, Item: { ...stray, owner: String(ids['two']) } }),
    )

    const report = await backfillIndexes(payload)
    expect(report.collections['articles']!.pruned).toBeGreaterThanOrEqual(1)
    expect((await rawPartition('articles#index#sku')).some((row) => row['sk'] === stray.sk)).toBe(
      false,
    )
    expect(await lookup({ sku: { equals: 'A' } })).toEqual({ reads: 0, titles: ['one', 'two'] })
    expect(await lookup({ sku: { equals: 'B' } })).toEqual({ reads: 0, titles: ['three'] })
  })
})

describe('range filters and sorted pages', () => {
  type Event = { at?: string; city?: string; id: string; name: string; score?: number }
  let events: Event[] = []
  const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString()
  const names = (docs: unknown[]) => (docs as Event[]).map((doc) => doc.name)
  const query = (args: Record<string, unknown>) =>
    traced(adapter, () => payload.find({ collection: 'events', depth: 0, ...args } as never))

  beforeAll(async () => {
    const rows = [
      { name: 'a', at: day(5), city: 'Oslo', score: 3 },
      { name: 'b', at: day(1), city: 'Lima', score: -2 },
      { name: 'c', at: day(9), city: 'Rome', score: 10 },
      // Ties with `a` on score and with `b` on city.
      { name: 'd', city: 'Lima', score: 3 },
      { name: 'e', at: day(5), score: 0.5 },
      { name: 'f', at: day(3), city: 'Oslo' },
      { name: 'g', at: day(7), city: 'Bern', score: -11 },
      // A city that is the start of another one.
      { name: 'h', at: day(2), city: 'Rom', score: 3 },
      { name: 'i' },
      { name: 'j', at: day(8), city: 'Åre', score: 100 },
      { name: 'k', at: day(6), city: 'Oslo', score: 2 },
      { name: 'l', at: day(4), city: 'lima', score: 7 },
    ]
    for (const data of rows) await payload.create({ collection: 'events', data } as never)
    events = (await payload.find({ collection: 'events', depth: 0, limit: 0 }))
      .docs as unknown as Event[]
  })

  it('answers a range from the index', async () => {
    const has = <K extends keyof Event>(key: K, test: (value: NonNullable<Event[K]>) => boolean) =>
      (event: Event) => event[key] != null && test(event[key] as NonNullable<Event[K]>)
    const cases: [Record<string, unknown>, (event: Event) => boolean][] = [
      [{ score: { greater_than: 3 } }, has('score', (score) => score > 3)],
      [{ score: { greater_than_equal: 3 } }, has('score', (score) => score >= 3)],
      [{ score: { less_than: 0 } }, has('score', (score) => score < 0)],
      [{ score: { less_than_equal: 0.5 } }, has('score', (score) => score <= 0.5)],
      [
        { score: { greater_than: -3, less_than_equal: 2 } },
        has('score', (score) => score > -3 && score <= 2),
      ],
      [{ score: { greater_than: 5, less_than: 4 } }, () => false],
      [{ at: { less_than: day(4) } }, has('at', (at) => at < day(4))],
      [
        { at: { greater_than_equal: day(5), less_than_equal: day(7) } },
        has('at', (at) => at >= day(5) && at <= day(7)),
      ],
      [{ city: { greater_than: 'Rom' } }, has('city', (city) => city > 'Rom')],
      [{ city: { greater_than_equal: 'Rom' } }, has('city', (city) => city >= 'Rom')],
      [{ city: { less_than: 'Rome' } }, has('city', (city) => city < 'Rome')],
      [{ city: { less_than_equal: 'Lima' } }, has('city', (city) => city <= 'Lima')],
      [
        { and: [{ score: { greater_than: 0 } }, { name: { not_equals: 'c' } }] },
        (event) => event.score != null && event.score > 0 && event.name !== 'c',
      ],
    ]

    for (const [where, expected] of cases) {
      const label = JSON.stringify(where)
      const { partitionReads, result } = await query({ limit: 0, where })
      expect(names(result.docs).sort(), label).toEqual(
        events
          .filter(expected)
          .map((event) => event.name)
          .sort(),
      )
      expect(partitionReads('events'), label).toBe(0)
    }
  })

  it('reads a sorted page through the index, in the order an in-memory sort gives', async () => {
    for (const sort of ['score', '-score', 'at', '-at', 'city', '-city']) {
      // `limit: 0` sorts everything in memory: the reference order.
      const all = (await payload.find({ collection: 'events', depth: 0, limit: 0, sort })).docs
      for (const page of [1, 2, 3]) {
        const label = `${sort}, page ${page}`
        const { partitionReads, result } = await query({ limit: 5, page, pagination: false, sort })
        expect(names(result.docs), label).toEqual(names(all.slice((page - 1) * 5, page * 5)))
        expect(partitionReads('events'), label).toBe(0)
      }
    }
  })

  it('applies the rest of the where while walking the index', async () => {
    const where = { name: { not_in: ['a', 'c'] } }
    const all = (await payload.find({ collection: 'events', depth: 0, limit: 0, sort: '-score', where }))
      .docs
    const { partitionReads, result } = await query({ limit: 4, pagination: false, sort: '-score', where })
    expect(names(result.docs)).toEqual(names(all.slice(0, 4)))
    expect(partitionReads('events')).toBe(0)
  })

  it('counts for pagination without fetching the partition', async () => {
    const { partitionReads, result } = await query({ limit: 5, page: 2, sort: '-score' })
    expect(result).toMatchObject({ hasNextPage: true, page: 2, totalDocs: 12, totalPages: 3 })
    expect(result.docs).toHaveLength(5)
    // The only walk of the partition is a `COUNT`, which sends no rows back.
    expect(partitionReads('events', false)).toBe(0)
    expect(partitionReads('events')).toBe(1)
  })

  it('still sorts in memory when the field has no index', async () => {
    const { partitionReads, result } = await query({ limit: 5, pagination: false, sort: 'name' })
    expect(names(result.docs)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(partitionReads('events')).toBeGreaterThan(0)
  })
})

describe('versions', () => {
  type VersionRow = { id: string; latest?: boolean; parent?: unknown }
  const versionsOf = async (parent: unknown) =>
    (await rawPartition('drafts_versions')).filter(
      (row) => row['parent'] === parent,
    ) as VersionRow[]
  const pointerOf = async (parent: unknown) =>
    (await rawPartition('drafts_versions#latest')).find((row) => row['sk'] === valueKey(parent))
  const save = (id: number | string, title: string) =>
    payload.update({ id, collection: 'drafts', data: { title } } as never)

  it('finds the latest version through its pointer, not the partition', async () => {
    const doc = await payload.create({ collection: 'drafts', data: { title: 'v1' } } as never)
    const saved = await traced(adapter, () => save(doc.id, 'v2'))
    expect(saved.partitionReads('drafts_versions')).toBe(0)

    const rows = await versionsOf(doc.id)
    expect(rows).toHaveLength(2)
    const latest = rows.filter((row) => row.latest === true)
    expect(latest).toHaveLength(1)
    expect((await pointerOf(doc.id))?.['owner']).toBe(latest[0]!.id)
  })

  it("lists a document's versions, and drafts, without reading the versions partition", async () => {
    const doc = await payload.create({ collection: 'drafts', data: { title: 'first' } } as never)
    await save(doc.id, 'second')
    await save(doc.id, 'third')

    const listed = await traced(adapter, () =>
      payload.findVersions({
        collection: 'drafts',
        depth: 0,
        where: { parent: { equals: doc.id } },
      }),
    )
    expect(listed.result.docs).toHaveLength(3)
    expect(listed.partitionReads('drafts_versions')).toBe(0)

    const drafts = await traced(adapter, () =>
      payload.find({ collection: 'drafts', depth: 0, draft: true, limit: 0 }),
    )
    const mine = drafts.result.docs.find((found) => found.id === doc.id) as unknown as {
      title: string
    }
    expect(mine.title).toBe('third')
    expect(drafts.partitionReads('drafts_versions')).toBe(0)

    const published = await traced(adapter, () =>
      payload.find({ collection: 'drafts', depth: 0, limit: 0 }),
    )
    expect(published.result.docs.some((found) => found.id === doc.id)).toBe(true)
    expect(published.partitionReads('drafts_versions')).toBe(0)
  })

  it('leaves exactly one latest version when a document is saved several times at once', async () => {
    const doc = await payload.create({ collection: 'drafts', data: { title: 'start' } } as never)
    await Promise.all(Array.from({ length: 6 }, (_, index) => save(doc.id, `at-once-${index}`)))

    const rows = await versionsOf(doc.id)
    expect(rows).toHaveLength(7)
    const latest = rows.filter((row) => row.latest === true)
    expect(latest).toHaveLength(1)
    expect((await pointerOf(doc.id))?.['owner']).toBe(latest[0]!.id)
  })

  it('drops the pointer with the latest version, but not with an older one', async () => {
    const doc = await payload.create({ collection: 'drafts', data: { title: 'old' } } as never)
    await save(doc.id, 'new')
    const rows = await versionsOf(doc.id)
    const latest = rows.find((row) => row.latest === true)!
    const older = rows.find((row) => row.latest !== true)!

    await adapter.deleteVersions({ collection: 'drafts', where: { id: { equals: older.id } } })
    expect((await pointerOf(doc.id))?.['owner']).toBe(latest.id)

    await adapter.deleteVersions({ collection: 'drafts', where: { parent: { equals: doc.id } } })
    expect(await pointerOf(doc.id)).toBeUndefined()
    expect(await versionsOf(doc.id)).toHaveLength(0)
    const byParent = await rawPartition('drafts_versions#index#parent')
    expect(byParent.filter((row) => String(row['sk']).startsWith(`${valueKey(doc.id)}#`))).toHaveLength(
      0,
    )
  })

  it('tracks the single latest version of a global', async () => {
    await payload.updateGlobal({ slug: 'settings', data: { title: 'one' } } as never)
    await payload.updateGlobal({ slug: 'settings', data: { title: 'two' } } as never)

    // Payload looks up a global's newest version itself, by sort — that reads
    // the global's own versions. The adapter's step, demoting the previous
    // latest, goes through the pointer.
    const now = new Date().toISOString()
    const third = await traced(adapter, () =>
      adapter.createGlobalVersion({
        autosave: false,
        createdAt: now,
        globalSlug: 'settings',
        updatedAt: now,
        versionData: { title: 'three' },
      } as never),
    )
    expect(third.partitionReads('settings_versions')).toBe(0)

    const latest = (await rawPartition('settings_versions')).filter((row) => row['latest'] === true)
    expect(latest).toHaveLength(1)
    const pointers = await rawPartition('settings_versions#latest')
    expect(pointers).toHaveLength(1)
    expect(pointers[0]!['owner']).toBe(latest[0]!['id'])
  })
})

describe('documents that predate their indexes', () => {
  it('are read from the partition until a backfill marks the index complete', async () => {
    const now = new Date().toISOString()
    // Rows as an adapter without indexes or guards would have left them…
    const old = [
      { id: 'l1', code: 'old', email: 'dup@example.com' },
      { id: 'l2', code: 'old', email: 'dup@example.com' },
      { id: 'l3', code: 'other', email: 'solo@example.com' },
    ]
    for (const doc of old) {
      await adapter.docClient!.send(
        new PutCommand({
          TableName: handle.tableName,
          Item: { ...doc, createdAt: now, pk: 'legacy', sk: doc.id, updatedAt: now },
        }),
      )
    }
    // …and a version row from before pointers and by-parent rows existed…
    await adapter.docClient!.send(
      new PutCommand({
        TableName: handle.tableName,
        Item: {
          id: 'lv1',
          createdAt: now,
          latest: true,
          parent: 'ld1',
          pk: 'drafts_versions',
          sk: 'lv1',
          updatedAt: now,
          version: { title: 'old' },
        },
      }),
    )
    // …in partitions whose indexes were never marked complete.
    for (const sk of [
      'legacy#index#code',
      'legacy#unique#email',
      'drafts_versions#index#parent',
      'drafts_versions#latest',
    ]) {
      await adapter.docClient!.send(
        new DeleteCommand({ TableName: handle.tableName, Key: { pk: 'payload-ddb#indexes', sk } }),
      )
    }

    const second = await boot('indexes-second', handle.tableName)
    const db = second.db as DynamoAdapter
    const legacy = async (where: Record<string, unknown>) => {
      const { partitionReads, result } = await traced(db, () =>
        second.find({ collection: 'legacy', depth: 0, limit: 0, where } as never),
      )
      return { found: result.docs.map((doc) => String(doc.id)).sort(), reads: partitionReads('legacy') }
    }

    const oldVersions = async () => {
      const { partitionReads, result } = await traced(db, () =>
        second.findVersions({
          collection: 'drafts',
          depth: 0,
          where: { parent: { equals: 'ld1' } },
        }),
      )
      return { found: result.docs.length, reads: partitionReads('drafts_versions') }
    }

    // Nothing points at the old documents yet, so the index isn't trusted.
    const before = await legacy({ code: { equals: 'old' } })
    expect(before.found).toEqual(['l1', 'l2'])
    expect(before.reads).toBeGreaterThan(0)
    const versionsBefore = await oldVersions()
    expect(versionsBefore.found).toBe(1)
    expect(versionsBefore.reads).toBeGreaterThan(0)

    const report = await backfillIndexes(second)
    expect(report.collections['legacy']).toMatchObject({
      guarded: 2,
      indexed: 3,
      // `email` holds a duplicate, so its index can't be complete.
      ready: ['code'],
      scanned: 3,
    })
    expect(report.collections['legacy']!.conflicts).toHaveLength(1)
    // Only the old document lacked a pointer; live ones already had theirs.
    expect(report.versions['drafts']!.pointers).toBe(1)
    expect(await oldVersions()).toEqual({ found: 1, reads: 0 })

    expect(await legacy({ code: { equals: 'old' } })).toEqual({ found: ['l1', 'l2'], reads: 0 })

    const duplicated = await legacy({ email: { equals: 'dup@example.com' } })
    expect(duplicated.found).toEqual(['l1', 'l2'])
    expect(duplicated.reads).toBeGreaterThan(0)

    // Once the duplicate is resolved, a second pass completes that index too.
    const loser = report.collections['legacy']!.conflicts[0]!.id
    await second.update({
      id: loser as string,
      collection: 'legacy',
      data: { email: 'fixed@example.com' },
    } as never)
    const again = await backfillIndexes(second)
    expect(again.collections['legacy']).toMatchObject({ conflicts: [], ready: ['code', 'email'] })
    expect(await legacy({ email: { equals: 'fixed@example.com' } })).toEqual({
      found: [String(loser)],
      reads: 0,
    })
  })
})

describe('with `indexes: false`', () => {
  it('writes no index rows, reads the partition except for ids, and retires the indexes', async () => {
    const tableName = randomTableName('indexes-off')
    const first = await boot('indexes-on-1', tableName, { ensureTables: true })
    closers.unshift(async () => {
      await deleteTable((first.db as DynamoAdapter).client!, tableName)
    })
    await first.create({
      collection: 'articles',
      data: { slug: 'kept', sku: 'Z', title: 'kept' },
    } as never)

    const off = await boot('indexes-off', tableName, { indexes: false })
    const db = off.db as DynamoAdapter
    const doc = await off.create({
      collection: 'articles',
      data: { slug: 'plain', sku: 'Z', title: 'plain' },
    } as never)
    // Only the row written while indexes were on.
    expect(await rawPartition('articles#index#sku', db, tableName)).toHaveLength(1)
    // Unique fields are still enforced through their guards.
    expect(await rawPartition('articles#unique#slug', db, tableName)).toHaveLength(2)

    const bySku = await traced(db, () => find({ sku: { equals: 'Z' } }, {}, off))
    expect(bySku.result.docs).toHaveLength(2)
    expect(bySku.partitionReads('articles')).toBeGreaterThan(0)

    const bySlug = await traced(db, () => find({ slug: { equals: 'plain' } }, {}, off))
    expect(bySlug.result.docs).toHaveLength(1)
    expect(bySlug.partitionReads('articles')).toBeGreaterThan(0)

    const byId = await traced(db, () => find({ id: { in: [doc.id] } }, {}, off))
    expect(byId.result.docs).toHaveLength(1)
    expect(byId.partitionReads('articles')).toBe(0)

    // Turned back on, the index lacks the document written in between, so it
    // must not be trusted until it is rebuilt.
    const back = await boot('indexes-on-2', tableName)
    const backDb = back.db as DynamoAdapter
    const before = await traced(backDb, () => find({ sku: { equals: 'Z' } }, {}, back))
    expect(before.result.docs).toHaveLength(2)
    expect(before.partitionReads('articles')).toBeGreaterThan(0)

    await backfillIndexes(back)
    const after = await traced(backDb, () => find({ sku: { equals: 'Z' } }, {}, back))
    expect(after.result.docs).toHaveLength(2)
    expect(after.partitionReads('articles')).toBe(0)
  })
})
