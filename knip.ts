/**
 * `pnpm deadcode`: what nothing uses, across every workspace package.
 *
 * It checks files that no entry point reaches, scripts and stylesheets
 * included; exports and exported types that no other module imports, and a
 * value exported under two names; dependencies a package declares and never
 * imports, imports of packages it does not declare, and commands its scripts
 * run that nothing installs. An entry point is what something outside the
 * code starts: a `package.json` script, a CI step, a test, a framework's own
 * convention (React Router reads each application's `app/routes.ts`), the
 * `exports` a package publishes, and the few files named below, each with
 * what starts it.
 *
 * It leaves alone, by design: the exports of an entry point, which are its
 * surface (the published SDK's and contracts' API, a route module's loader);
 * an export only tests import, because a test is an entry point too, so
 * whether that test guards a promise anyone relies on is for review; class
 * names, since a stylesheet's selector is not an import; shell, Python and
 * Markdown, which it does not read; and `docs/`, whose scripts are the record
 * of a measurement, not code anything runs.
 */

import type { KnipConfig } from "knip";

export default {
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
      ],
      project: ["*.ts", "scripts/**", "ops/**", "fixtures/**"],
      vitest: { config: ["vitest.config.ts", "vitest.db.config.ts"] },
    },
    "apps/web": {
      entry: [
        // The server half of the build (`vite.config.ts`), which `server.js`
        // starts and the budget and the browser test load.
        "server/app.ts",
        // Drawn into the screens gallery by `packages/gallery`.
        "app/gallery.tsx",
      ],
    },
    "apps/dashboard": {
      entry: [
        // Drawn into the screens gallery by `packages/gallery`.
        "app/gallery.tsx",
      ],
    },
    "packages/gallery": {
      entry: [
        // Read as text and written into the gallery's page by `src/main.ts`.
        "src/chrome.js",
        "src/chrome.css",
      ],
    },
  },
} satisfies KnipConfig;
