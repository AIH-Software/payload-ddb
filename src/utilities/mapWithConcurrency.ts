/**
 * `Promise.all(items.map(fn))`, but with at most `limit` calls in flight.
 * Results come back in input order.
 *
 * Bulk writes need this: firing one request per row all at once means a
 * `deleteMany` over a few thousand rows opens a few thousand concurrent
 * requests, which exhausts the SDK's socket pool and invites throttling.
 * A rejection stops new work from starting and rejects the whole call, same
 * as `Promise.all`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  let failed = false

  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await fn(items[index] as T, index)
      } catch (err) {
        failed = true
        throw err
      }
    }
  }

  const workers = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workers }, worker))
  return results
}
