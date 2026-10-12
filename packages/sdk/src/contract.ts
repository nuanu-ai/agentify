/**
 * Which contract this package speaks, and whether it understands another. The
 * worker checks the version on the answer to every poll, and the package
 * exports the same check to a merchant who wants to make it themselves.
 */

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
