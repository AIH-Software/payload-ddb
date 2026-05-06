import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { initPayloadTest, type TestHandle } from '../__helpers/initPayload.js'
import { config } from './config.js'

let handle: TestHandle

beforeAll(async () => {
  handle = await initPayloadTest('globals', config)
})

afterAll(async () => {
  // `handle` is undefined when beforeAll threw before assignment. Guard so
  // afterAll's TypeError doesn't mask the real error from beforeAll.
  await (handle as TestHandle | undefined)?.cleanup()
})

describe('global — single-row read/write', () => {
  it('updates and reads back a non-versioned global', async () => {
    await handle.payload.updateGlobal({
      slug: 'settings',
      data: { siteName: 'ACME', tagline: 'We do things' },
    })

    const result = await handle.payload.findGlobal({ slug: 'settings' })
    expect(result.siteName).toBe('ACME')
    expect(result.tagline).toBe('We do things')
  })

  it('partial update preserves untouched fields (read-merge-write)', async () => {
    await handle.payload.updateGlobal({
      slug: 'settings',
      data: { siteName: 'ACME', tagline: 'Original' },
    })
    await handle.payload.updateGlobal({
      slug: 'settings',
      data: { tagline: 'Updated' },
    })

    const result = await handle.payload.findGlobal({ slug: 'settings' })
    expect(result.siteName).toBe('ACME')
    expect(result.tagline).toBe('Updated')
  })
})

describe('global versions — latest invariant', () => {
  it('writing a versioned global creates and rotates latest version rows', async () => {
    await handle.payload.updateGlobal({
      slug: 'header',
      data: { logoText: 'v1' },
    })
    await handle.payload.updateGlobal({
      slug: 'header',
      data: { logoText: 'v2' },
    })
    await handle.payload.updateGlobal({
      slug: 'header',
      data: { logoText: 'v3' },
    })

    const versions = await handle.payload.findGlobalVersions({ slug: 'header' })
    expect(versions.totalDocs).toBe(3)
    const latestRows = versions.docs.filter((v) => v.latest === true)
    expect(latestRows).toHaveLength(1)
    expect(latestRows[0]?.version?.logoText).toBe('v3')
  })
})
