# payload-ddb

An unofficial database adapter for [PayloadCMS](https://payloadcms.com) that
stores data in [Amazon DynamoDB](https://aws.amazon.com/dynamodb/).

> **Status:** all `BaseDatabaseAdapter` methods are implemented end-to-end. The
> common access patterns (CRUD, drafts, versions, globals, locales-as-fields)
> work today. The current strategy is "correct first, optimize later" — single
> shared table with a `Query`-per-collection access pattern, no GSIs, no range
> operators in `FilterExpression`. Suitable for development and
> small-to-medium workloads; large collections will want the optimization
> milestones tracked in the issues.

## Installation

```bash
pnpm add @aih-software/payload-ddb
# or
npm install @aih-software/payload-ddb
```

## Quick start (DynamoDB Local)

```ts
import { buildConfig } from 'payload'
import { dynamoAdapter } from '@aih-software/payload-ddb'

export default buildConfig({
  db: dynamoAdapter({
    ensureTables: true, // auto-create the table on startup; turn off in prod
    clientConfig: {
      endpoint: 'http://localhost:8000',
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'fake',
        secretAccessKey: 'fake',
      },
    },
  }),
  // ...rest of config
})
```

## Production setup

The single backing table should be provisioned out-of-band (CDK, Terraform,
CloudFormation) so the adapter doesn't need IAM permissions to create or
describe tables.

```ts
db: dynamoAdapter({
  // ensureTables defaults to false — leave it off
  tableName: 'payload',
  clientConfig: {
    region: 'us-east-1',
    // credentials resolved from the default chain (IAM role, env, etc.)
  },
})
```

Provision the table with a composite key:
- Partition key: `pk` (String)
- Sort key: `sk` (String)
- Billing: on-demand (`PAY_PER_REQUEST`) or provisioned, your call

Every collection, global, and versions stream lives under a different `pk`
value in the same physical table.

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `clientConfig` | `DynamoDBClientConfig` | `{}` | Passed straight to `new DynamoDBClient(...)`. Region, endpoint, credentials, retry strategy, etc. |
| `client` | `DynamoDBClient` | — | Pre-built client. If supplied, `clientConfig` is ignored and the adapter does **not** call `.destroy()` on shutdown. |
| `translateConfig` | `TranslateConfig` | `removeUndefinedValues: true`, `convertClassInstanceToMap: true` | Marshalling options forwarded to `DynamoDBDocumentClient.from`. |
| `tableName` | `string` | `'payload'` | The single DynamoDB table backing every collection, global, and versions stream. |
| `ensureTables` | `boolean` | `false` | When true, auto-creates the table at init if it doesn't exist. Dev-loop convenience; turn off in production. |

## Data layout

- **One DynamoDB table for everything.** Every row carries a synthetic
  `pk`/`sk` pair that the adapter strips on read so callers never see them.
- **Collection documents:** `pk = "<slug>"`, `sk = "<id>"`.
- **Globals:** `pk = "<slug>"`, `sk = "<slug>"` — single-row partition since
  globals are singletons.
- **Versions:** `pk = "<slug>_versions"`, `sk = "<versionId>"` for both
  collections and globals.
- **Sort key is always String.** Number-typed collection ids are coerced to
  strings for `sk` while the original numeric `id` attribute is preserved on
  the row.
- **No GSIs or LSIs in v2.** Per-collection reads are `Query`s scoped by `pk`;
  predicates beyond `pk` get pushed to `FilterExpression` (DynamoDB still
  reads every row in the partition before filtering).

## What's implemented

All `BaseDatabaseAdapter` methods: `create`, `find`, `findOne`, `findDistinct`,
`count`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `upsert`,
`createGlobal`/`findGlobal`/`updateGlobal`, the five collection version methods,
the four global version methods, and `queryDrafts`.

Supported `where` operators: `equals`, `not_equals`, `greater_than`,
`greater_than_equal`, `less_than`, `less_than_equal`, `in`, `not_in`, `exists`,
`like`, plus `and` / `or` composition. Anything else throws by design so
coverage gaps surface loudly. `like` is case-insensitive and evaluated in JS
(DynamoDB's `contains()` is case-sensitive, so the adapter doesn't push it
down).

## Known limits / future work

- **No GSI routing.** Every non-id read is a `Query` against the collection's
  partition (with `FilterExpression` pushdown — DynamoDB still reads every
  row in the partition internally, but only matching rows come back over the
  wire). Adding GSIs that mirror Payload's common access patterns
  (e.g. `email` for auth, `slug` for public-facing collections) is the
  highest-impact remaining optimization milestone.
- **Payload-level transactions are no-op.** `beginTransaction` returns `null`;
  commit/rollback do nothing. Per-method atomicity (e.g. `createVersion`'s
  flip+put) uses DynamoDB `TransactWriteItems` already; full Payload-context
  transaction buffering across multiple adapter calls is its own milestone.

## Development

The package ships with a vitest integration test harness that boots Payload
against DynamoDB Local. Each spec file uses a unique table name so vitest
workers can run in parallel against a single shared container.

```bash
pnpm install
pnpm docker:start   # boots amazon/dynamodb-local on :8001
pnpm test           # runs every test/**/*.int.spec.ts once
pnpm test:watch     # vitest in watch mode
pnpm typecheck:test # tsc -p test/tsconfig.json
pnpm docker:stop    # tears the container down
```

`pnpm test` fails fast with a friendly message if the container isn't
reachable. Override the host/port with `PAYLOAD_DDB_TEST_HOST` /
`PAYLOAD_DDB_TEST_PORT` if 8001 conflicts on your machine.

See [`test/README.md`](./test/README.md) for the harness layout and how to
add a new spec.

## License

MIT
