/**
 * The revision each row object was read at, kept beside the object rather
 * than on it so documents handed back to Payload carry no adapter fields.
 * Entries vanish with the row object.
 */
const revisions = new WeakMap<object, number>()

/**
 * Drop the adapter's internal attributes (`pk`, `sk`, `_rev`) from a row
 * before it crosses the boundary back into Payload land. Callers see clean
 * documents keyed by the user-facing `id`; the composite-key plumbing stays
 * internal.
 *
 * The row's revision is remembered against the returned object — see
 * `revisionOf`.
 */
export function stripInternalKeys(item: Record<string, unknown>): Record<string, unknown> {
  const { _rev, pk: _pk, sk: _sk, ...rest } = item
  if (typeof _rev === 'number') revisions.set(rest, _rev)
  return rest
}

/**
 * The revision a row had when it was read, or `undefined` for a row written
 * before revisions existed (or for an object that didn't come from a read).
 *
 * Every write the adapter makes bumps `_rev`. A read-merge-write passes the
 * row it read as `replaces`, and the write only lands if the stored revision
 * is still this one — otherwise someone else wrote in between and the merge
 * has to be redone on the fresh row.
 */
export function revisionOf(row: object): number | undefined {
  return revisions.get(row)
}
