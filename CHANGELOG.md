# @aih-software/payload-ddb

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
