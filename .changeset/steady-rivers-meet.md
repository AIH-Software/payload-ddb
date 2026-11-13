---
"@aih-software/payload-ddb": minor
---

**Query coverage:** every Payload `where` operator, list and relationship
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
