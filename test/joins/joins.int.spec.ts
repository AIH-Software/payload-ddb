import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { initPayloadTest, type TestHandle } from '../__helpers/initPayload.js'
import { config } from './config.js'

/**
 * Join fields store nothing on their own document; the adapter has to work
 * out, per returned document, which documents elsewhere point back at it.
 */

let handle: TestHandle
const ids: Record<string, number | string> = {}

type Joined = { docs: unknown[]; hasNextPage: boolean; totalDocs?: number }

beforeAll(async () => {
  handle = await initPayloadTest('joins', config)
  const { payload } = handle

  const news = await payload.create({ collection: 'categories', data: { name: 'news' } })
  const guides = await payload.create({ collection: 'categories', data: { name: 'guides' } })
  const empty = await payload.create({ collection: 'categories', data: { name: 'empty' } })
  Object.assign(ids, { empty: empty.id, guides: guides.id, news: news.id })

  const posts = [
    { title: 'n1', rank: 1, category: news.id, categories: [news.id, guides.id] },
    { title: 'n2', rank: 2, category: news.id, categories: [guides.id] },
    { title: 'n3', rank: 3, category: news.id },
    { title: 'g1', rank: 4, category: guides.id },
  ]
  for (const data of posts) {
    const doc = await payload.create({ collection: 'posts', data })
    ids[data.title] = doc.id
  }
  const page = await payload.create({
    collection: 'pages',
    data: { title: 'about', category: news.id },
  })
  ids['about'] = page.id
})

afterAll(async () => {
  // `handle` is undefined when beforeAll threw before assignment. Guard so
  // afterAll's TypeError doesn't mask the real error from beforeAll.
  await (handle as TestHandle | undefined)?.cleanup()
})

const category = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await handle.payload.find({
    collection: 'categories',
    depth: 0,
    where: { name: { equals: name } },
    ...args,
  } as never)
  return result.docs[0] as unknown as Record<string, Joined>
}

const sorted = (values: unknown[]) => [...values].map(String).sort()

describe('join fields', () => {
  it('lists the ids of documents pointing back, per parent', async () => {
    const news = await category('news')
    expect(sorted(news.posts.docs)).toEqual(sorted([ids['n1'], ids['n2'], ids['n3']]))
    expect(news.posts.hasNextPage).toBe(false)

    const guides = await category('guides')
    expect(guides.posts.docs).toEqual([ids['g1']])
  })

  it('gives a parent with nothing joined an empty list', async () => {
    const empty = await category('empty')
    expect(empty.posts).toEqual({ docs: [], hasNextPage: false })
  })

  it('follows a hasMany `on` field', async () => {
    const guides = await category('guides')
    expect(sorted(guides.tagged.docs)).toEqual(sorted([ids['n1'], ids['n2']]))
    const news = await category('news')
    expect(news.tagged.docs).toEqual([ids['n1']])
  })

  it('applies limit, sort, where and count per parent', async () => {
    const news = await category('news', {
      joins: { posts: { count: true, limit: 1, sort: '-rank', where: { rank: { less_than: 3 } } } },
    })
    // Of n1 (1) and n2 (2), the highest rank first, one per page.
    expect(news.posts).toEqual({ docs: [ids['n2']], hasNextPage: true, totalDocs: 2 })

    const second = await category('news', {
      joins: { posts: { limit: 1, page: 2, sort: '-rank', where: { rank: { less_than: 3 } } } },
    })
    expect(second.posts).toEqual({ docs: [ids['n1']], hasNextPage: false })
  })

  it('pages each parent independently when several are returned', async () => {
    const result = await handle.payload.find({
      collection: 'categories',
      depth: 0,
      joins: { posts: { limit: 2, sort: 'rank' } },
      sort: 'name',
    } as never)
    const byName = Object.fromEntries(
      result.docs.map((doc) => [String(doc.name), (doc as unknown as Record<string, Joined>).posts]),
    )
    expect(byName['news']).toEqual({ docs: [ids['n1'], ids['n2']], hasNextPage: true })
    expect(byName['guides']).toEqual({ docs: [ids['g1']], hasNextPage: false })
    expect(byName['empty']).toEqual({ docs: [], hasNextPage: false })
  })

  it('skips a join that is switched off', async () => {
    const news = await category('news', { joins: { posts: false } })
    expect(news.posts).toBeUndefined()
    expect(news.tagged.docs).toEqual([ids['n1']])
  })

  it('lets core populate the joined documents at depth', async () => {
    const news = await category('news', { depth: 1, joins: { posts: { sort: 'rank' } } })
    expect((news.posts.docs as { title: string }[]).map((doc) => doc.title)).toEqual([
      'n1',
      'n2',
      'n3',
    ])
  })

  it('resolves joins on findByID too', async () => {
    const news = (await handle.payload.findByID({
      collection: 'categories',
      depth: 0,
      id: ids['news']!,
    })) as unknown as Record<string, Joined>
    expect(news.posts.docs).toHaveLength(3)
  })

  it('a polymorphic join tags each entry with its collection', async () => {
    const news = await category('news')
    const entries = news.everything.docs as { relationTo: string; value: unknown }[]
    expect(entries).toHaveLength(4)
    expect(entries.filter((entry) => entry.relationTo === 'pages')).toEqual([
      { relationTo: 'pages', value: ids['about'] },
    ])

    const onlyPages = await category('news', {
      joins: { everything: { where: { relationTo: { equals: 'pages' } } } },
    })
    expect(onlyPages.everything.docs).toEqual([{ relationTo: 'pages', value: ids['about'] }])
  })
})
