import type { Config } from 'payload'

export const config: Partial<Config> = {
  collections: [
    {
      slug: 'pages',
      fields: [
        { name: 'slug', type: 'text', required: true },
        { name: 'title', type: 'text' },
        { name: 'views', type: 'number' },
      ],
    },
  ],
}
