/**
 * Which addresses a merchant's share could never come back from. A split pays
 * the wallet written into it for good, so a wallet that is Agentify's own, a
 * contract the payout calls, the token or a split loses the merchant their
 * share, or hands it to whoever calls the contract next.
 */

import { checkedAddress } from "./address.js";
import type { PayoutSplitNetworks } from "./networks.js";

/**
 * What an address is that cannot be a merchant's payout wallet: the zero
 * address; a network's commission wallet; the split factory, the split
 * implementation or the warehouse; Multicall3, which runs anyone's calls as
 * itself; a network's USDC; or a payout split.
 */
export type NotAPayoutWallet =
  | "zero_address"
  | "commission_wallet"
  | "split_factory"
  | "split_implementation"
  | "split_warehouse"
  | "multicall3"
  | "usdc"
  | "payout_split";

/**
 * What this address is, if a merchant's share could not come back from it,
 * or null for an address that is none of those. Every network of the table is
 * looked at, not only the one payments are taken on, and both spellings of an
 * address are the same address. Throws on a string that is not an address.
 */
export function whyNotAPayoutWallet(
  address: string,
  known: {
    readonly networks: PayoutSplitNetworks;
    /** Every split recorded, of every merchant. */
    readonly splits: readonly string[];
  },
): NotAPayoutWallet | null {
  const wallet = checkedAddress(address, "the wallet").toLowerCase();
  const is = (other: string): boolean => other.toLowerCase() === wallet;

  if (is("0x0000000000000000000000000000000000000000")) return "zero_address";
  const networks = Object.values(known.networks);
  if (networks.some((network) => is(network.commissionWallet))) return "commission_wallet";
  if (networks.some((network) => is(network.factory))) return "split_factory";
  if (networks.some((network) => is(network.implementation))) return "split_implementation";
  if (networks.some((network) => is(network.warehouse))) return "split_warehouse";
  if (networks.some((network) => is(network.multicall3))) return "multicall3";
  if (networks.some((network) => is(network.usdc))) return "usdc";
  if (known.splits.some(is)) return "payout_split";
  return null;
}
