import type { Config } from 'payload'

export const config: Partial<Config> = {
  collections: [
    {
      slug: 'categories',
      fields: [
        { name: 'name', type: 'text' },
        // Posts whose single `category` points here.
        { name: 'posts', type: 'join', collection: 'posts', on: 'category' },
        // Posts that list this category among several.
        { name: 'tagged', type: 'join', collection: 'posts', on: 'categories' },
        // Anything, from either collection, filed under this category.
        { name: 'everything', type: 'join', collection: ['posts', 'pages'], on: 'category' },
      ],
    },
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'rank', type: 'number' },
        { name: 'category', type: 'relationship', relationTo: 'categories' },
        { name: 'categories', type: 'relationship', hasMany: true, relationTo: 'categories' },
      ],
    },
    {
      slug: 'pages',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'category', type: 'relationship', relationTo: 'categories' },
      ],
    },
  ],
}
