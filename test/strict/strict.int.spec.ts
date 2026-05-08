import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { DynamoAdapter } from '../../src/index.js'

import { scrubUnknownFields } from '../../src/index.js'
import { initPayloadTest, type TestHandle } from '../__helpers/initPayload.js'
import { config } from './config.js'

let handle: TestHandle
let adapter: DynamoAdapter

beforeAll(async () => {
  handle = await initPayloadTest('strict', config)
  adapter = handle.payload.db as DynamoAdapter
})

afterAll(async () => {
  await (handle as TestHandle | undefined)?.cleanup()
})

beforeEach(async () => {
  // Each test starts from empty partitions for the entities we touch.
  for (const slug of ['docs', 'members', 'articles']) {
    const all = await handle.payload.find({ collection: slug as 'docs', limit: 0, pagination: false })
    await Promise.all(
      all.docs.map((doc) => handle.payload.delete({ collection: slug as 'docs', id: doc.id })),
    )
  }
})

describe('Strict projection — collection writes drop unknown fields', () => {
  it('create: top-level unknown fields are not persisted', async () => {
    const created = await handle.payload.create({
      collection: 'docs',
      data: { title: 'hello', 'confirm-password': 'leak' } as never,
    })

    const persisted = await readRaw('docs', String(created.id))
    expect(persisted['title']).toBe('hello')
    expect(persisted['confirm-password']).toBeUndefined()
    expect(persisted['createdAt']).toBeTruthy()
    expect(persisted['updatedAt']).toBeTruthy()
  })

  it('create: nested unknown sub-keys in groups/arrays/blocks are dropped', async () => {
    const created = await handle.payload.create({
      collection: 'docs',
      data: {
        title: 'nested',
        meta: { author: 'dby', injected: 'leak' },
        tags: [
          { label: 'a', extra: 'leak-a' },
          { label: 'b', extra: 'leak-b' },
        ],
        sections: [
          { blockType: 'text', body: 'lorem', injected: 'leak-text' },
          { blockType: 'image', src: '/x.png', injected: 'leak-image' },
        ],
      } as never,
    })

    const row = await readRaw('docs', String(created.id))
    expect((row['meta'] as Record<string, unknown>)['author']).toBe('dby')
    expect((row['meta'] as Record<string, unknown>)['injected']).toBeUndefined()

    const tags = row['tags'] as Array<Record<string, unknown>>
    expect(tags[0]?.['label']).toBe('a')
    expect(tags[0]?.['extra']).toBeUndefined()
    expect(tags[1]?.['extra']).toBeUndefined()

    const sections = row['sections'] as Array<Record<string, unknown>>
    expect(sections[0]?.['body']).toBe('lorem')
    expect(sections[0]?.['injected']).toBeUndefined()
    expect(sections[1]?.['src']).toBe('/x.png')
    expect(sections[1]?.['injected']).toBeUndefined()
  })

  it('update: incoming patch AND pre-existing leaked keys are both stripped', async () => {
    // Seed a row with a leaked key by writing through the docClient directly
    // (which bypasses the adapter's projection) to simulate a doc that
    // already existed before the fix landed.
    const id = randomUUID()
    const now = new Date().toISOString()
    await adapter.docClient!.send(
      new PutCommand({
        TableName: handle.tableName,
        Item: {
          pk: 'docs',
          sk: id,
          id,
          title: 'old',
          'confirm-password': 'pre-existing-leak',
          createdAt: now,
          updatedAt: now,
        },
      }),
    )

    await handle.payload.update({
      collection: 'docs',
      id,
      data: { title: 'new', 'still-leaking': 'no' } as never,
    })

    const row = await readRaw('docs', id)
    expect(row['title']).toBe('new')
    // The pre-existing leak gets cleaned up incrementally on every write —
    // this is the "doc cleanup happens organically as docs are touched"
    // contract called out in the changelog entry.
    expect(row['confirm-password']).toBeUndefined()
    expect(row['still-leaking']).toBeUndefined()
  })

  it('updateMany: each affected row is projected', async () => {
    await handle.payload.create({ collection: 'docs', data: { title: 'a' } })
    await handle.payload.create({ collection: 'docs', data: { title: 'b' } })

    await handle.payload.update({
      collection: 'docs',
      where: {},
      data: { title: 'updated', injected: 'leak' } as never,
    })

    const all = await handle.payload.find({ collection: 'docs', limit: 0, pagination: false })
    for (const doc of all.docs) {
      const row = await readRaw('docs', String(doc.id))
      expect(row['injected']).toBeUndefined()
      expect(row['title']).toBe('updated')
    }
  })
})

describe('Strict projection — auth collection (the original bug)', () => {
  it('confirm-password and plaintext password never make it to disk', async () => {
    const created = await handle.payload.create({
      collection: 'members',
      data: {
        displayName: 'New Member',
        email: 'member@example.com',
        password: 'h2Tf5ue#b?+45dD',
        // The exact field that triggered the security report:
        'confirm-password': 'h2Tf5ue#b?+45dD',
      } as never,
    })

    const row = await readRaw('members', String(created.id))
    expect(row['confirm-password']).toBeUndefined()
    expect(row['password']).toBeUndefined()
    // hash + salt are auth-managed reserved fields and should be present.
    expect(row['hash']).toBeTruthy()
    expect(row['salt']).toBeTruthy()
    expect(row['email']).toBe('member@example.com')
  })
})

describe('Strict projection — global writes', () => {
  it('createGlobal/updateGlobal drop unknown keys', async () => {
    await handle.payload.updateGlobal({
      slug: 'site',
      data: { siteName: 'AIH', injected: 'leak' } as never,
    })

    const row = await readRaw('site', 'site')
    expect(row['siteName']).toBe('AIH')
    expect(row['injected']).toBeUndefined()
  })
})

describe('Strict projection — version writes', () => {
  it('createVersion sanitizes the inner snapshot', async () => {
    const created = await handle.payload.create({
      collection: 'articles',
      data: { title: 'first' } as never,
    })

    // Touch the doc so a new version is written.
    await handle.payload.update({
      collection: 'articles',
      id: created.id,
      data: { title: 'second', injected: 'leak' } as never,
    })

    // Inspect every version row for this article.
    const versions = await adapter.docClient!.send(
      new QueryCommand({
        TableName: handle.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': 'articles_versions' },
      }),
    )

    expect(versions.Items?.length ?? 0).toBeGreaterThan(0)
    for (const item of versions.Items ?? []) {
      // Top-level metadata: parent, version, latest, etc. — `injected`
      // shouldn't be here.
      expect(item['injected']).toBeUndefined()
      // The inner snapshot also gets projected.
      const snapshot = item['version'] as Record<string, unknown>
      expect(snapshot['injected']).toBeUndefined()
    }
  })
})

describe('scrubUnknownFields — one-shot cleanup', () => {
  it('removes leaked keys from rows written before the fix landed', async () => {
    // Simulate two pre-existing leaked rows by writing through the docClient
    // directly, bypassing the adapter's projection.
    const leakedIds = [randomUUID(), randomUUID()]
    const now = new Date().toISOString()
    for (const id of leakedIds) {
      await adapter.docClient!.send(
        new PutCommand({
          TableName: handle.tableName,
          Item: {
            pk: 'docs',
            sk: id,
            id,
            title: 'leaked',
            'confirm-password': 'pre-existing',
            meta: { author: 'dby', injected: 'leak' },
            createdAt: now,
            updatedAt: now,
          },
        }),
      )
    }
    // And one already-clean row that scrub should NOT modify.
    const clean = await handle.payload.create({ collection: 'docs', data: { title: 'clean' } })

    const report = await scrubUnknownFields(handle.payload)
    expect(report.collections['docs']?.scanned).toBe(3)
    expect(report.collections['docs']?.modified).toBe(2)

    for (const id of leakedIds) {
      const row = await readRaw('docs', id)
      expect(row['confirm-password']).toBeUndefined()
      expect((row['meta'] as Record<string, unknown>)['injected']).toBeUndefined()
      expect(row['title']).toBe('leaked')
    }

    // The clean row's contents are untouched.
    const cleanRow = await readRaw('docs', String(clean.id))
    expect(cleanRow['title']).toBe('clean')
  })
})

/** Read a row directly via the adapter's docClient, bypassing all projection. */
async function readRaw(pk: string, sk: string): Promise<Record<string, unknown>> {
  const result = await adapter.docClient!.send(
    new GetCommand({ TableName: handle.tableName, Key: { pk, sk } }),
  )
  if (!result.Item) throw new Error(`No row at pk=${pk} sk=${sk}`)
  return result.Item
}
