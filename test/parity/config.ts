import type { Config } from 'payload'

export const config: Partial<Config> = {
  collections: [
    {
      slug: 'things',
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'note', type: 'text' },
        { name: 'count', type: 'number' },
        { name: 'dueAt', type: 'date' },
        { name: 'meta', type: 'json' },
      ],
    },
  ],
}
