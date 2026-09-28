import { readFileSync } from "node:fs";
import { BROWSER_OBSERVATION_VERSION } from "@agentify/scanner-contracts";
import { describe, expect, it } from "vitest";

const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

describe("the Actor's Apify metadata", () => {
  it("names the contract version the worker sends", () => {
    // Apify validates a run's input against this schema before the Actor
    // starts, so a version it does not list refuses every run the worker pays
    // for; the build tag is what a deployment names the build by.
    const input = json("../.actor/input_schema.json");
    expect(input.properties.schema_version.enum).toEqual([BROWSER_OBSERVATION_VERSION]);
    expect(input.properties.schema_version.default).toBe(BROWSER_OBSERVATION_VERSION);
    expect(json("../../../.actor/actor.json").buildTag).toBe(BROWSER_OBSERVATION_VERSION);
  });
});
