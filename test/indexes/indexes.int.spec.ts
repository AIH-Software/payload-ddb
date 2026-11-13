import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { type Args, backfillIndexes, dynamoAdapter, type DynamoAdapter } from '../../src/index.js'
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
      /** How many `Query`s walked `partition` itself (not a key prefix of it). */
      partitionReads: (partition: string) =>
        sent.filter(
          ({ name, input }) =>
            name === 'QueryCommand' &&
            input['ExpressionAttributeValues']?.[':pk'] === partition &&
            !(':prefix' in input['ExpressionAttributeValues']),
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
    typescript: { declare: false },
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
      String(row['sk']).startsWith(`s:${value}#`),
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
    // …the document, its slug guard and the one new `rank` row — no `sku` row.
    expect(writes[0]!.input['TransactItems']).toHaveLength(3)

    await payload.delete({ id: doc.id, collection: 'articles' })
    expect(await lookup({ sku: { equals: 'after' } })).toEqual({ reads: 0, titles: [] })
    expect(await skuRows('after')).toHaveLength(0)
    expect(await lookup({ slug: { equals: 'mover' } })).toEqual({ reads: 0, titles: [] })
  })

  it('ignores a stray row that points at a document without the value', async () => {
    await adapter.docClient!.send(
      new PutCommand({
        TableName: handle.tableName,
        Item: { pk: 'articles#index#sku', sk: `s:B#${ids['one']}`, owner: String(ids['one']) },
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
    expect(await lookup({ tags: { equals: 't0' } })).toEqual({ reads: 0, titles: ['wide'] })
    expect(await lookup({ tags: { equals: 't149' } })).toEqual({ reads: 0, titles: ['wide'] })

    await payload.update({ id: doc.id, collection: 'articles', data: { tags: ['only'] } } as never)
    expect(await lookup({ tags: { equals: 't149' } })).toEqual({ reads: 0, titles: [] })
    expect(await lookup({ tags: { equals: 'only' } })).toEqual({ reads: 0, titles: ['wide'] })
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
    // …in a collection whose indexes were never marked complete.
    for (const sk of ['legacy#index#code', 'legacy#unique#email']) {
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

    // Nothing points at the old documents yet, so the index isn't trusted.
    const before = await legacy({ code: { equals: 'old' } })
    expect(before.found).toEqual(['l1', 'l2'])
    expect(before.reads).toBeGreaterThan(0)

    const report = await backfillIndexes(second)
    expect(report.collections['legacy']).toMatchObject({
      guarded: 2,
      indexed: 3,
      // `email` holds a duplicate, so its index can't be complete.
      ready: ['code'],
      scanned: 3,
    })
    expect(report.collections['legacy']!.conflicts).toHaveLength(1)

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
