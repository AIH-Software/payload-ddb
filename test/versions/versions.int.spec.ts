import { APIError } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { DynamoAdapter } from '../../src/index.js'

import { initPayloadTest, type TestHandle } from '../__helpers/initPayload.js'
import { config } from './config.js'

let handle: TestHandle

beforeAll(async () => {
  handle = await initPayloadTest('versions', config)
})

afterAll(async () => {
  // `handle` is undefined when beforeAll threw before assignment. Guard so
  // afterAll's TypeError doesn't mask the real error from beforeAll.
  await (handle as TestHandle | undefined)?.cleanup()
})

beforeEach(async () => {
  for (const slug of ['drafts-on', 'versions-no-drafts'] as const) {
    const docs = await handle.payload.find({ collection: slug, limit: 0, pagination: false })
    await Promise.all(
      docs.docs.map((d) => handle.payload.delete({ collection: slug, id: d.id })),
    )
  }
})

describe('versions on a non-drafts collection', () => {
  it('creates a version row alongside the doc on every write', async () => {
    const created = await handle.payload.create({
      collection: 'versions-no-drafts',
      data: { title: 'v1' },
    })

    const versions = await handle.payload.findVersions({
      collection: 'versions-no-drafts',
      where: { parent: { equals: created.id } },
    })
    expect(versions.totalDocs).toBe(1)
    expect(versions.docs[0]?.version?.title).toBe('v1')
    expect(versions.docs[0]?.latest).toBe(true)
  })

  it('flips previous latest on update so exactly one row stays latest', async () => {
    const created = await handle.payload.create({
      collection: 'versions-no-drafts',
      data: { title: 'v1' },
    })
    await handle.payload.update({
      collection: 'versions-no-drafts',
      id: created.id,
      data: { title: 'v2' },
    })

    const versions = await handle.payload.findVersions({
      collection: 'versions-no-drafts',
      where: { parent: { equals: created.id } },
    })
    expect(versions.totalDocs).toBe(2)
    const latestRows = versions.docs.filter((v) => v.latest === true)
    expect(latestRows).toHaveLength(1)
    expect(latestRows[0]?.version?.title).toBe('v2')
  })
})

describe('drafts collection — find / queryDrafts / supplements', () => {
  it('a published doc shows up in find()', async () => {
    const created = await handle.payload.create({
      collection: 'drafts-on',
      data: { title: 'published', _status: 'published', priority: 1 },
    })

    const list = await handle.payload.find({
      collection: 'drafts-on',
      where: { id: { equals: created.id } },
    })
    expect(list.totalDocs).toBe(1)
  })

  it('a draft-only doc (never published) is surfaced by find() via the supplement path', async () => {
    // Creating with `_status: 'draft'` writes a version row but the main
    // partition won't have the doc — payload-ddb's `find` unions in
    // latest=true version rows for collections with drafts enabled.
    const created = await handle.payload.create({
      collection: 'drafts-on',
      data: { title: 'draft only', _status: 'draft', priority: 7 },
      draft: true,
    })

    const list = await handle.payload.find({
      collection: 'drafts-on',
      where: { id: { equals: created.id } },
    })
    expect(list.totalDocs).toBe(1)
    expect(list.docs[0]?.title).toBe('draft only')
  })

  it('a drafts query (draft: true) can filter by id', async () => {
    // Core rewrites a doc-level `id` filter to the version row's `parent`
    // before calling queryDrafts; the adapter has to map it back, because the
    // docs it projects from version rows carry that value as `id`.
    const wanted = await handle.payload.create({
      collection: 'drafts-on',
      data: { title: 'wanted', _status: 'published', priority: 1 },
    })
    const other = await handle.payload.create({
      collection: 'drafts-on',
      data: { title: 'other', _status: 'published', priority: 2 },
    })

    const byEquals = await handle.payload.find({
      collection: 'drafts-on',
      draft: true,
      where: { id: { equals: wanted.id } },
    })
    expect(byEquals.docs.map((doc) => doc.title)).toEqual(['wanted'])

    const byIn = await handle.payload.find({
      collection: 'drafts-on',
      draft: true,
      where: { id: { in: [wanted.id, other.id] } },
    })
    expect(byIn.docs.map((doc) => doc.title).sort()).toEqual(['other', 'wanted'])

    const byNotIn = await handle.payload.find({
      collection: 'drafts-on',
      draft: true,
      where: { id: { not_in: [wanted.id] } },
    })
    expect(byNotIn.docs.map((doc) => doc.title)).not.toContain('wanted')
    expect(byNotIn.docs.map((doc) => doc.title)).toContain('other')
  })

  it('latest version contains the most recent draft content', async () => {
    // Tests the same invariant as queryDrafts — that the latest=true row
    // tracks the most recent write — but goes through findVersions to avoid
    // depending on payload core's query-key rewriting for queryDrafts.
    const a = await handle.payload.create({
      collection: 'drafts-on',
      data: { title: 'a-v1', _status: 'published', priority: 1 },
    })
    await handle.payload.update({
      collection: 'drafts-on',
      id: a.id,
      data: { title: 'a-v2' },
      draft: true,
    })

    const latest = await handle.payload.findVersions({
      collection: 'drafts-on',
      where: {
        and: [{ parent: { equals: a.id } }, { latest: { equals: true } }],
      },
    })
    expect(latest.totalDocs).toBe(1)
    expect(latest.docs[0]?.version?.title).toBe('a-v2')
  })
})

describe('version rows — limits', () => {
  it('rejects a version snapshot over the 400 KB item limit with a clear error', async () => {
    // Goes through the adapter directly: this is the `TransactWriteItems`
    // path, where DynamoDB reports the breach differently than a plain put.
    const adapter = handle.payload.db as DynamoAdapter
    const now = new Date().toISOString()
    const attempt = adapter.createVersion({
      autosave: false,
      collectionSlug: 'versions-no-drafts',
      createdAt: now,
      parent: 'oversized-parent',
      updatedAt: now,
      versionData: { title: 'x'.repeat(450_000) } as never,
    })

    await expect(attempt).rejects.toBeInstanceOf(APIError)
    await expect(attempt).rejects.toMatchObject({ status: 413 })
  })
})
