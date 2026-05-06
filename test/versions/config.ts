import type { Config } from 'payload'

export const config: Partial<Config> = {
  collections: [
    {
      slug: 'drafts-on',
      versions: { drafts: true },
      fields: [
        { name: 'title', type: 'text' },
        { name: 'priority', type: 'number' },
      ],
    },
    {
      slug: 'versions-no-drafts',
      versions: true,
      fields: [{ name: 'title', type: 'text' }],
    },
  ],
}
