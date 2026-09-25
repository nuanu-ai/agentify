import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * The scanner's queue and the gateway's orders live in one `pgboss` schema of
 * the one database, and each pg-boss client migrates that schema up to the
 * version it was built for when it starts. A client built for an older
 * version runs on tables a newer one has changed under it, and nothing says
 * so. So every process on the schema resolves a pg-boss that expects the same
 * schema version: the worker here, the web application that enqueues scans,
 * and the gateway.
 */
const schemaVersionFor = (packageJson: string): number =>
  createRequire(new URL(packageJson, import.meta.url))("pg-boss/package.json").pgboss.schema;

describe("the queue schema the scanner shares with the gateway", () => {
  it("is the version every process on it was built for", () => {
    const gateway = schemaVersionFor("../../gateway/package.json");
    expect(schemaVersionFor("../package.json")).toBe(gateway);
    expect(schemaVersionFor("../../web/package.json")).toBe(gateway);
  });
});
