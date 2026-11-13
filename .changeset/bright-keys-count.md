---
"@aih-software/payload-ddb": major
---

**Breaking:** `where` operands are now cast to the field's stored type, so
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
