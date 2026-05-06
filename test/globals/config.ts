import type { Config } from 'payload'

export const config: Partial<Config> = {
  globals: [
    {
      slug: 'settings',
      fields: [
        { name: 'siteName', type: 'text' },
        { name: 'tagline', type: 'text' },
      ],
    },
    {
      slug: 'header',
      versions: true,
      fields: [{ name: 'logoText', type: 'text' }],
    },
  ],
}
