# payload-ddb

An unofficial database adapter for [PayloadCMS](https://payloadcms.com) that
stores data in [Amazon DynamoDB](https://aws.amazon.com/dynamodb/).

> **Status:** all `BaseDatabaseAdapter` methods are implemented end-to-end:
> CRUD, drafts, versions, globals, localization, every `where` operator, join
> fields and unique fields. The current strategy is "correct first, optimize
> later" — a single shared table where lookups by id, unique field or indexed
> field go straight to the matching rows, and every other filter reads the
> collection's partition. Suitable for development and small-to-medium
> workloads; large collections will want the optimizations listed under
> *Known limits*.

## Requirements

- **Payload 3.x.** The peer range is `payload >=3.0.0`; the test suite runs
  against 3.93.
- **Node.js as your Payload version requires.** Payload 3.92 and later need
  Node 22.23.4+ or 24.22.1+. This repo's CI runs on Node 24.

## Installation

The package is published under two names with the same contents:

```bash
# Public npm registry — minor and major releases
pnpm add @open-aih/payload-ddb

# GitHub Packages — every release, including patches
pnpm add @aih-software/payload-ddb
```

The examples below import from `@aih-software/payload-ddb`; use
`@open-aih/payload-ddb` instead if that is the one you installed.

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
| `migrationDir` | `string` | `'migrations'` | Directory Payload reads and writes migration files in. |
| `indexes` | `boolean` | `true` | Maintain index rows for `index: true` fields and answer lookups by an indexed or unique field from them instead of reading the collection. See *Indexes*. |

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
- **Revision counter.** Every row also carries `_rev`, bumped on each write
  and stripped on read. Updates are conditional on it, so two writers can't
  silently overwrite each other.
- **Unique guards:** `pk = "<slug>#unique#<field path>"`, `sk = "<value>"`,
  one small row per value of a `unique: true` field. See *Unique fields*.
- **Index rows:** `pk = "<slug>#index#<field path>"`,
  `sk = "<value key>#<id>"`, one small row per value of an `index: true`
  field. Value keys sort the way the values do. See *Indexes*.
- **Latest-version pointers:** `pk = "<slug>_versions#latest"`,
  `sk = "<parent key>"`, one row per versioned document naming its latest
  version.
- **Index markers:** `pk = "payload-ddb#indexes"`, one row per index that is
  known to cover every document.
- **No GSIs or LSIs.** Indexes are ordinary rows in the same table, which is
  what lets them be read with strong consistency. A filter no index can
  answer is a `Query` scoped by `pk`, with its predicates pushed to
  `FilterExpression` (DynamoDB still reads every row in the partition before
  filtering).

## What's implemented

All `BaseDatabaseAdapter` methods: `create`, `find`, `findOne`, `findDistinct`,
`count`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`, `upsert`,
`createGlobal`/`findGlobal`/`updateGlobal`, the five collection version methods,
the four global version methods, `queryDrafts`, and `updateJobs`.

### Queries

Every Payload `where` operator is supported: `equals`, `not_equals`,
`greater_than`, `greater_than_equal`, `less_than`, `less_than_equal`, `in`,
`not_in`, `all`, `exists`, `like`, `not_like`, `contains`, `near`, `within`,
`intersects`, plus `and` / `or` composition.

- **Pushdown where possible, JS for the rest.** Clauses DynamoDB can express
  go into a `FilterExpression`. The others — the case-insensitive text
  operators (`like`, `not_like`, `contains`), `all`, the geo operators, and
  any path that runs through a list — are evaluated in JS on the rows that
  come back. A `where` that mixes both kinds still narrows the read
  server-side.
- **Lists behave as in MongoDB.** A `hasMany` field, an `array` or `blocks`
  field, or a list inside `json` is transparent in a path: `tags equals 'x'`
  matches when any element is `'x'`, `items.label equals 'x'` when any row
  has that label. Negative operators hold only when no element matches.
- **Relationship paths.** `author.name equals 'Ada'` is resolved by querying
  the related collection and filtering on the ids it returns; multi-hop paths
  work the same way.
- **Localized fields.** With localization enabled, filters and sorts on a
  localized field address the request's locale (`title` → `title.en`), or the
  locale written into the path.
- **Operand casting.** Operands are cast to the field's stored type, so
  filters sent as strings (REST query strings, admin list filters) behave:
  numeric strings on `number` fields, `'true'`/`'false'` on `checkbox` fields,
  date strings on `date` fields, ids on relationships to numeric-id
  collections, and comma-delimited lists for `in` / `not_in` / `all`.
  DynamoDB compares strictly by type, so an operand the adapter can't cast
  (an unknown path) is compared as given.
- **`exists`** treats a field stored as `null` the same as a missing one, and
  for text-like fields an empty string as well.
- **Geo operators** work on `point` fields. Distances are great-circle
  metres; polygon tests are planar.

### Indexes

A filter normally reads the collection's whole partition. These clauses avoid
that and read only the matching documents:

| Clause | Answered from |
|---|---|
| `id` `equals` / `in` | the documents' own keys |
| `equals` / `in` on a `unique: true` field | the field's unique guards |
| `equals` / `in` on an `index: true` field | index rows |
| `greater_than(_equal)` / `less_than(_equal)` on an `index: true` field | index rows, which are kept in value order |

The clause has to hold for every result: at the top level or inside `and`.
An `or` qualifies as a whole when every one of its branches has such a
clause — the branches are looked up separately and combined — but not when
one branch would need the partition anyway. The rest of the `where` is then
evaluated on the documents selected. This covers login by `email`, pages by
`slug`, relationship population (`id in [...]`), filters on a relationship,
join fields, date or number ranges, and Payload's lookup of an upload by any
of its filenames.

- **Which fields.** `index: true` on a `text`, `email`, `number`, `date`,
  `relationship` or `upload` field — including `hasMany` fields (one row per
  element), fields in groups and named tabs, and localized fields (per
  locale). Payload sets the flag itself on the field a join points at.
  Not indexed: fields in arrays or blocks, polymorphic relationships, types
  where equality rarely narrows a read (`checkbox`, `select`), and the
  timestamps Payload manages (`createdAt`, `updatedAt`, `deletedAt`), where
  an index would turn every insert or update into a transaction.
- **Sorted pages.** A `find` sorted by one single-valued indexed field walks
  that field's index in order and stops when the page is full, instead of
  reading and sorting the collection. With `pagination: false` nothing else
  is read. With pagination, the total comes from a `COUNT` pass over the
  partition, which returns no documents but is still billed for the read.
  Not used on drafts-enabled collections, for sorts on several fields, or
  for pages more than 2,000 documents deep.
- **Consistency.** Index rows are written in the same transaction as their
  document and read with strong consistency, so a lookup sees a document as
  soon as it is written — which a DynamoDB GSI can't promise.
- **Write cost.** A write that adds or removes index rows is a transaction:
  twice the write units for the document, plus the rows. An update that
  leaves the indexed fields alone costs what it did before. A single-valued
  indexed field has a row for every document, blank ones included, so
  inserts into a collection with one are always transactions.
- **Large matches.** A lookup that finds more than 256 candidate documents
  falls back to reading the partition, which is the cheaper read by then.
- **Opting out.** `indexes: false` stops the index rows, the pointers and
  the routed lookups. Lookups by `id` and unique enforcement are unaffected.
  Every instance sharing a table must use the same setting.

**Versions.** Version rows are indexed by their `parent`, so listing or
pruning one document's versions reads only those. Each versioned document
(and each versioned global) also has a pointer to its latest version: saving
finds the version to demote in two key reads, and listing drafts fetches one
version per document rather than every version of every document.

**Existing data.** An index is only used once it is known to cover every
row. A partition that is empty when the adapter starts qualifies straight
away, which covers new tables and new collections. For one that already has
rows — after upgrading, or after adding `index: true` to a field — run the
backfill once; until then its lookups keep reading the partition:

```ts
import { backfillIndexes } from '@aih-software/payload-ddb'

const report = await backfillIndexes(payload)
// report.collections[slug].ready lists the indexes now in use
// report.versions[slug] covers that collection's or global's versions
```

The backfill is safe to run while the application is serving, and safe to
re-run. It also removes stray index rows, which an interrupted write can
leave behind (lookups ignore them, so they cost a little space, not
correctness). When upgrading from a version before 4.2, finish the rollout
first: older instances write rows without their index rows, so run the
backfill once after the last one is gone.

### Join fields

`join` fields are resolved for `find`, `findByID` and draft queries: one
lookup per target collection for all returned documents, grouped in memory,
with `limit`, `page`, `sort`, `where` and `count` applied per parent document.
The lookup uses the index on the field the join points at, so it doesn't read
the target collection's partition. Polymorphic joins (`collection: [...]`)
return `{ relationTo, value }` entries. Joined documents are read from the
target's published rows.

### Write guarantees

- **`create` is insert-only.** An id that is already taken is rejected with a
  `ValidationError` on `id` rather than replacing the existing document.
- **No lost updates.** Updates are read-merge-write, conditional on the row's
  revision. If another writer gets in first, the patch is re-applied to the
  fresh row, so concurrent updates to different fields both land. This holds
  per adapter call: Payload's own `update` operation fills the fields missing
  from a patch with the values it read beforehand, so two concurrent
  `payload.update` calls on one document can still overwrite each other.
- **One latest version.** Creating a version demotes the previous latest and
  moves the document's pointer in one transaction that checks nobody else got
  there first, so saving a document several times at once still leaves
  exactly one version marked latest.
- **Jobs are claimed once.** `updateJobs` uses the same check, so two workers
  polling the queue can't both take the same job.
- **Bulk writes are bounded.** `updateMany`, `deleteMany` and `deleteVersions`
  keep at most 25 requests in flight.
- **Oversized documents fail clearly.** DynamoDB caps an item at 400 KB;
  exceeding it raises a 413 naming the document instead of a bare
  `ValidationException`.

### Unique fields

`unique: true` is enforced for scalar fields at the top level or inside groups
and named tabs, including localized fields (per locale) and an auth
collection's `email` / `username`. Each value is claimed by a guard row
written in the same transaction as the document, so a duplicate is rejected
with a `ValidationError` on the field — also under concurrent writes. Blank
values (`null`, `''`) are not guarded. Unique fields inside arrays or blocks,
and `hasMany` fields, are not enforced.

Writes to a collection with unique fields are transactional and cost twice the
write units.

Documents written before this was enforced have no guards until they are next
saved. `backfillIndexes` (see *Indexes*) covers them in the same pass:

```ts
const report = await backfillIndexes(payload)
// report.collections[slug].conflicts lists pre-existing duplicates
```

A unique field with unresolved duplicates stays out of use for lookups until
they are fixed and the pass is run again. `backfillUniqueGuards` is kept as an
alias.

## Known limits / future work

- **Unindexed filters and sorts read the partition.** That includes the
  default sort on `createdAt`, sorts on several fields, and any filter with
  no indexed clause. The matches are sorted and paged in memory.
- **Totals are counted.** A paginated `find` that reads its page through an
  index still counts the matches with a pass over the partition.
- **Drafts are listed in full.** A drafts listing fetches the latest version
  of every document — one read each, not the whole versions partition — and
  then filters, sorts and pages in memory. `find` on a drafts-enabled
  collection does the same for documents it hasn't already matched.
- **A document's versions are read together.** Payload looks up a document's
  (or global's) newest version by sort before each save, which reads all of
  that document's versions — bounded by `versions.maxPerDoc`.
- **Payload-level transactions are no-op.** `beginTransaction` returns `null`;
  commit/rollback do nothing. Per-method atomicity (e.g. `createVersion`'s
  flip+put) uses DynamoDB `TransactWriteItems` already; full Payload-context
  transaction buffering across multiple adapter calls is its own milestone.
- **Relationship paths read the related collection.** `author.name equals
  'Ada'` first finds the matching authors — a partition read unless `name` is
  indexed — and then looks the documents up through the index on `author`,
  when it has one.
- **Joins don't see unpublished drafts** of the joined collection.
- **`locale: 'all'`** in a filter or sort falls back to the default locale.
- **`like` matches its operand as one substring.** Payload's Mongo adapter
  splits the operand into words and requires each of them to match.
- **Items are limited to 400 KB**, including a version row's full snapshot.

## Development

The package ships with a vitest integration test harness that boots Payload
against DynamoDB Local. Each spec file uses a unique table name so vitest
workers can run in parallel against a single shared container, which listens
on port 8001. Use Node 24, the version CI runs.

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

### Releasing

Releases are cut by CI on every push to `main` that carries a
[changeset](https://github.com/changesets/changesets) (`pnpm changeset`):

1. The integration tests run.
2. The version is bumped, committed as `chore(release): vX.Y.Z` and tagged.
3. The package is published to GitHub Packages as
   `@aih-software/payload-ddb`, and a GitHub Release is created.
4. For minor and major bumps, the same build is published to the public npm
   registry as `@open-aih/payload-ddb`.

The public publish uses npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers), so there is
no npm token to rotate. The trusted publisher configured on npmjs.com must
name this repository and the workflow file `release.yml`.

**Prereleases.** To try a change in a real project before releasing it, push
the commit to the `beta` branch (`git push origin HEAD:beta --force`). The
same workflow publishes it to both registries as `X.Y.Z-beta.<timestamp>`
under the `beta` dist-tag — install it with `@open-aih/payload-ddb@beta` —
and commits, tags and merges nothing. `latest` is untouched.

## License

MIT
