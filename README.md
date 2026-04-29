# payload-ddb

An unofficial database adapter for [PayloadCMS](https://payloadcms.com) that
stores data in [Amazon DynamoDB](https://aws.amazon.com/dynamodb/).

> **Status:** all `BaseDatabaseAdapter` methods are implemented end-to-end. The
> common access patterns (CRUD, drafts, versions, globals, locales-as-fields)
> work today. The current strategy is "correct first, optimize later" — full
> table `Scan` with in-memory filtering, no GSIs, no `FilterExpression`
> translation. Suitable for development and small-to-medium workloads; large
> tables will want the optimization milestones tracked in the issues.

## Installation

```bash
pnpm add @aih-pkg/payload-ddb
# or
npm install @aih-pkg/payload-ddb
```

## Quick start (DynamoDB Local)

```ts
import { buildConfig } from 'payload'
import { dynamoAdapter } from '@aih-pkg/payload-ddb'

export default buildConfig({
  db: dynamoAdapter({
    ensureTables: true, // auto-create tables on startup; turn off in prod
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

Tables should be provisioned out-of-band (CDK, Terraform, CloudFormation) so
the adapter doesn't need IAM permissions to create or describe tables.

```ts
db: dynamoAdapter({
  // ensureTables defaults to false — leave it off
  clientConfig: {
    region: 'us-east-1',
    // credentials resolved from the default chain (IAM role, env, etc.)
  },
  tablePrefix: 'prod_',
})
```

For each Payload collection and global, provision a table with:
- Partition key: `id` (String)
- Billing: on-demand (`PAY_PER_REQUEST`) or provisioned, your call

If a collection/global has `versions: true`, also provision its `_versions`
sibling table with the same schema. Default naming is
`${tablePrefix}${slug}` and `${tablePrefix}${slug}_versions`.

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `clientConfig` | `DynamoDBClientConfig` | `{}` | Passed straight to `new DynamoDBClient(...)`. Region, endpoint, credentials, retry strategy, etc. |
| `client` | `DynamoDBClient` | — | Pre-built client. If supplied, `clientConfig` is ignored and the adapter does **not** call `.destroy()` on shutdown. |
| `translateConfig` | `TranslateConfig` | `removeUndefinedValues: true`, `convertClassInstanceToMap: true` | Marshalling options forwarded to `DynamoDBDocumentClient.from`. |
| `tablePrefix` | `string` | `''` | Prepended to every table name. Useful for multi-env. |
| `tableNames` | `Record<string, string>` | `{}` | Per-slug table-name overrides (`{ users: 'auth_users' }`). Falls back to `${tablePrefix}${slug}`. |
| `ensureTables` | `boolean` | `false` | When true, auto-creates any missing tables at init. Dev-loop convenience; turn off in production. |
| `migrationDir` | `string` | `'migrations'` | Path to read/write migration files. |

## Data layout

- **One DynamoDB table per Payload collection or global**, named by
  `tablePrefix + slug` (or whatever you set in `tableNames`).
- **Versions live in a sibling `_versions` table** for each collection/global
  that opts into versioning.
- **Partition key is always `id` (String)**. Custom Number IDs require
  pre-provisioning the table yourself with `AttributeType=N`.
- **The adapter doesn't use composite keys, GSIs, or LSIs** in v1. All
  predicates are evaluated in-memory after a `Scan`.

## What's implemented

All `BaseDatabaseAdapter` methods: `create`, `find`, `findOne`, `findDistinct`,
`count`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `upsert`,
`createGlobal`/`findGlobal`/`updateGlobal`, the five collection version methods,
the four global version methods, and `queryDrafts`.

## Known limits / future work

- **No GSI / Query routing.** Every non-id read is a `Scan` (with
  `FilterExpression` pushdown — DynamoDB still reads every row internally,
  but only matching rows come back over the wire). Adding GSIs that mirror
  Payload's common access patterns (e.g. `email` for auth, `slug` for
  public-facing collections) is the highest-impact remaining optimization
  milestone and is planned for v2.
- **Limited `where` operator coverage.** `equals`, `not_equals`, `exists`,
  `in`, `not_in`, `and`, `or`. Anything else throws — by design, so coverage
  gaps surface loudly. Range and `like`/`contains` operators land alongside
  `FilterExpression` translation.
- **Transactions are no-op.** `beginTransaction` returns `null`; commit/rollback
  do nothing. `TransactWriteItems` wiring is its own milestone.
- **`createVersion`/`createGlobalVersion` aren't atomic.** Three round-trips
  per call (find prev latest → flip its flag → put new). A crash mid-sequence
  can leave two `latest=true` rows. `TransactWriteItems` will close the gap.
- **No drafts-only document support.** A collection with `versions.drafts: true`
  but no published row yet is not yet handled.
- **Number-typed IDs require manual table provisioning.** `ensureTables` always
  creates a String partition key.

## License

MIT
