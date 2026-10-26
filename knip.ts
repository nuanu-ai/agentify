/**
 * `pnpm deadcode`: what nothing uses, in every workspace package.
 *
 * It reports a file no entry point reaches, stylesheets included; an export or
 * an exported type no other module imports, and a value exported under two
 * names; a dependency a package declares and never imports, an import of a
 * package it does not declare, and a command its scripts run that nothing
 * installs. An entry point is what something outside the code starts: a
 * `package.json` script, a CI step, a test, a framework's convention (React
 * Router reads each application's `app/routes.ts`), a package's `exports`, and
 * the few files named below, each with what starts it. What a private
 * package's `exports` pass on is held too: another package must import it.
 *
 * It leaves alone, by design: what the two published packages, the SDK and the
 * contracts, pass on, which is their API for merchants outside this
 * repository; what the six scanner packages pass on, because another package's
 * import of one resolves to its build wherever the build exists, so whether
 * it is read would depend on what was built last (an export inside one of
 * their modules is still held to its package's entry); the exports of a route
 * module and of a script a command runs, which a framework or a command reads
 * by name rather than by an import; an export only tests import, because a
 * test is an entry point too, so whether that test guards a promise anyone
 * relies on is for review; class names, since a selector is not an import;
 * shell, Python and Markdown, which it does not read; and `docs/`.
 */

import type { KnipConfig } from "knip";

/** The scanner packages, built before anything imports them; their exports are not held. */
const SCANNER_PACKAGES = [
  "packages/analytics",
  "packages/observability",
  "packages/remediation",
  "packages/scanner",
  "packages/scanner-contracts",
  "packages/scanner-database",
];

/** The packages npm publishes, whose exports are the API merchants integrate against. */
const PUBLISHED_PACKAGES = ["packages/contracts", "packages/sdk"];

export default {
  includeEntryExports: true,
  // Stryker reads its test configuration's default export from the path
  // `scripts/mutate.mjs` gives it. Knip reads this setting for the root's
  // files only here, not under the root's workspace below.
  ignoreIssues: { "scripts/stryker.vitest.config.ts": ["exports"] },
  // A stylesheet's `@import` read as an import, so a package a stylesheet
  // pulls in counts as used and a stylesheet nothing imports is reported.
  compilers: {
    css: (text: string) => [...text.matchAll(/(?<=@)import[^;]+/g)].join("\n"),
  },
  workspaces: {
    ".": {
      entry: [
        // The mutation runner's test configuration, handed to Stryker by
        // path in `scripts/mutate.mjs`.
        "scripts/stryker.vitest.config.ts",
        // Run by root scripts through `ops/scripts/with-env.mjs`, which knip
        // follows no further than the wrapper.
        "ops/scripts/golden-corpus.mjs",
        "ops/scripts/load-scan.mjs",
        // Run by hand, as its header says, since it starts Docker containers.
        "ops/scripts/caddy-routing-smoke.mjs",
      ],
      // `docs/` holds the record of measurements, not code anything runs.
      project: ["**", "!docs/**"],
      // Stryker loads its test runner by the name `scripts/mutate.mjs`
      // passes it, never by an import.
      ignoreDependencies: ["@stryker-mutator/vitest-runner"],
    },
    "apps/web": {
      entry: [
        // The server half of the build (`vite.config.ts`), which `server.js`
        // starts and the budget and the browser test load.
        "server/app.ts",
        // Drawn into the screens gallery by `packages/gallery`.
        "app/gallery.tsx",
      ],
      // What the server half exports is read out of the build, `dist/server`,
      // by `server.js`, the budget and the browser test.
      ignoreIssues: { "server/app.ts": ["exports"] },
    },
    "apps/dashboard": {
      entry: [
        // Drawn into the screens gallery by `packages/gallery`.
        "app/gallery.tsx",
      ],
    },
    "apps/docs": {
      entry: [
        // Drawn into the screens gallery by `packages/gallery`.
        "app/gallery.tsx",
      ],
      // A reader's program, which a page shows and a test in `packages/slice`
      // runs with that package's dependencies, as the reader runs it with
      // theirs: nothing in this application imports it.
      ignore: ["programs/**"],
    },
    "packages/core": {
      // The types of `preflight.mjs`, which a deploy script runs as it is;
      // its readers import the function from the `.mjs` beside it.
      ignoreIssues: { "src/deployment/preflight.d.mts": ["exports", "types"] },
    },
    "packages/slice": {
      entry: [
        // Read as text by `src/wallet-faults-command.ts` and served to the
        // browser it opens as the stand-in for Coinbase Wallet's window.
        "src/wallet-window.js",
      ],
    },
    "packages/gallery": {
      entry: [
        // Read as text and written into the gallery's page by `src/main.ts`.
        "src/chrome.js",
        "src/chrome.css",
      ],
    },
    ...Object.fromEntries(
      [...SCANNER_PACKAGES, ...PUBLISHED_PACKAGES].map((path) => [
        path,
        { includeEntryExports: false },
      ]),
    ),
  },
} satisfies KnipConfig;
