import type { Config } from 'payload'

/**
 * Open read access so the REST cases can run anonymously — the suite is
 * about how operands are parsed, not about auth.
 */
const access = { read: () => true }

export const config: Partial<Config> = {
  collections: [
    {
      // Numeric custom ids: relationship operands pointing here must be cast
      // to numbers, as must this collection's own `id` operands.
      slug: 'authors',
      access,
      fields: [
        { name: 'id', type: 'number', required: true },
        { name: 'name', type: 'text' },
      ],
    },
    {
      slug: 'things',
      access,
      fields: [
        { name: 'name', type: 'text', required: true },
        { name: 'note', type: 'text' },
        { name: 'count', type: 'number' },
        { name: 'active', type: 'checkbox' },
        { name: 'dueAt', type: 'date' },
        { name: 'author', type: 'relationship', relationTo: 'authors' },
        { name: 'meta', type: 'group', fields: [{ name: 'score', type: 'number' }] },
      ],
    },
    {
      slug: 'notes',
      access,
      fields: [
        { name: 'title', type: 'text' },
        { name: 'rank', type: 'number' },
      ],
      versions: true,
    },
    {
      slug: 'drafts',
      access,
      fields: [
        { name: 'title', type: 'text' },
        { name: 'rank', type: 'number' },
      ],
      versions: { drafts: true },
    },
  ],
}
