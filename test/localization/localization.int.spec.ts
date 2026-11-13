import type { Where } from 'payload'

import { GetCommand } from '@aws-sdk/lib-dynamodb'
import { handleEndpoints } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { DynamoAdapter } from '../../src/index.js'

import { initPayloadTest, type TestHandle } from '../__helpers/initPayload.js'
import { config } from './config.js'

/**
 * A localized field is stored as one map per field (`{ en: …, es: … }`), so
 * a filter or sort on `title` has to address `title.<locale>` for the locale
 * the request is in.
 */

let handle: TestHandle
const ids: Record<string, number | string> = {}

beforeAll(async () => {
  handle = await initPayloadTest('localization', config)
  const { payload } = handle

  // English and Spanish titles sort in opposite orders on purpose.
  const seed = [
    { key: 'first', en: 'Apple', es: 'Zanahoria', blurbEn: 'red', blurbEs: 'rojo', views: 1 },
    { key: 'second', en: 'Banana', es: 'Yuca', blurbEn: 'yellow', blurbEs: 'amarillo', views: 2 },
  ]
  for (const row of seed) {
    const doc = await payload.create({
      collection: 'articles',
      data: { title: row.en, meta: { blurb: row.blurbEn }, views: row.views },
      locale: 'en',
    })
    await payload.update({
      collection: 'articles',
      id: doc.id,
      data: { title: row.es, meta: { blurb: row.blurbEs } },
      locale: 'es',
    })
    ids[row.key] = doc.id
  }
})

afterAll(async () => {
  // `handle` is undefined when beforeAll threw before assignment. Guard so
  // afterAll's TypeError doesn't mask the real error from beforeAll.
  await (handle as TestHandle | undefined)?.cleanup()
})

async function views(args: { locale?: string; sort?: string; where?: Where }): Promise<number[]> {
  const result = await handle.payload.find({
    collection: 'articles',
    limit: 0,
    pagination: false,
    ...(args as object),
  })
  return result.docs.map((doc) => Number(doc.views))
}

describe('stored shape', () => {
  it('keeps one map per localized field', async () => {
    const adapter = handle.payload.db as DynamoAdapter
    const result = await adapter.docClient!.send(
      new GetCommand({
        TableName: handle.tableName,
        Key: { pk: 'articles', sk: String(ids['first']) },
      }),
    )
    expect(result.Item?.title).toEqual({ en: 'Apple', es: 'Zanahoria' })
    expect(result.Item?.meta).toEqual({ blurb: { en: 'red', es: 'rojo' } })
  })
})

describe('where on a localized field', () => {
  it('matches against the requested locale only', async () => {
    expect(await views({ locale: 'en', where: { title: { equals: 'Apple' } } })).toEqual([1])
    expect(await views({ locale: 'es', where: { title: { equals: 'Apple' } } })).toEqual([])
    expect(await views({ locale: 'es', where: { title: { equals: 'Yuca' } } })).toEqual([2])
  })

  it('uses the default locale when none is requested', async () => {
    expect(await views({ where: { title: { equals: 'Banana' } } })).toEqual([2])
  })

  it('respects a locale written into the path', async () => {
    expect(await views({ locale: 'en', where: { 'title.es': { equals: 'Yuca' } } })).toEqual([2])
  })

  it('reaches a localized field nested in a group', async () => {
    expect(await views({ locale: 'es', where: { 'meta.blurb': { equals: 'rojo' } } })).toEqual([1])
    expect(await views({ locale: 'en', where: { 'meta.blurb': { equals: 'rojo' } } })).toEqual([])
  })

  it('works with JS-evaluated operators too', async () => {
    expect(await views({ locale: 'es', where: { title: { like: 'zana' } } })).toEqual([1])
    expect(await views({ locale: 'en', where: { title: { like: 'zana' } } })).toEqual([])
  })

  it('works over REST', async () => {
    const response = await handleEndpoints({
      config: handle.payload.config,
      request: new Request(
        'http://localhost/api/articles?locale=es&limit=0&where[title][equals]=Zanahoria',
      ),
    })
    const body = (await response.json()) as { docs: { views: number }[] }
    expect(body.docs.map((doc) => doc.views)).toEqual([1])
  })
})

describe('sort on a localized field', () => {
  it('orders by the requested locale', async () => {
    expect(await views({ locale: 'en', sort: 'title' })).toEqual([1, 2])
    expect(await views({ locale: 'es', sort: 'title' })).toEqual([2, 1])
    expect(await views({ locale: 'es', sort: '-title' })).toEqual([1, 2])
  })
})
