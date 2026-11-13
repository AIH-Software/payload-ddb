---
"@aih-software/payload-ddb": minor
---

**Indexes:** filters by id, unique field or `index: true` field, range
filters, sorted pages and version lookups no longer read a whole partition.

Lookups
- `id` `equals` / `in` reads the documents by key. This is what relationship
  population sends.
- `equals` / `in` on a `unique: true` field is answered from the field's
  unique guards.
- `equals` / `in` and `greater_than(_equal)` / `less_than(_equal)` on an
  `index: true` field (`text`, `email`, `number`, `date`, `relationship`,
  `upload`, including `hasMany`, grouped and localized fields) are answered
  from new index rows, which are kept in value order. Join fields use them
  too.
- An `or` is answered from indexes too when every branch has one of the
  clauses above. That is the query Payload runs to find an upload under its
  filename or any image size's filename.
- A `find` sorted by one single-valued indexed field reads its page by
  walking that index in order instead of reading and sorting the collection.

Versions
- Version rows are indexed by `parent`, so one document's versions are read
  without the rest.
- Each versioned document and global has a pointer to its latest version.
  Saving no longer reads the versions partition to find the version to
  demote, and listing drafts fetches one version per document.
- Saving a document several times at once could leave two versions marked
  `latest`. The pointer is now checked in the same transaction, so exactly
  one is.

Index rows are written in the same transaction as their row and read with
strong consistency. Nothing changes on the table itself: no GSIs.

- New `indexes` option (default `true`); `false` turns all of the above off
  except lookups by `id`.
- New `backfillIndexes(payload)` export. It builds guards, index rows and
  pointers for existing rows, removes stray index rows, and marks each index
  complete. `backfillUniqueGuards` is now an alias for it.

**Upgrading.** An index is used only once it covers every row. Empty
partitions qualify on their own; for collections that already hold
documents, run `backfillIndexes` once after the rollout has finished. Until
then their lookups read the partition exactly as before.

**Write cost.** A write that adds or removes index rows is a transaction,
which doubles the write units for that write. Updates that leave the indexed
fields alone are unchanged. Creating a version writes two more small rows in
the transaction it already used.

Also:
- Rows that tie on every sort key are now ordered by id, so the same query
  always returns the same order.
- With `pagination: false`, a page read through an index reports
  `totalDocs` as the number of documents returned, as Payload's SQL adapters
  do, instead of counting every match.
- A plain write that collides with a transaction in flight on the same row
  is retried instead of surfacing `TransactionConflictException`, and a
  delete waits such a transaction out rather than leaving its unique guards
  behind.
