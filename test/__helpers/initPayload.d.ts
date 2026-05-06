import type { Config, Payload } from 'payload';
export type TestHandle = {
    payload: Payload;
    tableName: string;
    /** Tear down: destroy payload (drops the AWS clients) then drop the table. */
    cleanup: () => Promise<void>;
};
/**
 * Boot a Payload instance against DynamoDB Local with a unique table name.
 * Returns a `cleanup` that should be called from `afterAll` so the suite
 * leaves no tables behind in the shared dev DB.
 *
 * The `suite` arg only seeds the table name (`payload-test-<suite>-<rand>`)
 * — purely a debugging convenience when listing tables.
 */
export declare function initPayloadTest(suite: string, testConfig: Partial<Config>): Promise<TestHandle>;
//# sourceMappingURL=initPayload.d.ts.map