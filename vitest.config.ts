import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig, type ViteUserConfig } from "vitest/config";

/**
 * One config for the whole workspace: tests sit next to the code they cover,
 * in `apps/*` and `packages/*` alike, and one command runs all of them.
 *
 * `pnpm test` must be free, deterministic and work without the network.
 * Everything that touches the chain, the facilitator, a merchant's live API or
 * a database lives in a separate command and does not get in here. The five
 * `*.integration.test.ts` files are those, and they are excluded by name.
 *
 * That was a sentence until a pair of tests quietly called a validation
 * endpoint on every run and went green either way. `vitest.setup.ts` is the
 * same sentence with teeth: a request to anywhere but this process fails the
 * test that made it, and loopback — a server a suite stands up in this
 * process — is what stays allowed.
 *
 * The timeouts are the ones `vitest.db.config.ts` uses, for the same reason.
 * A per-test timeout is a hang detector, not an assertion, and vitest's
 * default of five seconds is short enough that a loaded machine fails tests
 * nobody broke: the ones that stand up a loopback server or wait on a
 * deadline. Measured on an idle machine, the old hundred-and-thirteen-file
 * pool went red one run in four and this one three in four, always that class,
 * and the runner CI gives us has four cores. Thirty seconds detects a hang
 * just as well and reports only hangs.
 */

type TestOptions = NonNullable<ViteUserConfig["test"]>;

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * The scanner's packages publish what they build, and the images run those
 * files. A test run builds nothing, so every import of one is answered by the
 * source beside it instead of by a `dist` that may be a day old.
 */
const scannerSources = [
  ["@agentify/scanner-contracts", "./packages/scanner-contracts/src/index.ts"],
  [
    "@agentify/scanner-contracts/report-identity",
    "./packages/scanner-contracts/src/report-identity.ts",
  ],
  [
    "@agentify/scanner-contracts/report-cabinet-handoff",
    "./packages/scanner-contracts/src/report-cabinet-handoff.ts",
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
 * What both projects share. The setup file is named absolutely because the
 * mutation runner reads this config with the package under test as its root,
 * and a relative path would be looked for inside that package.
 */
const shared: TestOptions = {
  environment: "node",
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

/** The five that own a database, a browser or both. */
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
 * The JSX transform. Next compiles with the automatic runtime and `apps/web`
 * says `preserve` in its tsconfig because Next asks for it; left alone, the
 * test transform would read that and hand the runner untransformed JSX.
 */
export const jsxRuntime: NonNullable<ViteUserConfig["oxc"]> = {
  jsx: { runtime: "automatic", importSource: "react" },
};

export default defineConfig({
  resolve: { alias: scannerSourceAlias },
  oxc: jsxRuntime,
  test: {
    // Two projects rather than two configs. `pnpm test` runs the first; the
    // commands that own a database or a browser name the second, because a
    // file the configuration does not collect cannot be run by naming it.
    projects: [
      { extends: true, test: unitTests },
      { extends: true, test: integrationTests },
    ],
  },
});
