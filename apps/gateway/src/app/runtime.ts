/**
 * What every flow is given, and the translations from a card to the machine's
 * vocabulary.
 *
 * The policy is built here rather than anywhere further in, because it is the
 * one place where our numbers and the merchant's meet. Ours come from the
 * configuration; his two come off the card, and where he named neither the
 * configuration says what he is held to instead. A default invented at the
 * point of use would be a deadline nobody agreed to, applied to somebody's
 * money.
 */

import type { MerchantSelling, OrderMode, OrderPolicy } from "@agentify/core";
import { modeOf, readinessOf } from "@agentify/core";
import type { Card, MerchantFinding } from "@nuanu-ai/agentify-contracts";
import type { GatewayConfig } from "../config.js";
import type { Announcer } from "../ports/announcer.js";
import type { Clock, Ids } from "../ports/clock.js";
import type { Facilitator } from "../ports/facilitator.js";
import type { Queue } from "../ports/queue.js";
import type { Store, StoredCard, StoredMerchant, StoredPayoutWallet } from "../ports/store.js";

export interface Runtime {
  readonly config: GatewayConfig;
  readonly store: Store;
  readonly queue: Queue;
  readonly facilitator: Facilitator;
  readonly clock: Clock;
  readonly ids: Ids;
  /**
   * How a merchant is told of a change to their payout wallet or their keys.
   * Asked on the live deployment and nowhere else (ADR-0019).
   */
  readonly announcer: Announcer;
}

export function policyFor(card: Card, config: GatewayConfig): OrderPolicy {
  const { deadlines } = config;
  return {
    deadlines: {
      quoteResponseMs: deadlines.quoteResponseMs,
      quoteTtlMs: deadlines.quoteTtlMs,
      settleResponseMs: deadlines.settleResponseMs,
      syncResponseMs: deadlines.syncResponseMs,
      paymentAfterConfirmationMs: deadlines.paymentAfterConfirmationMs,
      confirmationResponseMs:
        card.confirm_deadline_seconds === undefined
          ? deadlines.defaultConfirmationResponseMs
          : card.confirm_deadline_seconds * 1_000,
      asyncFulfillmentMs:
        card.fulfill_deadline_seconds === undefined
          ? deadlines.defaultAsyncFulfillmentMs
          : card.fulfill_deadline_seconds * 1_000,
    },
    redelivery: config.redelivery,
  };
}

export function modeForCard(card: Card): OrderMode {
  return modeOf(card.fulfillment);
}

/**
 * Whether the merchant is asked what this product costs at the moment of
 * purchase.
 *
 * A card whose price check names an address rather than the handler is asked
 * over a transport the pilot does not serve, and this says so out loud instead
 * of quietly treating the card as static. The order is created with a price
 * check that will go unanswered, and the merchant's silence is then resolved
 * by the machine's own per-mode policy — which is the honest ending, because a
 * question we cannot ask and a question that got no answer are the same fact
 * from the order's side.
 */
export function priceCheckOf(card: Card): "none" | "merchant" {
  return card.price_check === undefined ? "none" : "merchant";
}

/** Whether the price question can actually be put to this merchant today. */
export function quoteReachesTheMerchant(card: Card): boolean {
  return card.price_check === "handler";
}

/**
 * The one word the order machine is given about whether this card may be sold.
 *
 * There are two switches a merchant can press — one card off sale, or the whole
 * catalog — and a third thing that stops a sale without anybody pressing
 * anything: a merchant who cannot make one, because there is nowhere for the
 * money to go or nobody for the request to name as the seller. There is exactly
 * one guard in the machine. This is where the three become the one, and it is a
 * translation rather than a second notion of pausing: what comes out is the
 * machine's own vocabulary, and a card that comes out `paused` refuses new
 * orders through the guard that already exists, with the rejection and the
 * message that already exist.
 *
 * The merchant's own standing belongs here rather than at the purchase, and the
 * difference is a row in a database. A challenge for such a card is either
 * unwritable or untrue — there is no address to put in it and the operator's
 * own will not stand in (ADR-0019), or there is no seller to name and the field
 * is simply left out — so a purchase that checked at the till would have opened
 * the order first and failed afterwards, leaving one nobody can pay and nothing
 * will ever collect. Folded in here, the card is not offered, not listed, and
 * refused with the word an agent's client already knows.
 *
 * A departed merchant stays departed whatever a card says. Leaving is not a
 * pause a card can be excused from, and reading a card as merely paused would
 * be the difference between "no new orders" and "the open ones closed and the
 * money for the undelivered is yours to return".
 */
export function sellingFor(
  merchant: MerchantSelling,
  card: StoredCard,
  sellable: boolean,
): MerchantSelling {
  return merchant === "open" && (card.paused || !sellable) ? "paused" : merchant;
}

/**
 * A merchant's wallet as it stands at one instant: the address a payment
 * request written then names, and the change still waiting beside it.
 *
 * The row is not enough on its own, and this is the whole reason the function
 * exists. A replacement on the live deployment waits forty-eight hours after it
 * is announced (ADR-0019), and nothing writes the row at the moment the wait
 * ends — no job is armed for it, because a job can be late or lost, and a sale
 * paid to the old address after the merchant was told it would move is a
 * promise broken with nothing on the row to say so. So the instant decides
 * instead: a waiting change whose moment has come is the address, and the row
 * catches up the next time it is written. Every reader of where a sale goes asks
 * this with the gateway's own clock, and nothing reads `address` off the row.
 */
export function payoutWalletAt(wallet: StoredPayoutWallet, at: number): StoredPayoutWallet {
  return wallet.pending !== null && wallet.pending.takesEffectAt <= at
    ? { address: wallet.pending.address, pending: null }
    : wallet;
}

/** The part of a merchant's row the rule reads. */
type MerchantStanding = Pick<StoredMerchant, "payoutWallet" | "serviceName" | "liveApprovedAt">;

/**
 * What this merchant lacks on this deployment, read off their row.
 *
 * The rule is not here. It is `readinessOf` in the core, the one the cabinet
 * asks as well, so the publish door, every later sale and the merchant's own
 * screens cannot come to disagree about what a merchant must have. What is
 * here is the gateway's reading of the row, and the gateway reads every fact,
 * so nothing it asks is ever unknown.
 *
 * Why each fact is asked lives with the rule. Why each is asked here as well as
 * at the publish door is that a merchant's row changes after their cards are
 * published — a name taken away with `merchant listed-as <id> --none`, a card
 * published before live approval was asked for — and a sale whose challenge
 * named nobody, or named no address, would be an invitation to pay that nobody
 * can honour.
 */
export function missingFrom(
  merchant: MerchantStanding,
  config: GatewayConfig,
): readonly MerchantFinding[] {
  return readinessOf(
    {
      sellerName: merchant.serviceName,
      // Whether there is an address does not turn on the instant — a waiting
      // change replaces an address and never gives one where there was none —
      // so this asks the row rather than the clock.
      payoutWallet: merchant.payoutWallet.address,
      liveApproval: merchant.liveApprovedAt !== null,
    },
    config.surfaceMode,
  ).missing;
}

/**
 * Whether this merchant could make a sale at all: the one fact the fold needs.
 *
 * From the order's side there is nothing to tell apart. Every prerequisite
 * belongs to the merchant rather than the card, and any one missing means this
 * sale cannot be made; the publish door is where they are named one by one.
 */
export function sellableBy(merchant: MerchantStanding, config: GatewayConfig): boolean {
  return missingFrom(merchant, config).length === 0;
}
