import { type DynamoDBClient } from '@aws-sdk/client-dynamodb';
/**
 * Drop a table from DynamoDB Local. Used by suite cleanup so parallel workers
 * don't leak tables across runs. Swallows ResourceNotFoundException because
 * tests sometimes drop the table themselves and we don't want cleanup to
 * fail in that case.
 */
export declare function deleteTable(client: DynamoDBClient, tableName: string): Promise<void>;
//# sourceMappingURL=deleteTable.d.ts.map