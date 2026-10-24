/**
 * The operator's payout: the transactions that pay out every payout split
 * recorded on this gateway's network, since any of them may hold money, but
 * one waiting behind a wallet change not yet in force, which is counted, in
 * parts of twenty, each split created where it has no code yet, distributed
 * and its merchant's share withdrawn, and the commission last, for a person to
 * send from a wallet of their own. Building it sends nothing, signs nothing,
 * writes nothing and takes no work off the queue, so Agentify is paid only
 * when somebody sends what it lists.
 *
 * Nothing is listed where the gateway would refuse to start on the registry,
 * since a transaction built from splits the code disagrees with may pay out
 * another contract than the one buyers paid, nor where the builder refuses a
 * split, which it does where a share would be withdrawn to an address no
 * wallet may be. Every split is read across merchants, so nothing a request
 * reaches may call this.
 */

import type { Gateway } from "./app/gateway.js";
import { RefusedToStart } from "./app/recorded-splits.js";
import { operatorPayouts, type PayoutTransaction } from "./split/payout.js";

/**
 * The chains a gateway takes payments on, by the names a wallet lists them
 * under: the same transaction sent on another chain pays nothing out.
 */
const CHAIN_NAMES: Readonly<Record<string, string>> = {
  "eip155:84532": "Base Sepolia",
  "eip155:8453": "Base",
};

/** The chain every transaction of a payout is sent on, by its CAIP-2 identifier and a wallet's name for it. */
interface PayoutChain {
  readonly id: string;
  readonly name: string;
}

/** One transaction of the payout, with the wallets its commission withdrawals pay. */
interface PayoutPart extends PayoutTransaction {
  readonly commissionWallets: readonly string[];
}

export type PayoutListing =
  /** Nothing settles on a sandbox and no split is ever deployed there. */
  | { readonly kind: "sandbox" }
  /** No transaction is listed, and `why` says what the gateway refuses. */
  | { readonly kind: "refused"; readonly why: string }
  | {
      readonly kind: "nothing_recorded";
      readonly chain: PayoutChain;
      /** How many splits wait behind a wallet change not yet in force, which are not listed. */
      readonly waiting: number;
    }
  | {
      readonly kind: "listed";
      readonly chain: PayoutChain;
      /** How many recorded splits the parts pay out between them. */
      readonly splits: number;
      /** How many splits wait behind a wallet change not yet in force, which are not listed. */
      readonly waiting: number;
      readonly parts: readonly PayoutPart[];
    };

/**
 * The payout of every split recorded on the gateway's network, or why none is
 * listed. A read of the registry that fails throws: that is not a refusal.
 */
export async function payoutListing(application: Gateway): Promise<PayoutListing> {
  const { surfaceMode, payoutSplit: network, payoutSplitNetworks } = application.runtime.config;
  if (surfaceMode === "sandbox") return { kind: "sandbox" };

  try {
    await application.refuseUnlessTheSplitsAgree();
  } catch (thrown) {
    if (thrown instanceof RefusedToStart) return { kind: "refused", why: thrown.message };
    throw thrown;
  }

  const chain = { id: network.network, name: CHAIN_NAMES[network.network] ?? network.network };
  const { splits, waiting } = await application.splitsToPayOut();
  if (splits.length === 0) return { kind: "nothing_recorded", chain, waiting };

  let parts: readonly PayoutTransaction[];
  try {
    parts = operatorPayouts(network, splits, payoutSplitNetworks);
  } catch (refused) {
    // The builder is pure and throws only to refuse.
    return { kind: "refused", why: refused instanceof Error ? refused.message : String(refused) };
  }
  return {
    kind: "listed",
    chain,
    splits: splits.length,
    waiting,
    parts: parts.map((part) => ({
      ...part,
      commissionWallets: [...new Set(part.splits.map((split) => split.commissionWallet))],
    })),
  };
}
