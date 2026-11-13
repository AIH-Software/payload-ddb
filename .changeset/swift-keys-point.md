---
"@aih-software/payload-ddb": minor
---

**Indexed lookups:** filters by id, unique field or `index: true` field no
longer read the whole collection.

- `id` `equals` / `in` reads the documents by key. This is what relationship
  population sends.
- `equals` / `in` on a `unique: true` field is answered from the field's
  unique guards.
- `equals` / `in` on an `index: true` field (`text`, `email`, `number`,
  `relationship`, `upload`, including `hasMany`, grouped and localized
  fields) is answered from new index rows. Join fields use this too.
- Index rows are written in the same transaction as their document and read
  with strong consistency. Nothing changes on the table itself: no GSIs.
- New `indexes` option (default `true`); `false` turns the index rows and the
  routed lookups off.
- New `backfillIndexes(payload)` export. It builds guards and index rows for
  existing documents and marks each index complete. `backfillUniqueGuards` is
  now an alias for it.

**Upgrading.** An index is used only once it covers every document. Empty
collections qualify on their own; for collections that already hold
documents, run `backfillIndexes` once after the rollout has finished. Until
then their lookups read the partition exactly as before.

**Write cost.** A write that adds or removes index rows is a transaction,
which doubles the write units for that write. Updates that leave the indexed
fields alone are unchanged.

Also: a plain write that collides with a transaction in flight on the same
row is now retried instead of surfacing `TransactionConflictException`.
