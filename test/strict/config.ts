import type { Config } from 'payload'

/**
 * Test config for the strict-projection (unknown-field stripping) suite.
 * Spans the full set of write surfaces:
 *
 *  - `docs`     — vanilla collection with nested `group`, `array`, `blocks`
 *                 to exercise recursive projection.
 *  - `members`  — auth collection. Used to assert the original credential
 *                 leak (`confirm-password`, `password`) gets dropped.
 *  - `articles` — drafts-enabled. Exercises createVersion / updateVersion
 *                 plus the `_status` reserved key.
 *  - `site`     — global. Exercises createGlobal / updateGlobal.
 *  - `header`   — versioned global. Exercises createGlobalVersion.
 */
export const config: Partial<Config> = {
  collections: [
    {
      slug: 'docs',
      fields: [
        { name: 'title', type: 'text' },
        {
          name: 'meta',
          type: 'group',
          fields: [{ name: 'author', type: 'text' }],
        },
        {
          name: 'tags',
          type: 'array',
          fields: [{ name: 'label', type: 'text' }],
        },
        {
          name: 'sections',
          type: 'blocks',
          blocks: [
            { slug: 'text', fields: [{ name: 'body', type: 'textarea' }] },
            { slug: 'image', fields: [{ name: 'src', type: 'text' }] },
          ],
        },
      ],
    },
    {
      slug: 'members',
      auth: true,
      fields: [{ name: 'displayName', type: 'text' }],
    },
    {
      slug: 'articles',
      versions: { drafts: true },
      fields: [{ name: 'title', type: 'text' }],
    },
  ],
  globals: [
    {
      slug: 'site',
      fields: [{ name: 'siteName', type: 'text' }],
    },
    {
      slug: 'header',
      versions: true,
      fields: [{ name: 'logoText', type: 'text' }],
    },
  ],
}
