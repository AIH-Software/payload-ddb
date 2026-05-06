import { createConnection } from 'node:net'

const HOST = process.env.PAYLOAD_DDB_TEST_HOST ?? 'localhost'
const PORT = Number(process.env.PAYLOAD_DDB_TEST_PORT ?? 8001)

function tcpPing(host: string, port: number, timeoutMs: number): Promise<string | true> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port })
    const done = (value: string | true) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => done(`timed out after ${timeoutMs}ms`), timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      done(true)
    })
    socket.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      done(err.code || err.message || String(err))
    })
  })
}

/**
 * Verify the docker-hosted DynamoDB Local accepts TCP connections. Prints a
 * friendly start-the-container message and exits non-zero when unreachable.
 * Mirrors Payload's own `assertDbReachable` so the failure mode is familiar.
 */
export async function assertDbReachable(): Promise<void> {
  const result = await tcpPing(HOST, PORT, process.env.CI === 'true' ? 10_000 : 2_000)
  if (result === true) return

  const lines = [
    '',
    '\x1b[31m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m',
    `\x1b[31m✗ DynamoDB Local is not reachable at ${HOST}:${PORT}\x1b[0m`,
    '',
    `  Reason  : ${result}`,
    '',
    `  \x1b[2mStart the service:\x1b[0m`,
    `    \x1b[36mpnpm docker:start\x1b[0m`,
    '\x1b[31m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m',
    '',
  ]
  process.stderr.write(lines.join('\n'))
  process.exit(1)
}

export const TEST_DDB_HOST = HOST
export const TEST_DDB_PORT = PORT
export const TEST_DDB_ENDPOINT = `http://${HOST}:${PORT}`
