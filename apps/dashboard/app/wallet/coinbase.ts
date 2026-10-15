/**
 * Coinbase Wallet, fetched and started when the pointer reaches one of its
 * buttons or one takes the focus, so no page pays for it on its first visit. Every signature and transaction is
 * approved by the merchant in Coinbase's own window, outside this origin;
 * sub-accounts, which would keep a key in this page that signs without asking,
 * stay off, as they are by default.
 *
 * Coinbase's analytics are off: on, the SDK runs an inline script of
 * Coinbase's in this page and reports the page to Coinbase.
 */

import { createBaseAccountSDK } from "@base-org/account";
import type { Wallet } from "./requests.js";

export { askAddress, sendPayout } from "./requests.js";

const opened = new Map<number, Wallet>();

/** The provider for `chainId`, made once per page, since each SDK made registers itself globally. */
export function coinbaseWallet(chainId: number): Wallet {
  const already = opened.get(chainId);
  if (already !== undefined) return already;
  const wallet = createBaseAccountSDK({
    appName: "Agentify",
    appChainIds: [chainId],
    preference: { telemetry: false },
  }).getProvider();
  opened.set(chainId, wallet);
  return wallet;
}
