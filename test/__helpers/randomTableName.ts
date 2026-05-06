import { randomBytes } from 'node:crypto'

/**
 * Each spec file gets a unique DynamoDB table so vitest's per-file workers
 * can run in parallel against the shared DynamoDB Local container without
 * stepping on each other. The slug-style prefix is just a debugging aid when
 * you `aws dynamodb list-tables --endpoint-url http://localhost:8001`.
 */
export function randomTableName(suite: string): string {
  return `payload-test-${suite}-${randomBytes(4).toString('hex')}`
}
