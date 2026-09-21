/**
 * The workspace's vitest config, as Stryker has to see it from its sandbox.
 *
 * Stryker copies the checkout into a sandbox directory, mutates the copies and
 * runs vitest there, so that the working tree is never touched. Inside the
 * sandbox every `node_modules` is a symlink back to the real one, and under
 * pnpm a workspace package is itself a symlink inside `node_modules`:
 * `apps/gateway/node_modules/@agentify/commerce-core` points at `../../../packages/core`
 * of the real checkout, not of the sandbox. Left alone, every test outside
 * `packages/core` would import the unmutated core and kill nothing, and the
 * test that killed a mutant the spike named (`packages/slice/src/stand.test.ts`)
 * would not even count as related to it.
 *
 * So this file takes the workspace config as it is and adds one thing: an
 * alias for every workspace package, built from its `exports` map, pointing
 * at the copy inside the sandbox. A package is a directory under `packages/`
 * or `apps/` that holds a `package.json`, the definition `scripts/mutate.mjs`
 * uses at its door; a stray file beside the packages is not one. This file is
 * loaded only by `scripts/mutate.mjs`; `pnpm test` keeps reading
 * `vitest.config.ts` and never sees it.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";
import commerce from "../vitest.config.js";
import scanner from "../vitest.scanner.config.js";

const root = path.resolve(import.meta.dirname, "..");
const packageDir = process.env.AGENTIFY_MUTATION_PACKAGE_DIR;
const family = process.env.AGENTIFY_MUTATION_FAMILY;

if (!packageDir || !["commerce", "scanner"].includes(family ?? "")) {
  throw new Error("mutation_target_not_configured");
}

const exact = (specifier: string): RegExp =>
  new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`);

interface ExportConditions {
  [condition: string]: string | ExportConditions | undefined;
}

type ExportTarget = string | ExportConditions;

const sourceTarget = (target: ExportTarget): string | undefined => {
  if (typeof target === "string") return target;
  for (const condition of ["types", "source", "import", "default"]) {
    const candidate = target[condition];
    if (candidate) {
      const resolved = sourceTarget(candidate);
      if (resolved) return resolved;
    }
  }
  return undefined;
};

const alias = ["packages", "apps"].flatMap((group) =>
  readdirSync(path.join(root, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, group, entry.name))
    .filter((dir) => existsSync(path.join(dir, "package.json")))
    .flatMap((dir) => {
      const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
        name: string;
        exports?: Record<string, ExportTarget>;
      };
      return Object.entries(manifest.exports ?? {}).flatMap(([subpath, target]) => {
        const source = sourceTarget(target);
        return source
          ? [
              {
                find: exact(path.posix.join(manifest.name, subpath)),
                replacement: path.join(dir, source),
              },
            ]
          : [];
      });
    }),
);

const targetRoot = path.join(root, packageDir);
const scannerTarget = defineConfig({
  root: targetRoot,
  // Next keeps JSX for its own compiler. The mutation runner uses plain Vite,
  // so its sandbox has to lower TSX before Vite's import analysis sees it.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    include: ["**/*.test.ts", "**/*.spec.ts", "**/*.test.tsx", "**/*.spec.tsx"],
    exclude: [
      "**/node_modules/**",
      "**/actor.integration.test.ts",
      "**/analytics-outbox.integration.test.ts",
      "**/migrations.integration.test.ts",
      "**/p4.integration.test.ts",
      "**/p5.integration.test.ts",
    ],
  },
});

export default mergeConfig(
  family === "commerce" ? commerce : scanner,
  defineConfig({
    ...(family === "scanner" ? scannerTarget : {}),
    resolve: { alias },
  }),
);
