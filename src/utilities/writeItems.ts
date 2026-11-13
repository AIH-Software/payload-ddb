import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'

import { DeleteCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'

import type { DynamoAdapter } from '../types.js'

import { normalizeForDynamo } from './normalizeForDynamo.js'
import { stripInternalKeys } from './stripInternalKeys.js'

/**
 * The single place the adapter's methods mutate the table. Every `create*`,
 * `update*`, `upsert` and `delete*` method hands its finished document (or
 * the id to remove) to one of the helpers below instead of building its own
 * DynamoDB command.
 *
 * Keeping writes behind one module means the row's physical shape — the
 * `pk`/`sk` composite key, value normalization, and any future index
 * attributes — is derived in exactly one spot (`toItem`), and anything that
 * needs to see every mutation (e.g. buffering writes for a Payload-level
 * transaction) has one seam to hook into.
 *
 * Callers stay responsible for everything Payload-shaped: locating the
 * target, merging the patch, defaulting timestamps, and projecting against
 * the collection/global schema. These helpers only persist what they're
 * given.
 *
 * Not routed through here: `scrubUnknownFields`, a one-shot maintenance pass
 * that re-puts raw rows at their original keys without normalizing them.
 */

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
 * plus the internal key attributes, keyed by the document's own `id`.
 * The inverse of `stripInternalKeys`.
 */
function toItem(partition: string, doc: Record<string, unknown>): Record<string, unknown> {
  return normalizeForDynamo({ ...doc, ...keyFor(partition, doc['id']) })
}

/**
 * Write `doc` as the full row at (`partition`, `doc.id`), replacing whatever
 * is there. The adapter's update paths are read-merge-write, so this is the
 * write half of both inserts and updates.
 *
 * With `mustNotExist`, the write only lands if no row occupies that key yet;
 * otherwise DynamoDB rejects it and the SDK throws (see
 * `isConditionalCheckFailed`). Inserts use this so a colliding id can't
 * silently replace someone else's document.
 */
export async function putItem(
  adapter: DynamoAdapter,
  partition: string,
  doc: Record<string, unknown>,
  options: { mustNotExist?: boolean } = {},
): Promise<void> {
  const docClient = requireDocClient(adapter)

  await docClient.send(
    new PutCommand({
      TableName: adapter.tableName,
      Item: toItem(partition, doc),
      // Every row carries `pk`, so "no `pk` attribute" means "no row here".
      ...(options.mustNotExist ? { ConditionExpression: 'attribute_not_exists(pk)' } : {}),
    }),
  )
}

/**
 * True when `err` is DynamoDB refusing a write because its condition didn't
 * hold — e.g. a `putItem` with `mustNotExist` hitting an occupied key.
 */
export function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === 'ConditionalCheckFailedException'
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
  options: { returnOld?: boolean } = {},
): Promise<null | Record<string, unknown>> {
  const docClient = requireDocClient(adapter)

  const result = await docClient.send(
    new DeleteCommand({
      TableName: adapter.tableName,
      Key: keyFor(partition, id),
      ...(options.returnOld ? { ReturnValues: 'ALL_OLD' as const } : {}),
    }),
  )

  return options.returnOld && result.Attributes ? stripInternalKeys(result.Attributes) : null
}

/**
 * Delete several rows from one partition in parallel, one `DeleteItem` each.
 *
 * `BatchWriteItem` could cut the request count (25 deletes per call) but has
 * partial-failure semantics that need retry logic — out of scope until we
 * wire up retries. Parallel single deletes are simple and correct.
 */
export async function deleteItems(
  adapter: DynamoAdapter,
  partition: string,
  ids: unknown[],
): Promise<void> {
  await Promise.all(ids.map((id) => deleteItem(adapter, partition, id)))
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
        UpdateExpression: 'SET #latest = :false',
        ExpressionAttributeNames: { '#latest': 'latest' },
        ExpressionAttributeValues: { ':false': false },
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
      Item: toItem(partition, doc),
    },
  })

  await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }))
}
