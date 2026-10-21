import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertNever } from "./index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  dependencies?: Record<string, string>;
};

describe("@agentify/core", () => {
  it("stops the work on an unhandled variant and names it", () => {
    // The value arrives from the database, which the case analysis knows
    // nothing about. The promise is a visible refusal rather than carrying on
    // with an order nobody handled.
    const fromDatabase = "fulfillment_closed" as never;

    expect(() => assertNever(fromDatabase, "order status")).toThrowError(/order status/);
    expect(() => assertNever(fromDatabase, "order status")).toThrowError(/fulfillment_closed/);
  });

  it("drags in not a single runtime dependency", () => {
    // The core runs in a test, a script or someone else's environment without
    // installing anything.
    expect(manifest.dependencies ?? {}).toStrictEqual({});
  });
});
