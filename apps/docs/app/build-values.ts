/**
 * What a page names that the build knows and no deployment decides: the
 * release of `@nuanu-ai/agentify` the pages describe, read from the package
 * in this repository when the documentation is built. A writer names it as
 * `{{sdk-version}}`, and it is written into the page, its Markdown and the
 * search index alike, code blocks included, before anything else reads the
 * source. A name this does not know is left for the site values, which stop
 * the build on a name they do not know either.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP } from "./where.server.js";

const sdk = JSON.parse(
  readFileSync(join(APP, "..", "..", "packages", "sdk", "package.json"), "utf8"),
) as { version: string };

const BUILD_VALUES: Readonly<Record<string, string>> = { "sdk-version": sdk.version };

/** A page's source with every value the build knows written in. */
export const withBuildValues = (source: string): string =>
  source.replace(/\{\{([a-z-]+)\}\}/g, (whole, name: string) => BUILD_VALUES[name] ?? whole);
