import type { Where } from 'payload'

import { handleEndpoints } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { initPayloadTest, type TestHandle } from '../__helpers/initPayload.js'
import { config } from './config.js'

/**
 * Queries whose path doesn't land on one plain value: `hasMany` fields,
 * arrays and blocks of objects, keys inside `json`, and paths that step
 * through a relationship into another collection. Plus the operators that
 * only make sense in JS (`contains`, `not_like`, `all`, and the geo trio).
 */

let handle: TestHandle
const ids: Record<string, number | string> = {}

// Roughly: Berlin, Potsdam (~27 km from Berlin), Munich (~500 km).
const BERLIN = [13.405, 52.52]
const POTSDAM = [13.0645, 52.3906]
const MUNICH = [11.582, 48.1351]

beforeAll(async () => {
  handle = await initPayloadTest('paths', config)
  const { payload } = handle

  const core = await payload.create({ collection: 'teams', data: { name: 'Core' } })
  const docs = await payload.create({ collection: 'teams', data: { name: 'Docs' } })
  const ada = await payload.create({ collection: 'authors', data: { name: 'Ada', team: core.id } })
  const bob = await payload.create({ collection: 'authors', data: { name: 'Bob', team: docs.id } })
  const cy = await payload.create({ collection: 'authors', data: { name: 'Cy' } })
  Object.assign(ids, { ada: ada.id, bob: bob.id, core: core.id, cy: cy.id })

  const seed = [
    {
      title: 'alpha',
      tags: ['Red', 'blue'],
      scores: [1, 9],
      kinds: ['news', 'guide'],
      author: ada.id,
      reviewers: [bob.id, cy.id],
      items: [
        { label: 'bolt', qty: 2 },
        { label: 'nut', qty: 12 },
      ],
      layout: [
        { blockType: 'quote', text: 'Hello there' },
        { blockType: 'stat', value: 7 },
      ],
      meta: { flags: ['a', 'b'], nested: { level: 3 } },
      location: BERLIN,
    },
    {
      title: 'beta',
      tags: ['green'],
      scores: [4],
      kinds: ['opinion'],
      author: bob.id,
      reviewers: [ada.id],
      items: [{ label: 'washer', qty: 5 }],
      layout: [{ blockType: 'stat', value: 2 }],
      meta: { flags: ['c'] },
      location: POTSDAM,
    },
    // No list-shaped values at all: negative operators must still match it.
    { title: 'gamma', author: cy.id, location: MUNICH },
  ]
  for (const data of seed) {
    await payload.create({ collection: 'posts', data: data as never })
  }
})

afterAll(async () => {
  // `handle` is undefined when beforeAll threw before assignment. Guard so
  // afterAll's TypeError doesn't mask the real error from beforeAll.
  await (handle as TestHandle | undefined)?.cleanup()
})

async function titles(where: Where): Promise<string[]> {
  const result = await handle.payload.find({
    collection: 'posts',
    limit: 0,
    pagination: false,
    where,
  })
  return result.docs.map((doc) => String(doc.title)).sort()
}

describe('hasMany values', () => {
  const cases: { expected: string[]; title: string; where: Where }[] = [
    { title: 'equals matches any element', where: { tags: { equals: 'blue' } }, expected: ['alpha'] },
    { title: 'in matches any element', where: { tags: { in: ['green', 'nope'] } }, expected: ['beta'] },
    {
      title: 'not_equals holds only when no element matches',
      where: { tags: { not_equals: 'blue' } },
      expected: ['beta', 'gamma'],
    },
    {
      title: 'not_in holds only when no element matches',
      where: { tags: { not_in: ['blue', 'green'] } },
      expected: ['gamma'],
    },
    {
      title: 'contains is a case-insensitive substring of any element',
      where: { tags: { contains: 'RE' } },
      expected: ['alpha', 'beta'],
    },
    {
      title: 'all requires every operand to be present',
      where: { tags: { all: ['Red', 'blue'] } },
      expected: ['alpha'],
    },
    {
      title: 'all fails when one operand is missing',
      where: { tags: { all: ['Red', 'green'] } },
      expected: [],
    },
    {
      title: 'greater_than on numbers matches any element',
      where: { scores: { greater_than: 8 } },
      expected: ['alpha'],
    },
    {
      title: 'a hasMany select "contains" an option it has',
      where: { kinds: { contains: 'guide' } },
      expected: ['alpha'],
    },
    {
      title: 'exists is false for a missing list',
      where: { tags: { exists: false } },
      expected: ['gamma'],
    },
  ]

  it.each(cases)('$title', async ({ expected, where }) => {
    expect(await titles(where)).toEqual(expected)
  })

  it('relationship: equals and in match any related id', async () => {
    expect(await titles({ reviewers: { equals: ids['cy'] } })).toEqual(['alpha'])
    expect(await titles({ reviewers: { in: [ids['ada']] } })).toEqual(['beta'])
  })

  it('string operands from a REST query are cast per element type', async () => {
    const response = await handleEndpoints({
      config: handle.payload.config,
      request: new Request('http://localhost/api/posts?limit=0&where[scores][greater_than]=8'),
    })
    const body = (await response.json()) as { docs: { title: string }[] }
    expect(body.docs.map((doc) => doc.title)).toEqual(['alpha'])
  })

  it('count agrees with find', async () => {
    const counted = await handle.payload.count({
      collection: 'posts',
      where: { tags: { not_equals: 'blue' } },
    })
    expect(counted.totalDocs).toBe(2)
  })

  it('combines with a plain clause', async () => {
    expect(
      await titles({ and: [{ title: { not_equals: 'alpha' } }, { scores: { less_than: 5 } }] }),
    ).toEqual(['beta'])
    expect(
      await titles({ or: [{ title: { equals: 'gamma' } }, { tags: { equals: 'green' } }] }),
    ).toEqual(['beta', 'gamma'])
  })
})

describe('paths through lists of objects', () => {
  const cases: { expected: string[]; title: string; where: Where }[] = [
    {
      title: 'array: equals on a sub-field of any row',
      where: { 'items.label': { equals: 'nut' } },
      expected: ['alpha'],
    },
    {
      title: 'array: numeric comparison on a sub-field of any row',
      where: { 'items.qty': { greater_than: 4 } },
      expected: ['alpha', 'beta'],
    },
    {
      title: 'array: not_equals holds only when no row matches',
      where: { 'items.label': { not_equals: 'washer' } },
      expected: ['alpha', 'gamma'],
    },
    {
      title: 'blocks: like on a sub-field of any block',
      where: { 'layout.text': { like: 'hello' } },
      expected: ['alpha'],
    },
    {
      title: 'blocks: numeric comparison on a sub-field of any block',
      where: { 'layout.value': { less_than: 5 } },
      expected: ['beta'],
    },
    {
      title: 'blocks: blockType',
      where: { 'layout.blockType': { equals: 'quote' } },
      expected: ['alpha'],
    },
    {
      title: 'json: a list inside the document',
      where: { 'meta.flags': { equals: 'c' } },
      expected: ['beta'],
    },
    {
      title: 'json: a nested key',
      where: { 'meta.nested.level': { equals: 3 } },
      expected: ['alpha'],
    },
  ]

  it.each(cases)('$title', async ({ expected, where }) => {
    expect(await titles(where)).toEqual(expected)
  })
})

describe('paths through a relationship', () => {
  const cases: { expected: string[]; title: string; where: Where }[] = [
    {
      title: 'a field of the related document',
      where: { 'author.name': { equals: 'Ada' } },
      expected: ['alpha'],
    },
    {
      title: 'two hops',
      where: { 'author.team.name': { equals: 'Docs' } },
      expected: ['beta'],
    },
    {
      title: 'any operator the related field supports',
      where: { 'author.name': { like: 'b' } },
      expected: ['beta'],
    },
    {
      title: 'no related document matches',
      where: { 'author.name': { equals: 'Nobody' } },
      expected: [],
    },
    {
      title: 'through a hasMany relationship',
      where: { 'reviewers.name': { equals: 'Cy' } },
      expected: ['alpha'],
    },
    {
      title: 'alongside a clause on the relationship itself',
      where: { author: { exists: true }, 'author.name': { not_equals: 'Ada' } },
      expected: ['beta', 'gamma'],
    },
    {
      title: 'inside an or',
      where: { or: [{ 'author.name': { equals: 'Ada' } }, { title: { equals: 'gamma' } }] },
      expected: ['alpha', 'gamma'],
    },
  ]

  it.each(cases)('$title', async ({ expected, where }) => {
    expect(await titles(where)).toEqual(expected)
  })

  it('`.id` is the stored relationship value', async () => {
    expect(await titles({ 'author.id': { equals: ids['bob'] } })).toEqual(['beta'])
  })
})

describe('text operators', () => {
  it('contains is a case-insensitive substring', async () => {
    expect(await titles({ title: { contains: 'ALP' } })).toEqual(['alpha'])
  })

  it('not_like is the complement of like', async () => {
    expect(await titles({ title: { not_like: 'a' } })).toEqual([])
    expect(await titles({ title: { not_like: 'ph' } })).toEqual(['beta', 'gamma'])
  })
})

describe('geo operators on a point field', () => {
  it('near: within a maximum distance in metres', async () => {
    // 50 km around Berlin takes in Potsdam but not Munich.
    expect(await titles({ location: { near: [...BERLIN, 50_000] } })).toEqual(['alpha', 'beta'])
    expect(await titles({ location: { near: `${BERLIN.join(',')},1000` } })).toEqual(['alpha'])
  })

  it('near: a minimum distance excludes the centre', async () => {
    expect(await titles({ location: { near: [...BERLIN, 50_000, 1000] } })).toEqual(['beta'])
  })

  it('within: inside a polygon', async () => {
    // A box around Berlin and Potsdam.
    const polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [12.5, 52],
          [14, 52],
          [14, 53],
          [12.5, 53],
          [12.5, 52],
        ],
      ],
    }
    expect(await titles({ location: { within: polygon } })).toEqual(['alpha', 'beta'])
  })

  it('intersects: a point matches itself, a polygon matches what it covers', async () => {
    expect(
      await titles({ location: { intersects: { type: 'Point', coordinates: MUNICH } } }),
    ).toEqual(['gamma'])
    const aroundMunich = {
      type: 'Polygon',
      coordinates: [
        [
          [11, 48],
          [12, 48],
          [12, 48.5],
          [11, 48.5],
          [11, 48],
        ],
      ],
    }
    expect(await titles({ location: { intersects: aroundMunich } })).toEqual(['gamma'])
  })
})
