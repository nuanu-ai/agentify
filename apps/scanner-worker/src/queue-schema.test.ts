import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * The scanner's queue and the gateway's orders share one `pgboss` schema, and
 * each pg-boss client migrates it to its own version when it starts; a client
 * built for an older version then runs, with no warning, on tables a newer one
 * has changed. So the worker, the web application that enqueues scans and the
 * gateway must resolve a pg-boss that expects the same schema version.
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
