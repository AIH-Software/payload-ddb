---
"@aih-software/payload-ddb": minor
---

**Write integrity:** unique fields, no lost updates, single job claims.

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
