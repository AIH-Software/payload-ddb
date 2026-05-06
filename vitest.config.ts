import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.int.spec.ts'],
    globalSetup: ['test/__helpers/globalSetup.ts'],
    // Each spec file boots its own Payload + provisions its own DynamoDB
    // table, so per-file isolation is the unit. Vitest's default forks pool
    // matches that — one process per file, no cross-file leakage.
    pool: 'forks',
    // Boot + table provisioning + first inserts can comfortably exceed the
    // 5s default on a cold container. 60s is generous but matches CI reality.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ['default'],
    // Tests share a single DynamoDB Local container. Within a single file
    // we want sequential execution; across files vitest already parallelizes
    // by spawning workers — each uses a distinct table name (see
    // __helpers/randomTableName.ts) so they don't collide on the shared db.
    sequence: {
      concurrent: false,
    },
  },
})
