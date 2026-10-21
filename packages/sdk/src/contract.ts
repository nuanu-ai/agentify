/**
 * Which contract this package speaks, and whether it understands another. The
 * worker checks the version on the answer to every poll, and the package
 * exports the same check to a merchant who wants to make it themselves. Also
 * which release of the package this is, which every call names to the gateway.
 */

import { readFileSync } from "node:fs";
import { CONTRACT_VERSION } from "@nuanu-ai/agentify-contracts";

/** The contract version this SDK talks in. */
export const contractVersion = CONTRACT_VERSION;

/**
 * Whether this SDK understands a contract of the given version. The gateway
 * names its version in its answers; the worker checks it with this function
 * and stops at startup rather than on the first order, where a mismatch would
 * cost the buyer money.
 */
export function speaksContract(version: string): boolean {
  return version === CONTRACT_VERSION;
}

/** The name this package is published under, as its manifest writes it. */
const PACKAGE_NAME = "@nuanu-ai/agentify";

/**
 * The release a manifest names, if it is this package's own. Bundled into one
 * file, the manifest one level up is the merchant's, whose version would be a
 * false claim about this package, so any other name gives none.
 */
export const releaseNamedIn = (manifest: string): string | undefined => {
  try {
    const read = JSON.parse(manifest) as { name?: unknown; version?: unknown };
    return read.name === PACKAGE_NAME && typeof read.version === "string"
      ? read.version
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The manifest sits one level above this file both in the sources and in the
 * published build. A bundle that leaves it behind loses only the number.
 */
const manifestText = (): string => {
  try {
    return readFileSync(new URL("../package.json", import.meta.url), "utf8");
  } catch {
    return "";
  }
};

const version = releaseNamedIn(manifestText());

/** What every call says this package is, in its `user-agent` header. */
export const userAgent = version === undefined ? "agentify-sdk" : `agentify-sdk/${version}`;
