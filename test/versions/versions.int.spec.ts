import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

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
