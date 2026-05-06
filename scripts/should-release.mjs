import { readFile, appendFile } from 'node:fs/promises'
import { argv, env, exit } from 'node:process'

/**
 * Decide whether the queued changesets warrant a release.
 *
 * Reads the JSON written by `changeset status --output=...` and emits two
 * GitHub Actions outputs:
 *   - `bump`           — highest pending bump level (`none|patch|minor|major`)
 *   - `should-release` — `true` only when `bump` is `minor` or `major`
 *
 * Patch-only batches stay queued: the workflow exits cleanly without
 * versioning or publishing, so the next minor/major bump bundles them in.
 */

const statusPath = argv[2] ?? '/tmp/changeset-status.json'

const order = ['none', 'patch', 'minor', 'major']

let releases = []
try {
  const raw = await readFile(statusPath, 'utf8')
  releases = (JSON.parse(raw).releases ?? []).filter((r) => r && r.type)
} catch (err) {
  // No status file (e.g. zero changesets) → exit clean with should-release=false.
  if (err.code !== 'ENOENT') throw err
}

let max = 0
for (const r of releases) {
  const idx = order.indexOf(r.type)
  if (idx > max) max = idx
}

const bump = order[max] ?? 'none'
const shouldRelease = max >= 2

const lines = `bump=${bump}\nshould-release=${shouldRelease}\n`
process.stdout.write(lines)

if (env.GITHUB_OUTPUT) {
  await appendFile(env.GITHUB_OUTPUT, lines)
}

exit(0)
