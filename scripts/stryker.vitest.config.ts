/**
 * The workspace's vitest config as Stryker has to see it from its sandbox.
 * Only `scripts/mutate.mjs` loads it.
 *
 * Inside the sandbox every `node_modules` is a symlink to the real one, and
 * under pnpm a workspace package is itself a symlink there:
 * `apps/gateway/node_modules/@agentify/core` points at the real checkout's
 * `packages/core`, not the sandbox's. Left alone, every test outside the
 * mutated package would import unmutated code and kill nothing.
 *
 * So this takes the unit project's settings and adds an alias for every
 * workspace package, built from its `exports` map, pointing into the sandbox.
 * The settings are imported by name: merging the default export would bring
 * the workspace's own alias, which points at the real checkout, and vite takes
 * the first match. A package is a directory under `packages/` or `apps/` that
 * holds a `package.json`, as in `scripts/mutate.mjs`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";
import { unitTests } from "../vitest.config.js";

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
// A scanner package is mutated against its own tests rather than the whole
// workspace pool.
const scannerTarget = defineConfig({
  root: targetRoot,
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
  defineConfig({ test: unitTests }),
  defineConfig({
    ...(family === "scanner" ? scannerTarget : {}),
    resolve: { alias },
  }),
);
