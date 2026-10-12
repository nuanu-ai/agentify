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

  it("names published paths its own source can produce", () => {
    // The build compiles `src` into `dist`, so `./dist/index.js` can only come
    // from `./src/index.ts`; a renamed entry would promise a file the build
    // never writes.
    const published = Object.values(manifest.publishConfig?.exports ?? {}).flatMap((entry) =>
      [entry.types, entry.default].filter((path) => path !== undefined),
    );

    expect(published.length).toBeGreaterThan(0);

    for (const path of published) {
      const source = path.replace(/^\.\/dist\//, "./src/").replace(/\.d\.ts$|\.js$/, ".ts");

      expect(existsSync(new URL(`../${source}`, import.meta.url))).toBe(true);
    }
  });

  it("carries what npm needs to publish it, and builds before it is packed", () => {
    // Without `prepack`, packing a tree with no `dist` silently produces a
    // tarball holding only this manifest.
    expect(manifest.name).toBe("@nuanu-ai/agentify-contracts");
    expect(manifest.private).toBeUndefined();
    expect(manifest.version).not.toBe("0.0.0");
    expect(manifest.files).toStrictEqual(["dist", "LICENSE", "NOTICE"]);
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.repository).toBeDefined();
    expect(manifest.engines?.node).toBeDefined();
    // Defined is not enough: it has to be the build.
    expect(manifest.scripts?.prepack).toBe("pnpm run build");
    expect(manifest.publishConfig?.access).toBe("public");
    expect(existsSync(new URL("../README.md", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../LICENSE", import.meta.url))).toBe(true);
    expect(readFileSync(new URL("../NOTICE", import.meta.url), "utf8")).toContain("Nuanu AI");
  });
});
