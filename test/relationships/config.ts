import type { Config } from 'payload'

export const config: Partial<Config> = {
  collections: [
    {
      slug: 'authors',
      fields: [{ name: 'name', type: 'text' }],
    },
    {
      slug: 'tags',
      fields: [{ name: 'label', type: 'text' }],
    },
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'author', type: 'relationship', relationTo: 'authors' },
        { name: 'tags', type: 'relationship', relationTo: 'tags', hasMany: true },
        {
          name: 'related',
          type: 'relationship',
          relationTo: ['authors', 'tags'],
        },
      ],
    },
  ],
}
