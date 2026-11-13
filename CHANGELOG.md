# @aih-software/payload-ddb

## 4.1.0

### Minor Changes

- 7c6408e: **Write integrity:** unique fields, no lost updates, single job claims.

  - `unique: true` is enforced. Each unique value is claimed by a guard row
    written in the same transaction as its document; a duplicate is rejected
    with a `ValidationError` on the field, also under concurrent writes. Covers
    scalar fields at the top level or in groups / named tabs, localized fields
    (per locale), and an auth collection's `email` / `username`. Writes to
    collections with unique fields become transactional (twice the write
    units). Documents written before this release get their guards the next
    time they are saved, or all at once via the new `backfillUniqueGuards`
    export, which also reports pre-existing duplicates.
  - Updates no longer overwrite each other. Every row carries a `_rev` counter;
    a read-merge-write only lands if the row is still at the revision it read,
    and is otherwise re-applied to the fresh row. Applies to `updateOne`,
    `updateMany`, `upsert`, `updateGlobal` and the version update methods.
  - New `updateJobs` implementation: a queued job can be claimed by one worker
    only, and `log: { $push }` appends to the job log instead of replacing it
    with the operator object.
  - Bulk writes (`updateMany`, `deleteMany`, `deleteVersions`) keep at most 25
    requests in flight instead of firing one per row at once.
  - A document over DynamoDB's 400 KB item limit is rejected with a 413 that
    names the document, instead of a bare `ValidationException`.

  Existing rows need no migration: a row without `_rev` is treated as revision
  zero, and missing guards are created lazily.

- 7c6408e: **Query coverage:** every Payload `where` operator, list and relationship
  paths, localized fields, and join fields.

  - Adds the six missing operators: `contains`, `not_like`, `all`, and the geo
    operators `near`, `within` and `intersects` on `point` fields.
  - Lists are transparent in a path, as in MongoDB: a `hasMany` field, an
    `array` or `blocks` field, or a list inside `json` matches when any element
    does (`tags equals 'x'`, `items.label equals 'x'`). These used to match
    nothing.
  - A path through a relationship (`author.name equals 'Ada'`, any number of
    hops) is resolved by querying the related collection. These used to match
    nothing.
  - With localization enabled, filters and sorts on a localized field address
    the request's locale. These used to compare against the whole
    `{ en, es }` map and match nothing.
  - `join` fields are resolved for `find`, `findByID` and draft queries, with
    `limit`, `page`, `sort`, `where` and `count` applied per parent document.
    They used to come back empty.
  - A `where` that mixes pushable and JS-only clauses now pushes down what it
    can instead of reading the whole partition; rows are re-checked in JS.
  - `migrationDir` is passed through to the adapter (it was declared but
    ignored).

## 4.0.0

### Major Changes

- 6f85dbf: **Breaking:** `where` operands are now cast to the field's stored type, so
  filters sent as strings no longer silently match nothing.

  The REST API (and the admin list filters built on it) delivers operands as
  strings: `?where[price][greater_than]=10` arrives as `"10"`. DynamoDB compares
  strictly by type, so that filter never matched a numeric `price` — no error,
  just an empty result. Every method that takes a `where` now runs it through
  `castWhere` first, following the rules of Payload's Mongo and Postgres
  adapters:

  - `number`: numeric strings → number.
  - `checkbox`: `'true'` / `'false'` → boolean.
  - `date`: date strings (including date-only ones like `2026-01-01`), epoch
    milliseconds and `Date`s → the full ISO string that is stored.
  - `relationship` / `upload`: `'null'` → `null`, and ids → number when the
    related collection has numeric ids (also inside a polymorphic
    `{ relationTo, value }`). Likewise `id` on a numeric-id collection.
  - `in` / `not_in`: a comma-delimited string → a list, each member cast.
  - `exists`: `'true'` / `'false'` → boolean (previously the string `'false'`
    was treated as true). For text-like fields an empty string now counts as
    absent, matching the Mongo adapter — that is what a cleared text input
    leaves behind.

  Operands the adapter can't confidently cast are left as given: unknown paths,
  and paths that continue through a relationship or array.

  Two related fixes:

  - The JS evaluator no longer falls back to comparing operands of different
    types as text, which matched rows the DynamoDB pushdown rejected.
  - A drafts query (`draft: true`) filtered by `id` returned nothing: core
    rewrites `id` to the version row's `parent`, and the adapter didn't map it
    back onto the docs it projects.

  This is breaking in the sense that queries which used to return nothing (or,
  on the JS path, rows matched by accident) now return the rows they describe:
  REST and admin filters on number, checkbox, date and relationship fields,
  `exists` on text fields holding an empty string, and draft queries filtered
  by `id`. Review any code that depended on those filters being inert.

- 6f85dbf: **Breaking:** `create` no longer overwrites an existing document, and the two
  `where` evaluators now return the same rows.

  `create` wrote with a plain `PutItem`, so a caller-supplied id that collided
  with an existing doc silently replaced it. The write is now insert-only
  (`attribute_not_exists(pk)`), and a collision throws a `ValidationError` on
  `id` — the same shape the Mongo and Postgres adapters produce for a duplicate
  primary key.

  A `where` is evaluated either by DynamoDB (`FilterExpression` pushdown) or in
  JS (`matchesWhere`), depending on whether it contains `like` and whether the
  collection has drafts. The two disagreed in three places:

  - `exists`: the pushdown counted a field stored as `null` as existing. Both
    now treat `null` the same as a missing attribute.
  - `Date` operands: the JS path compared the raw `Date` against stored ISO
    strings, so `equals` / `in` never matched and ordered comparisons were
    wrong. It now normalizes operands the way the pushdown does.
  - Object operands (e.g. a polymorphic relationship's `{ relationTo, value }`):
    the JS path compared by reference and never matched. It now compares by
    content, as DynamoDB does.

  `test/parity` runs each case through both evaluators to keep them aligned.

  This is breaking for any consumer that relied on `create` replacing a document
  whose id already existed (it now throws), or on `exists` counting a field
  stored as `null` as present.

## 3.1.0

### Minor Changes

- 69adcb3: Minor Bump for publish target

## 3.0.0

### Major Changes

- 9c1f8f6: **Security:** strict-projection write paths to fix unknown-field persistence.

  Previously every write path spread the incoming `data` straight into a
  `PutCommand` with no schema awareness, so any stray request-body key (most
  visibly the registration form's `confirm-password`) would persist verbatim
  on the row and surface back through reads — including auth endpoints like
  `/api/users/me`. This was a credential-leak class that the Mongo and
  Postgres adapters never had because their schema layers (Mongoose `strict`,
  Drizzle column lists) drop unknown fields silently.

  `create`, `updateOne`, `updateMany`, `upsert`, `createGlobal`,
  `updateGlobal`, `createVersion`, `createGlobalVersion`, `updateVersion`,
  and `updateGlobalVersion` now project the merged item against the
  collection or global's `fields` config (recursive across `group`, `array`,
  `blocks`, named tabs) before persisting. Reserved framework keys (`id`,
  `createdAt`, `updatedAt`, `_status`, plus the version-row metadata layer)
  are allow-listed.

  This is technically breaking for any consumer that was depending on the
  adapter persisting fields not declared in their collection schema —
  behavior the other Payload adapters never offered.

  **Cleanup for legacy data:** the package now exports `scrubUnknownFields`
  for one-shot cleanup of rows written before this fix landed:

  ```ts
  import { getPayload } from "payload";
  import config from "./payload.config";
  import { scrubUnknownFields } from "@aih-software/payload-ddb";

  const payload = await getPayload({ config });
  const report = await scrubUnknownFields(payload);
  console.log(report);
  await payload.destroy();
  ```

  Existing rows touched by any subsequent update also get scrubbed
  incrementally — the projection runs over the merged result, not just the
  incoming patch.

## 2.5.0

### Minor Changes

- 02fe6a5: Adds github actions for publishing public pkg, removes test artifacts

## 2.4.0

### Minor Changes

- 7ded07c: Updated docs

## 2.3.0

### Minor Changes

- fa18ee0: minor version bump to trigger release

### Patch Changes

- 0456521: Adds changesets and github actions publish workflow
- 91df541: updates db assertions
