import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { initPayloadTest, type TestHandle } from '../__helpers/initPayload.js'
import { config } from './config.js'

let handle: TestHandle

beforeAll(async () => {
  handle = await initPayloadTest('query', config)

  // Seed once; tests below are read-only so they can share the data.
  const seed = [
    { name: 'apple', category: 'fruit', priority: 1, active: true, description: 'Red and round' },
    { name: 'banana', category: 'fruit', priority: 2, active: true, description: 'Long and YELLOW' },
    { name: 'carrot', category: 'veg', priority: 3, active: true, description: 'Orange root' },
    { name: 'donut', category: 'snack', priority: 4, active: false, description: 'Sweet ring' },
    { name: 'eggplant', category: 'veg', priority: 5, active: false },
    { name: 'fig', category: 'fruit', priority: 6, active: true, description: 'Purple and sweet' },
  ]
  for (const data of seed) {
    await handle.payload.create({ collection: 'items', data })
  }
})

afterAll(async () => {
  await handle.cleanup()
})

describe('where operators (FilterExpression pushdown)', () => {
  it('equals', async () => {
    const result = await handle.payload.find({
      collection: 'items',
      where: { name: { equals: 'apple' } },
    })
    expect(result.totalDocs).toBe(1)
    expect(result.docs[0]?.name).toBe('apple')
  })

  it('not_equals', async () => {
    const result = await handle.payload.find({
      collection: 'items',
      where: { category: { not_equals: 'fruit' } },
    })
    expect(result.docs.map((d) => d.name).sort()).toEqual(['carrot', 'donut', 'eggplant'])
  })

  it('greater_than', async () => {
    const result = await handle.payload.find({
      collection: 'items',
      where: { priority: { greater_than: 3 } },
    })
    expect(result.docs.map((d) => d.priority).sort()).toEqual([4, 5, 6])
  })

  it('greater_than_equal', async () => {
    const result = await handle.payload.find({
      collection: 'items',
      where: { priority: { greater_than_equal: 5 } },
    })
    expect(result.docs.map((d) => d.priority).sort()).toEqual([5, 6])
  })

  it('less_than', async () => {
    const result = await handle.payload.find({
      collection: 'items',
      where: { priority: { less_than: 3 } },
    })
    expect(result.docs.map((d) => d.priority).sort()).toEqual([1, 2])
  })

  it('less_than_equal', async () => {
    const result = await handle.payload.find({
      collection: 'items',
      where: { priority: { less_than_equal: 2 } },
    })
    expect(result.docs.map((d) => d.priority).sort()).toEqual([1, 2])
  })

  it('in', async () => {
    const result = await handle.payload.find({
      collection: 'items',
      where: { name: { in: ['apple', 'fig'] } },
    })
    expect(result.docs.map((d) => d.name).sort()).toEqual(['apple', 'fig'])
  })

  it('not_in', async () => {
    const result = await handle.payload.find({
      collection: 'items',
      where: { name: { not_in: ['apple', 'fig', 'banana'] } },
    })
    expect(result.docs.map((d) => d.name).sort()).toEqual(['carrot', 'donut', 'eggplant'])
  })

  it('exists', async () => {
    const present = await handle.payload.find({
      collection: 'items',
      where: { description: { exists: true } },
    })
    expect(present.totalDocs).toBe(5)

    const missing = await handle.payload.find({
      collection: 'items',
      where: { description: { exists: false } },
    })
    expect(missing.totalDocs).toBe(1)
    expect(missing.docs[0]?.name).toBe('eggplant')
  })

  it('like is case-insensitive substring (JS-evaluated)', async () => {
    // The adapter classes `like` as JS-only because DynamoDB `contains()` is
    // case-sensitive. The test exercises both halves of the case-insensitive
    // contract.
    const lower = await handle.payload.find({
      collection: 'items',
      where: { description: { like: 'yellow' } },
    })
    expect(lower.totalDocs).toBe(1)
    expect(lower.docs[0]?.name).toBe('banana')

    const upper = await handle.payload.find({
      collection: 'items',
      where: { description: { like: 'SWEET' } },
    })
    expect(upper.docs.map((d) => d.name).sort()).toEqual(['donut', 'fig'])
  })
})

describe('and / or composition', () => {
  it('and combines two leaf clauses', async () => {
    const result = await handle.payload.find({
      collection: 'items',
      where: {
        and: [{ category: { equals: 'fruit' } }, { active: { equals: true } }],
      },
    })
    expect(result.docs.map((d) => d.name).sort()).toEqual(['apple', 'banana', 'fig'])
  })

  it('or combines two leaf clauses', async () => {
    const result = await handle.payload.find({
      collection: 'items',
      where: {
        or: [{ name: { equals: 'apple' } }, { name: { equals: 'fig' } }],
      },
    })
    expect(result.docs.map((d) => d.name).sort()).toEqual(['apple', 'fig'])
  })

  it('mixed JS-only operator (`like`) inside `and` still evaluates correctly', async () => {
    // The presence of `like` flips the path to in-memory filtering for the
    // whole expression. Make sure that path also honors the equals branch.
    const result = await handle.payload.find({
      collection: 'items',
      where: {
        and: [{ category: { equals: 'fruit' } }, { description: { like: 'sweet' } }],
      },
    })
    expect(result.docs.map((d) => d.name)).toEqual(['fig'])
  })
})

describe('findDistinct', () => {
  it('dedupes a primitive field', async () => {
    const result = await handle.payload.findDistinct({
      collection: 'items',
      field: 'category',
    })
    expect(
      result.values
        .map((v) => (v as Record<string, unknown>)['category'])
        .sort(),
    ).toEqual(['fruit', 'snack', 'veg'])
  })

  it('respects where when computing distinct values', async () => {
    const result = await handle.payload.findDistinct({
      collection: 'items',
      field: 'category',
      where: { active: { equals: true } },
    })
    expect(
      result.values
        .map((v) => (v as Record<string, unknown>)['category'])
        .sort(),
    ).toEqual(['fruit', 'veg'])
  })
})
