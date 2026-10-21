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

/**
 * The release this package is, from its manifest, which sits one level above
 * this file both in the sources and in the published build. A bundle that
 * leaves the manifest behind loses only the number, never the import.
 */
const release = (): string | undefined => {
  try {
    const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(manifest) as { version?: string }).version;
  } catch {
    return undefined;
  }
};

const version = release();

/** What every call says this package is, in its `user-agent` header. */
export const userAgent = version === undefined ? "agentify-sdk" : `agentify-sdk/${version}`;
