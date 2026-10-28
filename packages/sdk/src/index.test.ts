import { existsSync, readFileSync } from "node:fs";
import { CONTRACT_VERSION } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import * as sdk from "./index.js";
import { contractVersion, speaksContract } from "./index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name?: string;
  version?: string;
  private?: boolean;
  files?: readonly string[];
  license?: string;
  repository?: unknown;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  publishConfig?: {
    access?: string;
    bin?: Record<string, string>;
    exports?: Record<string, { types?: string; default?: string }>;
  };
};

describe("@nuanu-ai/agentify", () => {
  it("checks the contract version and refuses a foreign one", () => {
    // The promise: a contract version mismatch is found at worker startup, not
    // on an order, where it costs the buyer money.
    expect(contractVersion).toBe(CONTRACT_VERSION);
    expect(speaksContract(CONTRACT_VERSION)).toBe(true);
    expect(speaksContract(`${CONTRACT_VERSION}-foreign`)).toBe(false);
  });

  it("hands a merchant this much surface and no more", () => {
    // Every name here is something a merchant has to learn and the package has
    // to keep, so this list is the public surface, written down. Runtime
    // exports only; the types are held by the compiler, through
    // `portal-fences.test.ts` and the `pnpm outside` type check.
    expect(Object.keys(sdk).sort()).toStrictEqual([
      "ANSWER_NOT_UNDERSTOOD",
      "AgentifyError",
      "CALL_DID_NOT_REACH_US",
      "CARD_REJECTED",
      // The findings a refused publish names about the merchant rather than
      // the card, typed for the code that compares against them.
      "MERCHANT_FINDINGS",
      "ORDER_EVENT_TYPES",
      "OUTCOME_UNKNOWN",
      "RECOMMENDED_REFUSAL_CODES",
      "WORKER_PROBLEM_KINDS",
      "checkCard",
      "contractVersion",
      "createClient",
      "speaksContract",
    ]);
  });

  it("declares no third-party dependency of its own", () => {
    // The tree a merchant gets is `@nuanu-ai/agentify-contracts` and `zod`,
    // nothing else. This is one half; the contracts package's test holds it to
    // zod alone.
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@nuanu-ai/agentify-contracts"]);
  });

  it("advertises the command the documentation tells a merchant to run", () => {
    // The promise: `agentify verify` starts. npx finds a command through this
    // field, and it must point at the built command, which Node can run.
    expect(manifest.publishConfig?.bin).toStrictEqual({ agentify: "./dist/cli.js" });
  });

  it("publishes its build and develops against its source", () => {
    // Outside this repository the entry point must be compiled JavaScript with
    // types; inside it, imports read `src` directly. pnpm swaps in
    // `publishConfig` when it packs.
    expect(manifest.exports).toStrictEqual({ ".": "./src/index.ts" });
    expect(manifest.publishConfig?.exports).toStrictEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    });
  });

  it("carries what npm needs to publish it, and builds before it is packed", () => {
    // `files` keeps the tests, fixtures and fake gateway out of a merchant's
    // production. Without `prepack`, packing a tree with no `dist` silently
    // produces a tarball holding only this manifest.
    expect(manifest.name).toBe("@nuanu-ai/agentify");
    expect(manifest.private).toBeUndefined();
    expect(manifest.version).toMatch(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
    expect(manifest.version).not.toBe("0.0.0");
    expect(manifest.files).toStrictEqual(["dist", "LICENSE", "NOTICE"]);
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.repository).toMatchObject({
      type: "git",
      url: "git+https://github.com/nuanu-ai/agentify.git",
    });
    expect(manifest.engines?.node).toMatch(/^>=\d+(?:\.\d+){0,2}$/);
    expect(Number(manifest.engines?.node?.match(/^>=(\d+)/)?.[1])).toBeGreaterThanOrEqual(24);
    // Actual prepack output and imports are exercised by `pnpm outside`.
    expect(manifest.publishConfig?.access).toBe("public");
    expect(existsSync(new URL("../README.md", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../LICENSE", import.meta.url))).toBe(true);
    expect(readFileSync(new URL("../NOTICE", import.meta.url), "utf8")).toContain("Nuanu AI");
  });
});
