/**
 * The stream a test hands the worker. `batch` builds one poll answer at the
 * version this SDK speaks; `polling` plays the answers in order and then holds
 * the poll open as a gateway holds a long poll, since a script that ran out
 * would leave a loop with instant sleeps polling as fast as it can. The
 * envelopes are typed as the contract's own, so a drifted fixture stops the
 * package compiling.
 */

import type { WorkerEnvelope } from "@nuanu-ai/agentify-contracts";
import { contractVersion } from "../contract.js";
import type { GatewayAnswer } from "./fake-gateway.js";

/** One poll answer carrying these envelopes, at the version this SDK speaks. */
export const batch = (...carried: WorkerEnvelope[]): GatewayAnswer => ({
  body: { contract_version: contractVersion, envelopes: carried },
});

/** Answers the scripted batches in order and then holds the poll open. */
export const polling = (
  ...script: GatewayAnswer[]
): ((call: unknown, index: number) => GatewayAnswer | Promise<GatewayAnswer>) => {
  const parked = new Promise<GatewayAnswer>(() => {});
  return (_call: unknown, index: number) => script[index] ?? parked;
};
