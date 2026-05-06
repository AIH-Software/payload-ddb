# payload-ddb integration tests

Vitest-based test harness modelled on Payload's own `test/` layout. Each spec
boots its own Payload instance against a uniquely-named table on a shared
**DynamoDB Local** container.

## Run

```bash
pnpm docker:start   # boots amazon/dynamodb-local on :8001
pnpm test           # runs every *.int.spec.ts once
pnpm test:watch     # vitest in watch mode
pnpm docker:stop    # tears the container down
```

`pnpm test` will fail fast with a friendly message if DynamoDB Local isn't
reachable on the configured host:port (defaults to `localhost:8001`; override
with `PAYLOAD_DDB_TEST_HOST` / `PAYLOAD_DDB_TEST_PORT`).

## Layout

```
test/
  __helpers/                   # shared bootstrap
    assertDbReachable.ts        # TCP probe — runs once via globalSetup
    buildConfigWithDefaults.ts  # wires the dynamo adapter into a payload config
    initPayload.ts              # boots payload, returns { payload, cleanup }
    randomTableName.ts          # unique per-suite table name for parallel runs
    deleteTable.ts              # afterAll cleanup
    globalSetup.ts              # vitest hook → assertDbReachable

  connect/                     # init lifecycle, ensureTable idempotency
  crud/                        # create / find / update / delete + pagination invariants
  query/                       # operator coverage + findDistinct
  versions/                    # versions, drafts, queryDrafts, drafts-only fallback
  globals/                     # globals + global versions latest invariant
  relationships/               # single, hasMany, polymorphic
  upsert/                      # adapter.upsert direct calls
```

Each suite is `<suite>/config.ts` (a `Partial<Config>`) plus
`<suite>/<suite>.int.spec.ts`. Per-suite isolation by table name keeps vitest
workers from colliding when run in parallel against the shared container.

## Conventions

- **One Payload instance per file.** `beforeAll` boots, `afterAll` destroys
  the instance and drops the table. Tests within a file share the instance
  and clean docs in `beforeEach` where they need an empty partition.
- **No richText / no admin / no SDK.** This harness exercises the database
  adapter contract; it deliberately doesn't drag in Next.js, the lexical
  editor, or the REST client. Admin-UI regressions need Payload's full
  Next-based harness.
- **DynamoDB Local with `-inMemory -sharedDb`.** Credentials and region are
  irrelevant — every connection sees the same in-memory store. Each test
  start is a clean slate via `randomTableName`.

## Pointing at real AWS DynamoDB

The adapter takes `clientConfig` straight through to `new DynamoDBClient(...)`.
To run against a real account, override the test endpoint in
`__helpers/buildConfigWithDefaults.ts` (or fork the helper) and supply real
credentials. Most specs don't depend on `-sharedDb`-only behavior, but watch
out for tests that assume sub-second writes — DynamoDB on-demand has higher
tail latency than local.
