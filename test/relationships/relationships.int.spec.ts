import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { initPayloadTest, type TestHandle } from '../__helpers/initPayload.js'
import { config } from './config.js'

let handle: TestHandle

beforeAll(async () => {
  handle = await initPayloadTest('relationships', config)
})

afterAll(async () => {
  await handle.cleanup()
})

describe('relationship fields', () => {
  it('single relationship round-trips and resolves at depth=1', async () => {
    const author = await handle.payload.create({
      collection: 'authors',
      data: { name: 'Octavia' },
    })

    const post = await handle.payload.create({
      collection: 'posts',
      data: { title: 'p1', author: author.id },
    })

    const fetched = await handle.payload.findByID({
      collection: 'posts',
      id: post.id,
      depth: 1,
    })
    // depth=1 means the related doc is hydrated, not just an id
    expect(typeof fetched.author).toBe('object')
    expect((fetched.author as { name: string }).name).toBe('Octavia')
  })

  it('hasMany relationship persists an array of ids', async () => {
    const t1 = await handle.payload.create({ collection: 'tags', data: { label: 'js' } })
    const t2 = await handle.payload.create({ collection: 'tags', data: { label: 'ts' } })

    const post = await handle.payload.create({
      collection: 'posts',
      data: { title: 'tagged', tags: [t1.id, t2.id] },
    })

    const fetched = await handle.payload.findByID({
      collection: 'posts',
      id: post.id,
      depth: 0,
    })
    expect(fetched.tags).toEqual([t1.id, t2.id])
  })

  it('polymorphic relationship persists {relationTo, value}', async () => {
    const author = await handle.payload.create({
      collection: 'authors',
      data: { name: 'related-author' },
    })

    const post = await handle.payload.create({
      collection: 'posts',
      data: {
        title: 'poly',
        related: { relationTo: 'authors', value: author.id },
      },
    })

    const fetched = await handle.payload.findByID({
      collection: 'posts',
      id: post.id,
      depth: 0,
    })
    expect(fetched.related).toEqual({ relationTo: 'authors', value: author.id })
  })

  it('queries by single relationship id', async () => {
    const author = await handle.payload.create({
      collection: 'authors',
      data: { name: 'queryable' },
    })
    await handle.payload.create({
      collection: 'posts',
      data: { title: 'a', author: author.id },
    })
    await handle.payload.create({
      collection: 'posts',
      data: { title: 'b' },
    })

    const result = await handle.payload.find({
      collection: 'posts',
      where: { author: { equals: author.id } },
      depth: 0,
    })
    expect(result.totalDocs).toBe(1)
    expect(result.docs[0]?.title).toBe('a')
  })
})
