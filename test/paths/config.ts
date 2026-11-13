import type { Config } from 'payload'

const access = { read: () => true }

export const config: Partial<Config> = {
  collections: [
    {
      slug: 'teams',
      access,
      fields: [{ name: 'name', type: 'text' }],
    },
    {
      slug: 'authors',
      access,
      fields: [
        { name: 'name', type: 'text' },
        { name: 'team', type: 'relationship', relationTo: 'teams' },
      ],
    },
    {
      slug: 'posts',
      access,
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'tags', type: 'text', hasMany: true },
        { name: 'scores', type: 'number', hasMany: true },
        { name: 'kinds', type: 'select', hasMany: true, options: ['news', 'guide', 'opinion'] },
        { name: 'author', type: 'relationship', relationTo: 'authors' },
        { name: 'reviewers', type: 'relationship', hasMany: true, relationTo: 'authors' },
        {
          name: 'items',
          type: 'array',
          fields: [
            { name: 'label', type: 'text' },
            { name: 'qty', type: 'number' },
          ],
        },
        {
          name: 'layout',
          type: 'blocks',
          blocks: [
            { slug: 'quote', fields: [{ name: 'text', type: 'text' }] },
            { slug: 'stat', fields: [{ name: 'value', type: 'number' }] },
          ],
        },
        { name: 'meta', type: 'json' },
        { name: 'location', type: 'point' },
      ],
    },
  ],
}
