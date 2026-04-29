/**
 * Convert values that DynamoDB's marshaller can't represent natively into a
 * shape it can. Today this is just `Date → ISO string`, but the same hook is
 * the right place for any future "Payload sends X, Dynamo wants Y" coercions
 * (e.g. `BigInt`).
 *
 * Why this exists: with `convertClassInstanceToMap: true` (our default
 * translate option), a `Date` instance has no enumerable own properties and
 * marshals as an empty map `{}`. That stores fine but compares as type `M`,
 * which `FilterExpression` operators like `>` reject. Stringifying to ISO
 * keeps Mongo-parity ordering (lex compare on ISO strings = chronological
 * order) and round-trips cleanly back to a `Date` in user code.
 */
export function normalizeForDynamo<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (value instanceof Date) return value.toISOString() as T
  if (Array.isArray(value)) return value.map(normalizeForDynamo) as T
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeForDynamo(v)
    }
    return out as T
  }
  return value
}
