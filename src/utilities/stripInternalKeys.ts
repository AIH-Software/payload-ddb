/**
 * Drop the adapter's internal `pk`/`sk` attributes from a row before it
 * crosses the boundary back into Payload land. Callers see clean documents
 * keyed by the user-facing `id`; the composite-key plumbing stays internal.
 */
export function stripInternalKeys(item: Record<string, unknown>): Record<string, unknown> {
  const { pk: _pk, sk: _sk, ...rest } = item
  return rest
}
