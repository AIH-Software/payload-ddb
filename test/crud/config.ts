import type { Config } from 'payload'

export const config: Partial<Config> = {
  collections: [
    {
      slug: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'priority', type: 'number' },
        { name: 'publishedAt', type: 'date' },
        {
          name: 'meta',
          type: 'group',
          fields: [
            { name: 'author', type: 'text' },
            { name: 'wordCount', type: 'number' },
          ],
        },
        {
          name: 'tags',
          type: 'array',
          fields: [{ name: 'label', type: 'text' }],
        },
      ],
    },
  ],
}
