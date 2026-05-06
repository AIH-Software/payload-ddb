import { DeleteTableCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb'

/**
 * Drop a table from DynamoDB Local. Used by suite cleanup so parallel workers
 * don't leak tables across runs. Swallows ResourceNotFoundException because
 * tests sometimes drop the table themselves and we don't want cleanup to
 * fail in that case.
 */
export async function deleteTable(client: DynamoDBClient, tableName: string): Promise<void> {
  try {
    await client.send(new DeleteTableCommand({ TableName: tableName }))
  } catch (err) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') return
    throw err
  }
}
