import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig, type ViteUserConfig } from "vitest/config";

/**
 * `pnpm test` must be free, deterministic and work without the network.
 * Everything that touches the chain, the facilitator, a merchant's live API or
 * a database lives in a separate command; the `*.integration.test.ts` files
 * are those, excluded by name. `vitest.setup.ts` enforces it for `fetch` only:
 * a `fetch` to anywhere but loopback fails the test that made it, while a raw
 * socket, an `http` agent or a database driver is not intercepted.
 *
 * A per-test timeout is a hang detector, not an assertion. Vitest's default of
 * five seconds fails tests nobody broke on a loaded machine (those that stand
 * up a loopback server or wait on a deadline); thirty seconds detects a hang
 * just as well.
 */

type TestOptions = NonNullable<ViteUserConfig["test"]>;

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * The scanner's packages resolve to their built `dist`, which a test run does
 * not build, so tests import their source instead of possibly stale output.
 */
const scannerSources = [
  ["@agentify/scanner-contracts", "./packages/scanner-contracts/src/index.ts"],
  ["@agentify/scanner-contracts/browser", "./packages/scanner-contracts/src/browser.ts"],
  [
    "@agentify/scanner-contracts/report-identity",
    "./packages/scanner-contracts/src/report-identity.ts",
  ],
  ["@agentify/scanner-database", "./packages/scanner-database/src/index.ts"],
  ["@agentify/scanner-database/schema", "./packages/scanner-database/src/schema.ts"],
  ["@agentify/analytics", "./packages/analytics/src/index.ts"],
  ["@agentify/analytics/browser", "./packages/analytics/src/browser-entry.ts"],
  ["@agentify/observability", "./packages/observability/src/index.ts"],
  ["@agentify/scanner", "./packages/scanner/src/index.ts"],
  ["@agentify/remediation", "./packages/remediation/src/index.ts"],
] as const;

/**
 * The setup file is named absolutely because the mutation runner reads this
 * config with the package under test as its root.
 *
 * From Node 25 the runtime has its own `localStorage`, which in a jsdom suite
 * shadows jsdom's without its methods. The flag removes it, so a machine newer
 * than `.nvmrc` behaves like CI.
 */
const shared: TestOptions = {
  environment: "node",
  execArgv: ["--no-experimental-webstorage"],
  setupFiles: [source("./vitest.setup.ts")],
  passWithNoTests: false,
  testTimeout: 30_000,
  hookTimeout: 60_000,
};

/** The offline suite: `pnpm test`, and the pool a mutation run draws from. */
export const unitTests: TestOptions = {
  ...shared,
  name: "unit",
  include: [
    "apps/*/**/*.test.ts",
    "apps/*/**/*.test.tsx",
    "packages/*/**/*.test.ts",
    "packages/*/**/*.test.tsx",
  ],
  exclude: [...configDefaults.exclude, "**/.next/**", "**/*.integration.test.ts"],
};

/** The ones that own a database, a browser, a built server or more than one. */
const integrationTests: TestOptions = {
  ...shared,
  name: "integration",
  include: ["apps/*/**/*.integration.test.ts", "packages/*/**/*.integration.test.ts"],
  exclude: [...configDefaults.exclude, "**/.next/**"],
};

export const scannerSourceAlias = scannerSources.map(([specifier, path]) => ({
  find: new RegExp(`^${specifier.replaceAll("/", "\\/")}$`),
  replacement: source(path),
}));

/**
 * `apps/web` says `preserve` in its tsconfig because Next asks for it; left
 * alone, the test transform would read that and hand the runner untransformed
 * JSX.
 */
export const jsxRuntime: NonNullable<ViteUserConfig["oxc"]> = {
  jsx: { runtime: "automatic", importSource: "react" },
};

export default defineConfig({
  resolve: { alias: scannerSourceAlias },
  oxc: jsxRuntime,
  test: {
    // Two projects rather than two configs: a file the configuration does not
    // collect cannot be run by naming it, so the integration commands name
    // the second project.
    projects: [
      { extends: true, test: unitTests },
      { extends: true, test: integrationTests },
    ],
  },
});
