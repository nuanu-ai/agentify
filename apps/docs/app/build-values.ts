/**
 * What a page names that the build knows and no deployment decides: the
 * release of `@nuanu-ai/agentify` the pages describe, read from the package
 * in this repository when the documentation is built, named `{{sdk-version}}`;
 * and a parcel's purchase with the example address the contract's own schema
 * publishes, named `{{parcel-purchase}}`. Each is written into the page, its
 * Markdown and the search index alike, code blocks included, before anything
 * else reads the source. A name this does not know is left for the site values, which stop
 * the build on a name they do not know either.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ShipToSchema } from "@nuanu-ai/agentify-contracts";
import { APP } from "./where.server.js";

const sdk = JSON.parse(
  readFileSync(join(APP, "..", "..", "packages", "sdk", "package.json"), "utf8"),
) as { version: string };

const [address] = (ShipToSchema.meta()?.examples as readonly unknown[] | undefined) ?? [];
if (address === undefined) throw new Error("the contract's address schema publishes no example");

const BUILD_VALUES: Readonly<Record<string, string>> = {
  "sdk-version": sdk.version,
  "parcel-purchase": JSON.stringify({ params: {}, ship_to: address }, null, 2),
};

/** A page's source with every value the build knows written in. */
export const withBuildValues = (source: string): string =>
  source.replace(/\{\{([a-z-]+)\}\}/g, (whole, name: string) => BUILD_VALUES[name] ?? whole);
