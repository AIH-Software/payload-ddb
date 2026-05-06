import type { Config, SanitizedConfig } from 'payload';
/**
 * Build a sanitized payload config wired to DynamoDB Local with `ensureTables`
 * enabled, so each suite can boot against a freshly-provisioned table without
 * any external setup. Mirrors the shape of payload's own
 * `test/buildConfigWithDefaults.ts` — caller passes a partial config and we
 * fill in the adapter, secret, and other test-environment defaults.
 */
export declare function buildConfigWithDefaults(testConfig: Partial<Config>, options: {
    tableName: string;
}): Promise<SanitizedConfig>;
//# sourceMappingURL=buildConfigWithDefaults.d.ts.map