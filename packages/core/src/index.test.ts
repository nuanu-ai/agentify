import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as core from "./index.js";
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

  it("hands its consumers everything they need, and nothing more", () => {
    // An equality rather than a loop of `typeof`. A missing name means a
    // consumer reaches into the package's internals; an extra one is a function
    // nobody outside calls, which is surface a stranger's engineer must now
    // read.
    const called = [
      "createOrder",
      "transition",
      "deadlines",
      // Read by the gateway when it decides whether another delivery attempt
      // could still land in time.
      "fulfillmentDeadline",
      "outcomeFor",
      // Why an order ended where its merchant did not say: the gateway writes
      // it into the agent's status.
      "endingReasonFor",
      // The merchant's open list is narrower than the machine's open states.
      "onTheMerchantsOpenList",
      "moneyInvariantViolations",
      "modeOf",
      "isOpen",
      // Whether a parcel's order still holds its buyer's address: the gateway's
      // last check before it writes one down.
      "holdsShipTo",
      "assertNever",
      // What a merchant must have before their cards are sold: asked by the
      // gateway's publish door and sale-time check and by the dashboard.
      "readinessOf",
      // What a deployment is: read by the configuration of the gateway and
      // the dashboard, by the keys they issue, and by the slice's smoke
      // commands.
      "isSandboxFacilitator",
      "isTestnetChain",
      "environmentOf",
      "surfaceModeOf",
      "keyPrefixFor",
      "environmentOfKeyPrefix",
    ];
    const exported = Object.entries(core)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);

    expect(exported.sort()).toStrictEqual([...called].sort());
  });

  it("keeps its own test fixtures to itself", () => {
    // An order is built out of a real purchase. A builder that quietly guesses
    // its defaults belongs in the tests and nowhere near the gateway.
    for (const name of ["newOrder", "createInput", "reach", "walk", "must", "TEST_POLICY"]) {
      expect((core as Record<string, unknown>)[name], name).toBeUndefined();
    }
  });
});
