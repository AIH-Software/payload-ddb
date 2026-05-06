/**
 * Verify the docker-hosted DynamoDB Local accepts TCP connections. Prints a
 * friendly start-the-container message and exits non-zero when unreachable.
 * Mirrors Payload's own `assertDbReachable` so the failure mode is familiar.
 */
export declare function assertDbReachable(): Promise<void>;
export declare const TEST_DDB_HOST: string;
export declare const TEST_DDB_PORT: number;
export declare const TEST_DDB_ENDPOINT: string;
//# sourceMappingURL=assertDbReachable.d.ts.map