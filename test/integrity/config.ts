import type { Config } from 'payload'

export const config: Partial<Config> = {
  collections: [
    {
      slug: 'accounts',
      fields: [
        { name: 'handle', type: 'text', unique: true },
        { name: 'bio', type: 'text' },
        {
          name: 'profile',
          type: 'group',
          fields: [{ name: 'slug', type: 'text', unique: true }],
        },
        // Eight independent counters for the concurrent-update test.
        ...['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(
          (name) => ({ name, type: 'number' }) as const,
        ),
      ],
    },
    {
      slug: 'pages',
      fields: [{ name: 'title', type: 'text', localized: true, unique: true }],
    },
    {
      slug: 'members',
      auth: true,
      fields: [],
    },
  ],
  // Any task definition is enough to make Payload add the `payload-jobs`
  // collection.
  jobs: {
    tasks: [{ slug: 'noop', handler: () => ({ output: {} }) }],
  },
  localization: {
    defaultLocale: 'en',
    locales: ['en', 'es'],
  },
}
