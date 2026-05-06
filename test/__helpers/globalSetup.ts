import { assertDbReachable } from './assertDbReachable.js'

/**
 * Vitest global setup — runs once before any worker boots. Probes DynamoDB
 * Local once instead of in every spec's beforeAll, and gives a single clear
 * error message if the container isn't running.
 */
export default async function setup() {
  await assertDbReachable()
}
