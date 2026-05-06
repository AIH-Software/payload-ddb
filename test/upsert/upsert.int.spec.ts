import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { DynamoAdapter } from '../../src/index.js'

import { initPayloadTest, type TestHandle } from '../__helpers/initPayload.js'
import { config } from './config.js'

let handle: TestHandle

beforeAll(async () => {
  handle = await initPayloadTest('upsert', config)
})

afterAll(async () => {
  // `handle` is undefined when beforeAll threw before assignment. Guard so
  // afterAll's TypeError doesn't mask the real error from beforeAll.
  await (handle as TestHandle | undefined)?.cleanup()
})

beforeEach(async () => {
  const all = await handle.payload.find({ collection: 'pages', limit: 0, pagination: false })
  await Promise.all(
    all.docs.map((doc) => handle.payload.delete({ collection: 'pages', id: doc.id })),
  )
})

describe('upsert — adapter direct call', () => {
  it('inserts when no row matches `where`', async () => {
    const adapter = handle.payload.db as DynamoAdapter

    const result = await adapter.upsert({
      collection: 'pages',
      where: { slug: { equals: 'home' } },
      data: { slug: 'home', title: 'Home', views: 10 },
    })

    expect(result?.id).toBeTruthy()
    expect(result).toMatchObject({ slug: 'home', title: 'Home', views: 10 })

    // Persisted — a follow-up find sees it.
    const found = await handle.payload.find({
      collection: 'pages',
      where: { slug: { equals: 'home' } },
    })
    expect(found.totalDocs).toBe(1)
  })

  it('merges into the existing row when a match is found', async () => {
    const adapter = handle.payload.db as DynamoAdapter

    const initial = await handle.payload.create({
      collection: 'pages',
      data: { slug: 'home', title: 'Home', views: 5 },
    })

    const updated = await adapter.upsert({
      collection: 'pages',
      where: { slug: { equals: 'home' } },
      data: { views: 99 },
    })

    expect(updated?.id).toBe(initial.id)
    expect(updated?.title).toBe('Home') // preserved
    expect(updated?.views).toBe(99) // overwritten

    // Still exactly one row — upsert merged in place rather than inserting.
    const all = await handle.payload.find({ collection: 'pages' })
    expect(all.totalDocs).toBe(1)
  })
})
