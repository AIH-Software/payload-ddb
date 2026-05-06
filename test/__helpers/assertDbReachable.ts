import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb'

const HOST = process.env.PAYLOAD_DDB_TEST_HOST ?? 'localhost'
const PORT = Number(process.env.PAYLOAD_DDB_TEST_PORT ?? 8001)

export const TEST_DDB_HOST = HOST
export const TEST_DDB_PORT = PORT
export const TEST_DDB_ENDPOINT = `http://${HOST}:${PORT}`

/**
 * Single readiness probe: issue a real `ListTables` call with a hard 2s
 * abort. A bare TCP ping passes the moment the JVM binds the port, which
 * leaves a window where the container is "up" but the DynamoDB API hasn't
 * finished initializing — the first adapter call then races and fails. A
 * real API call closes that gap.
 */
async function probeOnce(): Promise<string | true> {
  const client = new DynamoDBClient({
    endpoint: TEST_DDB_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    // Disable SDK retries so we control the loop ourselves; we want fast
    // probe + sleep + retry rather than the SDK's exponential backoff.
    maxAttempts: 1,
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2_000)
  try {
    await client.send(new ListTablesCommand({}), { abortSignal: controller.signal })
    return true
  } catch (err) {
    return (err as Error)?.message ?? String(err)
  } finally {
    clearTimeout(timer)
    client.destroy()
  }
}

/**
 * Block until DynamoDB Local responds to a real API call, polling at 250ms.
 * Local timeout is short (5s) so dev failures fail fast; CI gets 30s to
 * absorb the cold-start variance of GitHub-hosted runners.
 *
 * Exits the process with a friendly error on timeout — this runs in vitest's
 * globalSetup, so a thrown error would surface as a noisy stack trace.
 */
export async function assertDbReachable(): Promise<void> {
  const totalMs = process.env.CI === 'true' ? 30_000 : 5_000
  const deadline = Date.now() + totalMs
  let lastErr = 'unknown error'

  while (Date.now() < deadline) {
    const result = await probeOnce()
    if (result === true) return
    lastErr = result
    await new Promise((r) => setTimeout(r, 250))
  }

  const lines = [
    '',
    '\x1b[31m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m',
    `\x1b[31m✗ DynamoDB Local did not become ready within ${totalMs}ms at ${HOST}:${PORT}\x1b[0m`,
    '',
    `  Last error : ${lastErr}`,
    '',
    `  \x1b[2mStart the service:\x1b[0m`,
    `    \x1b[36mpnpm docker:start\x1b[0m`,
    '\x1b[31m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m',
    '',
  ]
  process.stderr.write(lines.join('\n'))
  process.exit(1)
}
