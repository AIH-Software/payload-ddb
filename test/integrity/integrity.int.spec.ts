import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { ValidationError } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { backfillUniqueGuards, type DynamoAdapter } from '../../src/index.js'
import { initPayloadTest, type TestHandle } from '../__helpers/initPayload.js'
import { config } from './config.js'

/**
 * The guarantees a schemaless, lock-free store doesn't give for free:
 * concurrent writers don't overwrite each other, a queued job is claimed
 * once, and `unique: true` means unique.
 */

let handle: TestHandle
let adapter: DynamoAdapter

beforeAll(async () => {
  handle = await initPayloadTest('integrity', config)
  adapter = handle.payload.db as DynamoAdapter
})

afterAll(async () => {
  // `handle` is undefined when beforeAll threw before assignment. Guard so
  // afterAll's TypeError doesn't mask the real error from beforeAll.
  await (handle as TestHandle | undefined)?.cleanup()
})

/** Every row in a partition, guards and all, straight from the table. */
async function rawPartition(pk: string) {
  const result = await adapter.docClient!.send(
    new QueryCommand({
      TableName: handle.tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': pk },
    }),
  )
  return result.Items ?? []
}

async function rawRow(pk: string, id: unknown) {
  const result = await adapter.docClient!.send(
    new GetCommand({ TableName: handle.tableName, Key: { pk, sk: String(id) } }),
  )
  return result.Item
}

const uniqueErrorOn = (path: string) => ({ data: { errors: [{ path }] } })

async function clear(collection: string) {
  await adapter.deleteMany({ collection, where: {} })
}

describe('concurrent updates', () => {
  beforeEach(() => clear('accounts'))

  it('patches to different fields all land', async () => {
    const created = await adapter.create({ collection: 'accounts', data: { bio: 'start' } })
    const fields = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

    // Without a revision check each read-merge-write would put back the
    // whole row as it read it, wiping whatever the others had just written.
    await Promise.all(
      fields.map((field, index) =>
        adapter.updateOne({
          collection: 'accounts',
          data: { [field]: index + 1 },
          id: created.id,
        }),
      ),
    )

    const after = await adapter.findOne({
      collection: 'accounts',
      where: { id: { equals: created.id } },
    })
    expect(after).toMatchObject({ a: 1, b: 2, bio: 'start', c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 })
  })

  it('keeps the revision counter out of documents', async () => {
    const created = await adapter.create({ collection: 'accounts', data: { bio: 'x' } })
    const updated = await adapter.updateOne({
      collection: 'accounts',
      data: { bio: 'y' },
      id: created.id,
    })

    expect(created).not.toHaveProperty('_rev')
    expect(updated).not.toHaveProperty('_rev')
    expect((await rawRow('accounts', created.id))?._rev).toBe(2)
  })

  it('updates a row written before revisions existed', async () => {
    await adapter.docClient!.send(
      new PutCommand({
        TableName: handle.tableName,
        Item: { bio: 'legacy', id: 'legacy-1', pk: 'accounts', sk: 'legacy-1' },
      }),
    )

    const updated = await adapter.updateOne({
      collection: 'accounts',
      data: { bio: 'modern' },
      id: 'legacy-1',
    })

    expect(updated).toMatchObject({ bio: 'modern', id: 'legacy-1' })
    expect((await rawRow('accounts', 'legacy-1'))?._rev).toBe(1)
  })
})

describe('jobs queue', () => {
  beforeEach(() => clear('payload-jobs'))

  const queue = (count: number) =>
    Promise.all(
      Array.from({ length: count }, (_, index) =>
        adapter.create({
          collection: 'payload-jobs',
          data: { input: { index }, processing: false, taskSlug: 'noop' },
        }),
      ),
    )

  it('a job is claimed by one worker only', async () => {
    await queue(3)

    const claims = await Promise.all(
      Array.from({ length: 8 }, () =>
        adapter.updateJobs({
          data: { processing: true },
          limit: 1,
          where: { processing: { equals: false } },
        }),
      ),
    )

    const claimed = claims.flatMap((jobs) => jobs ?? []).map((job) => String(job.id))
    expect(claimed.length).toBeGreaterThan(0)
    expect(new Set(claimed).size).toBe(claimed.length)

    const processing = await adapter.count({
      collection: 'payload-jobs',
      where: { processing: { equals: true } },
    })
    expect(processing.totalDocs).toBe(claimed.length)
  })

  it('claims up to `limit` jobs in one call', async () => {
    await queue(3)

    const claimed = await adapter.updateJobs({
      data: { processing: true },
      limit: 2,
      where: { processing: { equals: false } },
    })

    expect(claimed).toHaveLength(2)
    expect(claimed?.every((job) => job.processing === true)).toBe(true)
  })

  it('`log: { $push }` appends instead of replacing', async () => {
    const [job] = await queue(1)

    await adapter.updateJobs({
      data: { log: { $push: { id: 'l1', state: 'succeeded', taskSlug: 'noop' } } },
      id: job!.id,
    })
    const [after] =
      (await adapter.updateJobs({
        data: { log: { $push: { id: 'l2', state: 'failed', taskSlug: 'noop' } }, totalTried: 1 },
        id: job!.id,
      })) ?? []

    expect((after?.log as { id: string }[]).map((entry) => entry.id)).toEqual(['l1', 'l2'])
    expect(after?.totalTried).toBe(1)
  })
})

describe('unique fields', () => {
  beforeEach(async () => {
    await clear('accounts')
    await clear('pages')
  })

  it('rejects a second document with the same value', async () => {
    const first = await adapter.create({ collection: 'accounts', data: { handle: 'ada' } })

    const attempt = adapter.create({ collection: 'accounts', data: { handle: 'ada' } })
    await expect(attempt).rejects.toBeInstanceOf(ValidationError)
    await expect(attempt).rejects.toMatchObject(uniqueErrorOn('handle'))

    const all = await adapter.find({ collection: 'accounts', limit: 0 })
    expect(all.docs.map((doc) => doc.id)).toEqual([first.id])
  })

  it('reports the field through the local API as well', async () => {
    await handle.payload.create({ collection: 'accounts', data: { handle: 'bob' } })
    await expect(
      handle.payload.create({ collection: 'accounts', data: { handle: 'bob' } }),
    ).rejects.toMatchObject(uniqueErrorOn('handle'))
  })

  it('covers a unique field nested in a group', async () => {
    await adapter.create({ collection: 'accounts', data: { profile: { slug: 'x' } } })
    await expect(
      adapter.create({ collection: 'accounts', data: { profile: { slug: 'x' } } }),
    ).rejects.toMatchObject(uniqueErrorOn('profile.slug'))
  })

  it('lets any number of documents leave the field blank', async () => {
    await adapter.create({ collection: 'accounts', data: { bio: 'one' } })
    await adapter.create({ collection: 'accounts', data: { bio: 'two', handle: '' } })
    await adapter.create({ collection: 'accounts', data: { bio: 'three', handle: null } })
    expect((await adapter.count({ collection: 'accounts' })).totalDocs).toBe(3)
  })

  it('lets exactly one of several simultaneous creates win', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        adapter.create({ collection: 'accounts', data: { handle: 'race' } }),
      ),
    )

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    for (const attempt of attempts) {
      if (attempt.status === 'rejected') expect(attempt.reason).toBeInstanceOf(ValidationError)
    }
    expect((await adapter.count({ collection: 'accounts' })).totalDocs).toBe(1)
  })

  it('checks updates, and frees a value once it is changed or deleted', async () => {
    const ada = await adapter.create({ collection: 'accounts', data: { handle: 'ada' } })
    const bob = await adapter.create({ collection: 'accounts', data: { handle: 'bob' } })

    // Taking someone else's value is rejected and changes nothing.
    await expect(
      adapter.updateOne({ collection: 'accounts', data: { handle: 'ada' }, id: bob.id }),
    ).rejects.toMatchObject(uniqueErrorOn('handle'))
    // Re-saving your own value is fine.
    await adapter.updateOne({ collection: 'accounts', data: { bio: 'hi', handle: 'bob' }, id: bob.id })

    // Ada moves on; her old handle becomes available.
    await adapter.updateOne({ collection: 'accounts', data: { handle: 'lovelace' }, id: ada.id })
    await adapter.updateOne({ collection: 'accounts', data: { handle: 'ada' }, id: bob.id })

    // Deleting releases too — by id, and in bulk.
    await adapter.deleteOne({ collection: 'accounts', where: { id: { equals: bob.id } } })
    const reused = await adapter.create({ collection: 'accounts', data: { handle: 'ada' } })
    await adapter.deleteMany({ collection: 'accounts', where: { handle: { equals: 'ada' } } })
    await adapter.create({ collection: 'accounts', data: { handle: 'ada' } })

    expect(reused.handle).toBe('ada')
  })

  it('applies to upsert and updateMany', async () => {
    await adapter.create({ collection: 'accounts', data: { handle: 'taken' } })
    const other = await adapter.create({ collection: 'accounts', data: { bio: 'free' } })

    await expect(
      adapter.upsert({
        collection: 'accounts',
        data: { handle: 'taken' },
        where: { id: { equals: other.id } },
      }),
    ).rejects.toMatchObject(uniqueErrorOn('handle'))
    await expect(
      adapter.updateMany({
        collection: 'accounts',
        data: { handle: 'taken' },
        where: { bio: { equals: 'free' } },
      }),
    ).rejects.toMatchObject(uniqueErrorOn('handle'))
  })

  it('keeps guard rows out of the collection and removes them with the data', async () => {
    const doc = await adapter.create({
      collection: 'accounts',
      data: { handle: 'solo', profile: { slug: 'solo-slug' } },
    })

    expect(await rawPartition('accounts#unique#handle')).toEqual([
      { owner: String(doc.id), pk: 'accounts#unique#handle', sk: 's:solo' },
    ])
    expect(await rawPartition('accounts')).toHaveLength(1)

    await adapter.deleteOne({ collection: 'accounts', where: { id: { equals: doc.id } } })
    expect(await rawPartition('accounts#unique#handle')).toEqual([])
    expect(await rawPartition('accounts#unique#profile.slug')).toEqual([])
  })

  it('is per locale for a localized field', async () => {
    const page = await handle.payload.create({
      collection: 'pages',
      data: { title: 'Home' },
      locale: 'en',
    })
    // The same text in another locale is a different value.
    await handle.payload.update({
      collection: 'pages',
      data: { title: 'Home' },
      id: page.id,
      locale: 'es',
    })

    await expect(
      handle.payload.create({ collection: 'pages', data: { title: 'Home' }, locale: 'en' }),
    ).rejects.toMatchObject(uniqueErrorOn('title'))
  })

  it('enforces an auth collection’s email at the database, not only in core', async () => {
    const data = { email: 'dup@example.com', hash: 'h', salt: 's' }
    await adapter.create({ collection: 'members', data })
    await expect(adapter.create({ collection: 'members', data })).rejects.toMatchObject(
      uniqueErrorOn('email'),
    )
  })
})

describe('backfillUniqueGuards', () => {
  beforeEach(() => clear('accounts'))

  it('guards documents written before guards existed and reports duplicates', async () => {
    // Rows as the previous version of the adapter left them: no guards.
    const legacy = [
      { handle: 'old-timer', id: 'l1' },
      { handle: 'twin', id: 'l2' },
      { handle: 'twin', id: 'l3' },
    ]
    for (const row of legacy) {
      await adapter.docClient!.send(
        new PutCommand({
          TableName: handle.tableName,
          Item: { ...row, pk: 'accounts', sk: row.id },
        }),
      )
    }

    const report = await backfillUniqueGuards(handle.payload)
    const accounts = report.collections['accounts']!
    expect(accounts.scanned).toBe(3)
    expect(accounts.guarded).toBe(2)
    expect(accounts.conflicts).toHaveLength(1)
    expect(accounts.conflicts[0]).toMatchObject({ path: 'handle' })
    expect(['l2', 'l3']).toContain(accounts.conflicts[0]!.id)

    // The old value is now protected.
    await expect(
      adapter.create({ collection: 'accounts', data: { handle: 'old-timer' } }),
    ).rejects.toMatchObject(uniqueErrorOn('handle'))

    // Re-running changes nothing.
    const again = await backfillUniqueGuards(handle.payload)
    expect(again.collections['accounts']).toMatchObject({ guarded: 2, scanned: 3 })
  })
})
