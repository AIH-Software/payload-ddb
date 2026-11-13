---
"@aih-software/payload-ddb": major
---

**Breaking:** `create` no longer overwrites an existing document, and the two
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
