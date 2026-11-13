import type { Config } from 'payload'

/**
 * A function, not a constant: `buildConfig` adds Payload's own collections to
 * the object it is given, and this suite builds its config more than once.
 */
export const makeConfig = (): Partial<Config> => ({
  collections: [
    {
      slug: 'authors',
      fields: [
        { name: 'name', type: 'text' },
        // Payload flags the field a join points at (`articles.author`) with
        // `index: true`, so this join is answered from index rows.
        { name: 'articles', type: 'join', collection: 'articles', on: 'author' },
      ],
    },
    {
      slug: 'articles',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'slug', type: 'text', unique: true },
        { name: 'sku', type: 'text', index: true },
        { name: 'rank', type: 'number', index: true },
        { name: 'tags', type: 'text', hasMany: true, index: true },
        { name: 'label', type: 'text', index: true, localized: true },
        { name: 'author', type: 'relationship', relationTo: 'authors' },
        { name: 'meta', type: 'group', fields: [{ name: 'code', type: 'text', index: true }] },
        // Flagged, but two values split a collection in half: not indexed.
        { name: 'featured', type: 'checkbox', index: true },
      ],
    },
    {
      // Stands in for a collection that held documents before indexes existed.
      slug: 'legacy',
      fields: [
        { name: 'code', type: 'text', index: true },
        { name: 'email', type: 'text', unique: true },
      ],
    },
  ],
  localization: { defaultLocale: 'en', locales: ['en', 'es'] },
})
