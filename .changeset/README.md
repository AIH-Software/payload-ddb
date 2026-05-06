# Changesets

This directory holds [changesets](https://github.com/changesets/changesets)
files used to track unreleased changes.

## Adding a changeset

```bash
pnpm changeset
```

The wizard prompts for:
- **Bump type:** `patch`, `minor`, or `major`. Follow semver — breaking changes
  to the adapter contract or public exports are major; new functionality is
  minor; bug fixes are patch.
- **Summary:** one or two lines that go straight into the changelog.

Commit the generated `.changeset/<random>.md` file with your PR. The release
workflow on `main` rolls all unreleased changesets into a single version bump
the next time it runs.

## Release gate

The `.github/workflows/release.yml` workflow only cuts a release when at
least one pending changeset is `minor` or `major`. Patch-only batches stay
queued in this directory and ride along with the next minor/major release.

If you have an urgent patch that needs to ship on its own, pair it with a
`minor` changeset (typically describing the same fix or a related improvement)
to trigger the workflow.
