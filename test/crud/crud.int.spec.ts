import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { DynamoAdapter } from '../../src/index.js'

import { initPayloadTest, type TestHandle } from '../__helpers/initPayload.js'
import { config } from './config.js'

let handle: TestHandle

beforeAll(async () => {
  handle = await initPayloadTest('crud', config)
})

afterAll(async () => {
  await handle.cleanup()
})

beforeEach(async () => {
  // Each test starts from an empty `posts` partition. Reusing one payload
  // instance across tests is much faster than re-booting per test, but
  // requires us to drop docs in between.
  const all = await handle.payload.find({ collection: 'posts', limit: 0, pagination: false })
  await Promise.all(
    all.docs.map((doc) => handle.payload.delete({ collection: 'posts', id: doc.id })),
  )
})

describe('CRUD — create / findByID / find / update / delete / count', () => {
  it('create persists the row with id, content, and timestamps at the expected pk/sk', async () => {
    // Read the row directly through the adapter's docClient to verify the
    // pk/sk shape — which is the contract every other adapter method depends on.
    const created = await handle.payload.create({
      collection: 'posts',
      data: { title: 'first' },
    })
    expect(created.id).toBeTruthy()

    const adapter = handle.payload.db as DynamoAdapter
    const result = await adapter.docClient!.send(
      new GetCommand({
        TableName: handle.tableName,
        Key: { pk: 'posts', sk: String(created.id) },
      }),
    )
    expect(result.Item).toBeDefined()
    expect(result.Item?.id).toBe(created.id)
    expect(result.Item?.title).toBe('first')
    expect(result.Item?.createdAt).toBeTruthy()
    expect(result.Item?.updatedAt).toBeTruthy()
  })

  it('create honors explicit createdAt/updatedAt in data (migration backdating)', async () => {
    // The nullish-coalesce defaults shouldn't override values supplied by
    // payload (versions/restore) or by migrations backdating timestamps.
    const backdated = '2020-01-15T00:00:00.000Z'
    const created = await handle.payload.create({
      collection: 'posts',
      data: { title: 'old', createdAt: backdated, updatedAt: backdated },
    })

    const adapter = handle.payload.db as DynamoAdapter
    const result = await adapter.docClient!.send(
      new GetCommand({
        TableName: handle.tableName,
        Key: { pk: 'posts', sk: String(created.id) },
      }),
    )
    expect(result.Item?.createdAt).toBe(backdated)
    expect(result.Item?.updatedAt).toBe(backdated)
  })

  it('findByID returns the persisted shape', async () => {
    const created = await handle.payload.create({
      collection: 'posts',
      data: {
        title: 'shape',
        priority: 5,
        meta: { author: 'dby', wordCount: 42 },
        tags: [{ label: 'a' }, { label: 'b' }],
      },
    })

    const found = await handle.payload.findByID({ collection: 'posts', id: created.id })
    expect(found).toMatchObject({
      id: created.id,
      title: 'shape',
      priority: 5,
      meta: { author: 'dby', wordCount: 42 },
    })
    expect(found.tags).toHaveLength(2)
    expect(found.tags?.[0]?.label).toBe('a')
  })

  it('updateByID merges patches without dropping unmentioned fields', async () => {
    const created = await handle.payload.create({
      collection: 'posts',
      data: { title: 'merge', priority: 1, meta: { author: 'dby' } },
    })

    const updated = await handle.payload.update({
      collection: 'posts',
      id: created.id,
      data: { priority: 99 },
    })

    expect(updated.title).toBe('merge')
    expect(updated.priority).toBe(99)
    expect(updated.meta?.author).toBe('dby')
    // updatedAt is bumped automatically by the adapter
    expect(updated.updatedAt).not.toBe(created.updatedAt)
  })

  it('updateByID returns null shape when target does not exist', async () => {
    // Adapter returns null; payload core wraps that as a NotFound error.
    await expect(
      handle.payload.update({
        collection: 'posts',
        id: 'does-not-exist',
        data: { title: 'x' },
      }),
    ).rejects.toThrow()
  })

  it('delete removes the doc and subsequent findByID throws NotFound', async () => {
    const created = await handle.payload.create({
      collection: 'posts',
      data: { title: 'doomed' },
    })

    await handle.payload.delete({ collection: 'posts', id: created.id })

    await expect(
      handle.payload.findByID({ collection: 'posts', id: created.id }),
    ).rejects.toThrow()
  })

  it('count returns the total of matching docs', async () => {
    await handle.payload.create({ collection: 'posts', data: { title: 'a', priority: 1 } })
    await handle.payload.create({ collection: 'posts', data: { title: 'b', priority: 2 } })
    await handle.payload.create({ collection: 'posts', data: { title: 'c', priority: 2 } })

    const all = await handle.payload.count({ collection: 'posts' })
    expect(all.totalDocs).toBe(3)

    const filtered = await handle.payload.count({
      collection: 'posts',
      where: { priority: { equals: 2 } },
    })
    expect(filtered.totalDocs).toBe(2)
  })
})

describe('CRUD — pagination', () => {
  beforeEach(async () => {
    // Seed 25 docs with predictable priority for sort/page assertions.
    for (let i = 0; i < 25; i++) {
      await handle.payload.create({
        collection: 'posts',
        data: { title: `post-${i}`, priority: i },
      })
    }
  })

  it('paginates with default limit', async () => {
    const page1 = await handle.payload.find({
      collection: 'posts',
      limit: 10,
      page: 1,
      sort: 'priority',
    })
    expect(page1.docs).toHaveLength(10)
    expect(page1.totalDocs).toBe(25)
    expect(page1.totalPages).toBe(3)
    expect(page1.hasNextPage).toBe(true)
    expect(page1.hasPrevPage).toBe(false)
    expect(page1.docs[0]?.priority).toBe(0)
    expect(page1.docs[9]?.priority).toBe(9)
  })

  it('returns last page metadata correctly', async () => {
    const page3 = await handle.payload.find({
      collection: 'posts',
      limit: 10,
      page: 3,
      sort: 'priority',
    })
    expect(page3.docs).toHaveLength(5)
    expect(page3.hasNextPage).toBe(false)
    expect(page3.hasPrevPage).toBe(true)
    expect(page3.docs[0]?.priority).toBe(20)
  })

  it('pagination=false still slices by limit/page (the invariant)', async () => {
    // The invariant from src/find.ts: `pagination: false` only suppresses
    // count metadata — limit/page still control which slice of rows comes
    // back. enforceMaxVersions relies on this to fetch a single old version.
    const sliced = await handle.payload.find({
      collection: 'posts',
      limit: 5,
      page: 2,
      pagination: false,
      sort: 'priority',
    })
    expect(sliced.docs).toHaveLength(5)
    expect(sliced.docs[0]?.priority).toBe(5)
    expect(sliced.docs[4]?.priority).toBe(9)
    // Metadata flags reflect the suppressed accounting.
    expect(sliced.hasNextPage).toBe(false)
    expect(sliced.hasPrevPage).toBe(false)
    expect(sliced.totalPages).toBe(1)
  })

  it('limit:0 returns every doc and pagination computes a single page', async () => {
    const all = await handle.payload.find({
      collection: 'posts',
      limit: 0,
      sort: 'priority',
    })
    expect(all.docs).toHaveLength(25)
    expect(all.totalDocs).toBe(25)
    expect(all.totalPages).toBe(1)
    expect(all.limit).toBe(25)
    expect(all.hasNextPage).toBe(false)
  })

  it('descending sort works', async () => {
    const desc = await handle.payload.find({
      collection: 'posts',
      limit: 5,
      sort: '-priority',
    })
    expect(desc.docs.map((d) => d.priority)).toEqual([24, 23, 22, 21, 20])
  })
})
