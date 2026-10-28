/**
 * What this package promises the npm registry, checked without a build. A
 * merchant who installs the SDK installs this package too, so its manifest is
 * part of what they receive.
 *
 * The field that matters most is `files`: without it npm ships the whole
 * directory, and `src/testing/expect-schema.ts` imports vitest, which would put
 * a runtime import of an uninstalled package into a merchant's production.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name?: string;
  version?: string;
  private?: boolean;
  files?: readonly string[];
  license?: string;
  repository?: unknown;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  exports?: Record<string, unknown>;
  publishConfig?: {
    access?: string;
    exports?: Record<string, { types?: string; default?: string }>;
  };
};

describe("@nuanu-ai/agentify-contracts as a published package", () => {
  it("publishes its build and develops against its source", () => {
    // Inside this repository imports read `src` directly; outside it, a
    // merchant's Node cannot run TypeScript. pnpm swaps in `publishConfig` when
    // it packs.
    expect(manifest.exports).toStrictEqual({ ".": "./src/index.ts" });
    expect(manifest.publishConfig?.exports).toStrictEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
    });
  });

  it("carries what npm needs to publish it, and builds before it is packed", () => {
    // Without `prepack`, packing a tree with no `dist` silently produces a
    // tarball holding only this manifest.
    expect(manifest.name).toBe("@nuanu-ai/agentify-contracts");
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
