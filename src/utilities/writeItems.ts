import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import { APIError } from 'payload'

import type { DynamoAdapter } from '../types.js'

import { mapWithConcurrency } from './mapWithConcurrency.js'
import { normalizeForDynamo } from './normalizeForDynamo.js'
import { revisionOf, stripInternalKeys } from './stripInternalKeys.js'
import { sameGuard, type UniqueGuard, uniqueGuardsFor } from './uniqueGuards.js'

/**
 * The single place the adapter's methods mutate the table. Every `create*`,
 * `update*`, `upsert` and `delete*` method hands its finished document (or
 * the id to remove) to one of the helpers below instead of building its own
 * DynamoDB command.
 *
 * Keeping writes behind one module means the row's physical shape — the
 * `pk`/`sk` composite key, the `_rev` revision counter, value normalization,
 * and any future index attributes — is derived in exactly one spot
 * (`toItem`), and anything that needs to see every mutation (e.g. buffering
 * writes for a Payload-level transaction) has one seam to hook into.
 *
 * Three guarantees are enforced here, each by a condition DynamoDB checks
 * atomically with the write:
 *
 *  - **Insert-only** (`mustNotExist`): a new document can't replace one that
 *    already has its id.
 *  - **No lost updates** (`replaces`): a read-merge-write only lands if the
 *    row is still at the revision that was read. See `stripInternalKeys`.
 *  - **Unique fields** (`unique`): the document and a guard row per unique
 *    value are written in one transaction. See `uniqueGuards`.
 *
 * Callers stay responsible for everything Payload-shaped: locating the
 * target, merging the patch, defaulting timestamps, and projecting against
 * the collection/global schema. These helpers only persist what they're
 * given.
 *
 * Not routed through here: `scrubUnknownFields`, a one-shot maintenance pass
 * that re-puts raw rows at their original keys without normalizing them.
 */

/**
 * How many single-row writes a bulk operation keeps in flight at once.
 * Matches `BatchWriteItem`'s page size and stays well under the SDK's default
 * socket pool (50), so a large `deleteMany` / `updateMany` doesn't starve
 * every other request the process is making.
 */
export const WRITE_CONCURRENCY = 25

/**
 * The write's own precondition didn't hold: the id was already taken
 * (`mustNotExist`), or the row changed since it was read (`replaces`).
 */
export class ConditionFailedError extends Error {
  constructor() {
    super('payload-ddb: write condition failed')
    this.name = 'ConditionFailedError'
  }
}

/** Another document already holds this value of a unique field. */
export class UniqueViolationError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`payload-ddb: value of unique field "${path}" is already in use`)
    this.name = 'UniqueViolationError'
    this.path = path
  }
}

/**
 * True when `err` means "this write's precondition didn't hold" — the signal
 * a read-merge-write loop retries on, and that `create` reports as a
 * duplicate id.
 */
export function isConditionalCheckFailed(err: unknown): boolean {
  return (
    err instanceof ConditionFailedError ||
    (err instanceof Error && err.name === 'ConditionalCheckFailedException')
  )
}

const ITEM_TOO_LARGE = /item size.*exceeded/i

type CancellationReason = { Code?: string; Message?: string }

function cancellationReasons(err: unknown): CancellationReason[] | null {
  if (!(err instanceof Error) || err.name !== 'TransactionCanceledException') return null
  const reasons = (err as { CancellationReasons?: CancellationReason[] }).CancellationReasons
  return Array.isArray(reasons) ? reasons : []
}

/**
 * DynamoDB caps a single item at 400 KB and reports a breach as a bare
 * `ValidationException` (or, inside a transaction, as one of the
 * cancellation reasons). Re-throw it as an error that says which document
 * was too big and why, and that Payload will show to the API caller.
 */
function rethrowIfItemTooLarge(err: unknown, partition: string, id: unknown): void {
  if (!(err instanceof Error)) return
  const tooLarge =
    ITEM_TOO_LARGE.test(err.message) ||
    (cancellationReasons(err) ?? []).some((reason) => ITEM_TOO_LARGE.test(reason?.Message ?? ''))
  if (!tooLarge) return

  throw new APIError(
    `payload-ddb: document "${String(id)}" in "${partition}" is too large to store. ` +
      'DynamoDB limits a single item to 400 KB, including every field and (for versions) the full snapshot.',
    413,
    null,
    true,
  )
}

function requireDocClient(adapter: DynamoAdapter) {
  const docClient = adapter.docClient
  if (!docClient) {
    throw new Error('payload-ddb: docClient is not initialized — call connect() first.')
  }
  return docClient
}

/**
 * Composite key for a row. `sk` is always the stringified `id` — collections
 * with Number ids keep the original type on the `id` attribute while the
 * sort key stays String (see `ensureTable`).
 */
function keyFor(partition: string, id: unknown): { pk: string; sk: string } {
  return { pk: partition, sk: String(id) }
}

/**
 * Turn a Payload-facing document into the row we store: normalized values
 * plus the internal attributes, keyed by the document's own `id`.
 * The inverse of `stripInternalKeys`.
 */
function toItem(
  partition: string,
  doc: Record<string, unknown>,
  revision: number,
): Record<string, unknown> {
  return normalizeForDynamo({ ...doc, ...keyFor(partition, doc['id']), _rev: revision })
}

type Condition = {
  ConditionExpression?: string
  ExpressionAttributeNames?: Record<string, string>
  ExpressionAttributeValues?: Record<string, unknown>
}

/** "This guard row is free, or it is already mine." */
function ownedBy(owner: string): Required<Condition> {
  return {
    ConditionExpression: 'attribute_not_exists(pk) OR #owner = :owner',
    ExpressionAttributeNames: { '#owner': 'owner' },
    ExpressionAttributeValues: { ':owner': owner },
  }
}

/**
 * Claim one unique guard for `owner` outside of a document write (used by
 * `backfillUniqueGuards`). Returns `null` when the guard is now the owner's,
 * or the id of the document that already holds it.
 */
export async function claimGuard(
  adapter: DynamoAdapter,
  guard: UniqueGuard,
  owner: string,
): Promise<null | string> {
  const docClient = requireDocClient(adapter)
  try {
    await docClient.send(
      new PutCommand({
        TableName: adapter.tableName,
        Item: { ...guard.key, owner },
        ...ownedBy(owner),
      }),
    )
    return null
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'ConditionalCheckFailedException') throw err
    const held = await docClient.send(
      new GetCommand({ TableName: adapter.tableName, Key: guard.key, ConsistentRead: true }),
    )
    return String(held.Item?.['owner'] ?? 'unknown')
  }
}

export type PutOptions = {
  /** Insert-only: fail if a row already occupies this id. */
  mustNotExist?: boolean
  /**
   * The row, as read, that this write was merged onto. The write lands only
   * if the stored row is still at that revision.
   */
  replaces?: Record<string, unknown>
  /** Enforce the unique fields of this collection for `doc`. */
  unique?: { collection: string }
}

/**
 * Write `doc` as the full row at (`partition`, `doc.id`). The adapter's
 * update paths are read-merge-write, so this is the write half of both
 * inserts and updates.
 *
 * Throws `ConditionFailedError` when `mustNotExist` / `replaces` doesn't
 * hold, and `UniqueViolationError` when a unique value is taken.
 */
export async function putItem(
  adapter: DynamoAdapter,
  partition: string,
  doc: Record<string, unknown>,
  options: PutOptions = {},
): Promise<void> {
  const docClient = requireDocClient(adapter)
  const { mustNotExist, replaces, unique } = options

  const previousRevision = replaces ? revisionOf(replaces) : undefined
  const item = toItem(partition, doc, (previousRevision ?? 0) + 1)

  let condition: Condition = {}
  if (mustNotExist) {
    // Every row carries `pk`, so "no `pk` attribute" means "no row here".
    condition = { ConditionExpression: 'attribute_not_exists(pk)' }
  } else if (replaces && previousRevision === undefined) {
    // Read from a row written before revisions existed: it must still be
    // there, and nobody may have given it a revision in the meantime.
    condition = {
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#rev)',
      ExpressionAttributeNames: { '#rev': '_rev' },
    }
  } else if (replaces) {
    condition = {
      ConditionExpression: '#rev = :rev',
      ExpressionAttributeNames: { '#rev': '_rev' },
      ExpressionAttributeValues: { ':rev': previousRevision },
    }
  }

  const guards = unique ? uniqueGuardsFor(adapter, unique.collection, partition, doc) : []
  // Guards for values this document no longer has. Those are released, but
  // only if they're ours: a row written before guards existed may share a
  // value with the document that later claimed it.
  let released =
    unique && replaces
      ? uniqueGuardsFor(adapter, unique.collection, partition, replaces).filter(
          (old) => !guards.some((current) => sameGuard(current, old)),
        )
      : []

  try {
    if (guards.length === 0 && released.length === 0) {
      await docClient.send(
        new PutCommand({ TableName: adapter.tableName, Item: item, ...condition }),
      )
      return
    }

    const owner = String(doc['id'])
    const mine = ownedBy(owner)

    // At most two passes: if a released guard turns out to belong to someone
    // else, leave it alone and write the rest.
    for (;;) {
      const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
        { Put: { TableName: adapter.tableName, Item: item, ...condition } },
        // Re-asserted on every write, not only when a value changes, so
        // documents that predate guards pick theirs up as they're edited.
        ...guards.map((guard) => ({
          Put: { TableName: adapter.tableName, Item: { ...guard.key, owner }, ...mine },
        })),
        ...released.map((guard) => ({
          Delete: { TableName: adapter.tableName, Key: guard.key, ...mine },
        })),
      ]

      try {
        await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
        return
      } catch (err) {
        const reasons = cancellationReasons(err)
        if (!reasons) throw err
        const failed = (index: number) => {
          const code = reasons[index]?.Code
          return code !== undefined && code !== 'None'
        }

        if (failed(0)) throw new ConditionFailedError()
        const taken = guards.findIndex((_, index) => failed(1 + index))
        if (taken !== -1) {
          // A clash with a concurrent transaction on the same guard isn't
          // proof the value is taken — let the caller retry and find out.
          if (reasons[1 + taken]?.Code === 'TransactionConflict') throw new ConditionFailedError()
          throw new UniqueViolationError(guards[taken]!.path)
        }
        const kept = released.filter((_, index) => !failed(1 + guards.length + index))
        if (kept.length === released.length) throw err
        released = kept
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      throw new ConditionFailedError()
    }
    rethrowIfItemTooLarge(err, partition, doc['id'])
    throw err
  }
}

export type DeleteOptions = {
  returnOld?: boolean
  /**
   * The document being deleted, in a collection with unique fields: its
   * guards are released in the same transaction.
   */
  unique?: { collection: string; doc: Record<string, unknown> }
}

/**
 * Delete the row at (`partition`, `id`). With `returnOld`, the deleted row
 * comes back (internal keys stripped) so callers can delete and capture the
 * document in one round trip; `null` if no row existed. Without it the
 * result is always `null`.
 */
export async function deleteItem(
  adapter: DynamoAdapter,
  partition: string,
  id: unknown,
  options: DeleteOptions = {},
): Promise<null | Record<string, unknown>> {
  const docClient = requireDocClient(adapter)
  const key = keyFor(partition, id)

  const guards = options.unique
    ? uniqueGuardsFor(adapter, options.unique.collection, partition, options.unique.doc)
    : []

  if (guards.length > 0) {
    const mine = ownedBy(String(id))
    try {
      await docClient.send(
        new TransactWriteCommand({
          TransactItems: [
            { Delete: { TableName: adapter.tableName, Key: key } },
            ...guards.map((guard) => ({
              Delete: { TableName: adapter.tableName, Key: guard.key, ...mine },
            })),
          ],
        }),
      )
    } catch (err) {
      // A guard that belongs to another document (possible for rows that
      // predate guards) cancels the transaction. The document must still go,
      // so delete it alone and leave that guard with its owner.
      if (!cancellationReasons(err)) throw err
      await docClient.send(new DeleteCommand({ TableName: adapter.tableName, Key: key }))
    }
    return options.returnOld ? options.unique!.doc : null
  }

  const result = await docClient.send(
    new DeleteCommand({
      TableName: adapter.tableName,
      Key: key,
      ...(options.returnOld ? { ReturnValues: 'ALL_OLD' as const } : {}),
    }),
  )

  return options.returnOld && result.Attributes ? stripInternalKeys(result.Attributes) : null
}

/**
 * Delete several rows from one partition, one request each, at most
 * `WRITE_CONCURRENCY` in flight at a time. Pass `uniqueCollection` when the
 * rows belong to a collection whose unique guards must be released with them.
 *
 * `BatchWriteItem` could cut the request count (25 deletes per call) but has
 * partial-failure semantics that need retry logic — out of scope until we
 * wire up retries. Bounded single deletes are simple and correct.
 */
export async function deleteItems(
  adapter: DynamoAdapter,
  partition: string,
  rows: Record<string, unknown>[],
  uniqueCollection?: string,
): Promise<void> {
  await mapWithConcurrency(rows, WRITE_CONCURRENCY, (row) =>
    deleteItem(
      adapter,
      partition,
      row['id'],
      uniqueCollection ? { unique: { collection: uniqueCollection, doc: row } } : {},
    ),
  )
}

/**
 * Insert `doc` as a version row and, in the same `TransactWriteItems` call,
 * clear `latest` on the row that held it before. If a crash occurs mid-flow
 * neither mutation lands, so a parent never ends up with two `latest=true`
 * rows or zero.
 *
 * `previousLatest` is the row the caller found holding `latest=true`, or
 * `null` when this is the first version.
 */
export async function putVersionAsLatest(
  adapter: DynamoAdapter,
  partition: string,
  doc: Record<string, unknown>,
  previousLatest: null | Record<string, unknown>,
): Promise<void> {
  const docClient = requireDocClient(adapter)

  const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = []

  if (previousLatest) {
    transactItems.push({
      Update: {
        TableName: adapter.tableName,
        Key: keyFor(partition, previousLatest['id']),
        // Bumping `_rev` along with the flip means a read-merge-write that
        // read this row while it was still latest can't write `latest` back.
        UpdateExpression: 'SET #latest = :false ADD #rev :one',
        ExpressionAttributeNames: { '#latest': 'latest', '#rev': '_rev' },
        ExpressionAttributeValues: { ':false': false, ':one': 1 },
        // Fail the whole transaction if the previous row was deleted between
        // the caller's read and this transaction. Better to error and let the
        // caller retry than to silently leave the new version with a phantom
        // flip.
        ConditionExpression: 'attribute_exists(pk)',
      },
    })
  }

  transactItems.push({
    Put: {
      TableName: adapter.tableName,
      Item: toItem(partition, doc, 1),
    },
  })

  try {
    await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
  } catch (err) {
    rethrowIfItemTooLarge(err, partition, doc['id'])
    throw err
  }
}
