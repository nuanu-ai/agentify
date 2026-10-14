/**
 * What every flow is given, and the translations from a card to the order
 * machine's vocabulary. A deadline the card leaves out comes from the
 * configuration here, never from a default invented at the point of use.
 */

import type { MerchantSelling, OrderMode, OrderPolicy } from "@agentify/core";
import { modeOf, readinessOf } from "@agentify/core";
import type { Card, MerchantFinding } from "@nuanu-ai/agentify-contracts";
import type { GatewayConfig } from "../config.js";
import type { Announcer } from "../ports/announcer.js";
import type { Clock, Ids } from "../ports/clock.js";
import type { Facilitator } from "../ports/facilitator.js";
import type { Queue } from "../ports/queue.js";
import type {
  Integration,
  Store,
  StoredCard,
  StoredMerchant,
  StoredPayoutWallet,
} from "../ports/store.js";

export interface Runtime {
  readonly config: GatewayConfig;
  readonly store: Store;
  readonly queue: Queue;
  readonly facilitator: Facilitator;
  readonly clock: Clock;
  readonly ids: Ids;
  /**
   * How a merchant is told of a change to their payout wallet or their keys.
   * Asked on the live deployment only.
   */
  readonly announcer: Announcer;
}

export function policyFor(card: Card, config: GatewayConfig): OrderPolicy {
  const { deadlines } = config;
  return {
    deadlines: {
      quoteResponseMs: deadlines.quoteResponseMs,
      quoteTtlMs: deadlines.quoteTtlMs,
      // The money moves before the goods on every card but a synchronous one,
      // and there the wait for the charge is not inside anybody's ceiling.
      settleResponseMs:
        modeOf(card.fulfillment).settle === "on_purchase"
          ? deadlines.settleBeforeGoodsMs
          : deadlines.settleResponseMs,
      syncResponseMs: deadlines.syncResponseMs,
      paymentAfterConfirmationMs: deadlines.paymentAfterConfirmationMs,
      confirmationResponseMs:
        card.confirm_deadline_seconds === undefined
          ? deadlines.defaultConfirmationResponseMs
          : card.confirm_deadline_seconds * 1_000,
      // A parcel's deadline is the time to hand it to a carrier, which its
      // card always names; the clock runs from the charge either way.
      asyncFulfillmentMs:
        card.ship_within_seconds !== undefined
          ? card.ship_within_seconds * 1_000
          : card.fulfill_deadline_seconds === undefined
            ? deadlines.defaultAsyncFulfillmentMs
            : card.fulfill_deadline_seconds * 1_000,
    },
    redelivery: config.redelivery,
  };
}

/**
 * The card as an agent reads it in the catalog: where the merchant named no
 * deadline, the gateway's default that `policyFor` applies is written in, so
 * the agent sees the clock its order runs on. Rounded up to the second, so an
 * agent that waits as long as the card says never gives up on an order still
 * allowed to arrive.
 */
export function cardAsHeld(card: Card, config: GatewayConfig): Card {
  const { deadlines } = policyFor(card, config);
  const seconds = (ms: number): number => Math.ceil(ms / 1_000);
  switch (card.fulfillment) {
    case "async":
      return { ...card, fulfill_deadline_seconds: seconds(deadlines.asyncFulfillmentMs) };
    case "confirm":
      return {
        ...card,
        confirm_deadline_seconds: seconds(deadlines.confirmationResponseMs),
        fulfill_deadline_seconds: seconds(deadlines.asyncFulfillmentMs),
      };
    case "sync":
    case "ship":
      return card;
  }
}

export function modeForCard(card: Card): OrderMode {
  return modeOf(card.fulfillment);
}

/** Whether the merchant is asked what this product costs at the moment of purchase. */
export function priceCheckOf(card: Card): "none" | "merchant" {
  return card.price_check === undefined ? "none" : "merchant";
}

/**
 * Folds a paused card, a paused catalog and a merchant who cannot sell (no
 * payout address, no seller name) into the one word the order machine's guard
 * reads. A merchant who cannot sell must be refused here, before an order is
 * opened, or the order would be one nobody can pay; the operator's own address
 * never stands in for a missing one. A departed merchant stays departed
 * whatever the card says.
 *
 * A card published through an integration the merchant is not selling through
 * reads as paused too: nothing of that integration draws the merchant's
 * orders, so an order for it would be paid for and filled by nobody.
 */
export function sellingFor(
  merchant: MerchantSelling,
  card: StoredCard,
  sellable: boolean,
  through: Integration,
): MerchantSelling {
  return merchant === "open" && (card.paused || !sellable || card.integration !== through)
    ? "paused"
    : merchant;
}

/**
 * The merchant's wallet as it stands at `at`, with the split it is paid
 * through. Nothing rewrites the row when a pending change's wait ends, so a
 * pending change whose moment has come is already the address, and its split
 * the one recorded with it: whatever decides where a sale's money goes must
 * ask this with the gateway's clock and never read `address` off the row.
 */
export function payoutWalletAt(wallet: StoredPayoutWallet, at: number): StoredPayoutWallet {
  return wallet.pending !== null && wallet.pending.takesEffectAt <= at
    ? { address: wallet.pending.address, split: wallet.pending.split, pending: null }
    : wallet;
}

type MerchantStanding = Pick<StoredMerchant, "payoutWallet" | "serviceName" | "liveApprovedAt">;

/**
 * What this merchant lacks on this deployment. The rule is `readinessOf` in the
 * core, shared with the dashboard. It is asked at every sale as well as at
 * publishing because a merchant's row can change after their cards are
 * published.
 */
export function missingFrom(
  merchant: MerchantStanding,
  config: GatewayConfig,
): readonly MerchantFinding[] {
  return readinessOf(
    {
      sellerName: merchant.serviceName,
      // A pending change never gives an address where there was none, so
      // whether there is one is read off the row, not at an instant.
      payoutWallet: merchant.payoutWallet.address,
      liveApproval: merchant.liveApprovedAt !== null,
    },
    config.surfaceMode,
  ).missing;
}

export function sellableBy(merchant: MerchantStanding, config: GatewayConfig): boolean {
  return missingFrom(merchant, config).length === 0;
}
