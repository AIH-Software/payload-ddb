import type { Config } from 'payload'

export const config: Partial<Config> = {
  collections: [
    {
      slug: 'articles',
      access: { read: () => true },
      fields: [
        { name: 'title', type: 'text', localized: true },
        { name: 'views', type: 'number' },
        {
          name: 'meta',
          type: 'group',
          fields: [{ name: 'blurb', type: 'text', localized: true }],
        },
      ],
    },
  ],
  localization: {
    defaultLocale: 'en',
    locales: ['en', 'es'],
  },
}
