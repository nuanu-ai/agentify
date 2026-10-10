/**
 * What state an order is in, in the words an agent and a merchant both read.
 *
 * These are the state machine's own endings, and they live here because they
 * are wire names: an agent asks what became of its purchase, a merchant
 * restarting a worker asks what is still open, and both have to get the same
 * answer. A second list kept anywhere else would be a second answer to one
 * question, and the one the machine keeps would win without anybody noticing.
 *
 * Every value below says what the agent can be told truthfully, which is not
 * always everything the machine knows. Where the two differ the value says so
 * in its own words: `rejected` is coarser than the machine's states behind it,
 * and `in_progress` covers every step of a purchase that has not finished —
 * an order just sent to the merchant and one the merchant has taken on and
 * owes a delivery for are one word here, because to the buyer they are one
 * situation. A merchant who needs those apart is not reading this vocabulary;
 * they are reading their own order, which carries the answer they gave.
 *
 * The word for a purchase still running exists on purpose: an agent that had
 * to read silence as an answer would take an unfinished order for a refused
 * one, and hold a budget against a sale that is still going to happen.
 *
 * Two of the machine's own distinctions are deliberately not here, and saying
 * which is the point — a list that claims to name every ending has to admit
 * what it folded. The machine separates a purchase that never reached the
 * merchant from one the merchant refused, and it separates an order sent to
 * the merchant from one the merchant has taken on. Both distinctions are the
 * merchant's: the first their metrics need, the second their own record
 * already holds. To the buyer each pair is one situation, and this vocabulary
 * is the buyer's. A merchant reading it and expecting their own view of the
 * order is reading the wrong list.
 */

import { z } from "zod";

export const ORDER_STATUSES = Object.freeze([
  /** Running: no terminal answer yet, and no reason to read one into it. */
  "in_progress",
  /** Success: the product is with the agent and the money with the merchant. */
  "delivered",
  /**
   * A parcel is with the carrier and the money with the merchant (ADR-0033):
   * the merchant recorded its shipment, and the order carries it. This is the
   * last word Agentify has about the parcel. Every protocol that uses the word
   * goes on past it to arrival; this one does not, because nothing reports an
   * arrival here, and whether the parcel arrives is between the buyer and the
   * merchant — the seller's site is where to ask.
   */
  "shipped",
  /**
   * Closed and the buyer's money is known not to have moved — the product was
   * gone, the parameters did not fit, the payment failed its check, the charge
   * came back failed, or a synchronous handler refused. On a parcel, the
   * product being gone is the merchant's price answer saying "not available",
   * which there can also mean the merchant does not ship to that place or the
   * address lacks what their carrier needs.
   *
   * The machine keeps a finer distinction behind this word: a purchase that
   * never reached the merchant and one the merchant refused are separate
   * states there, because the merchant's own accounting needs them apart. To
   * the agent both are one sentence — a refusal — and folding them was argued
   * on the grounds that the reason travels separately, in the refusal code.
   *
   * It does travel, and what it carries is worth being exact about. The
   * agent's status document has a `refusal` beside this word, and where a
   * merchant refused the order it holds the two things the merchant actually
   * wrote: a short code to branch on and a sentence to show. The word here
   * stays coarse because that is the agent's vocabulary, and the pair beside
   * it is what makes the coarseness affordable.
   *
   * The rest of the fold is told apart in another voice. Where this gateway
   * and not the merchant ended the order — a product the price check reported
   * gone, a price check that did not answer, a charge that did not go through
   * — the status carries a `reason` of its own (`ORDER_ENDING_REASONS`), and
   * never beside the merchant's words: inventing a merchant's code for an
   * ending they never worded would be putting words in a mouth that never
   * opened, so ours are said as ours.
   */
  "rejected",
  /**
   * Nobody can say whether the buyer was charged: the payment network was
   * asked and never answered. The order may still be open — the goods may
   * already be made — and a later read can still move. Closed is not what
   * this word says.
   *
   * Deliberately not `rejected`, and this is the fifth gate in one value. An
   * agent told its purchase did not happen goes and buys the same thing
   * elsewhere without looking at its wallet — a claim we would be making with
   * no evidence behind it. What we know is that we asked and heard nothing;
   * saying so is the honest answer, and it is what a dispute, an error text
   * and the merchant's reconciliation all read.
   */
  "payment_unresolved",
  /** The merchant answered a confirmation request with "I will not deliver". */
  "declined",
  /**
   * A deadline passed with nobody at fault: the confirmation, the payment that
   * was to follow it, or the synchronous delivery.
   */
  "expired",
  /** The merchant left, and orders still open closed with them. */
  "cancelled",
  /**
   * The money moved and the goods have not come: the merchant owes the buyer
   * the goods or the money back. Not an ending, and it carries no deadline of
   * its own. Goods the merchant delivers after it still reach the buyer, settle
   * the debt and make the order `delivered`.
   *
   * What it cannot say is whether the money has already gone back. The
   * merchant pays a refund from their own wallet and the gateway has no way yet
   * to record that they did, so until it has one nothing moves an order on to
   * `refunded`, and a buyer the merchant has already paid back still reads
   * this word.
   */
  "refund_due",
  /** That debt has since been paid back to the buyer. */
  "refunded",
  /**
   * The merchant delivered synchronously and the payment did not execute. The
   * goods exist, nothing was paid, and the order stays open until a repeat
   * purchase carries the payment through.
   */
  "delivered_unpaid",
] as const);

export const OrderStatusSchema = z.enum(ORDER_STATUSES);

export type OrderStatus = z.infer<typeof OrderStatusSchema>;

/**
 * Why an order ended, where Agentify and not its merchant decided it and one
 * status word would otherwise cover endings that call for different next
 * steps. These are this gateway's own words about its own decisions; a
 * merchant's refusal travels in theirs and never gets one of these beside it.
 */
export const ORDER_ENDING_REASONS = Object.freeze([
  /**
   * `rejected`: the merchant's price check said there is none, and gave no
   * reason. On a parcel that can also mean the merchant does not ship to the
   * address given; nothing here can say which.
   */
  "unavailable",
  /**
   * `rejected`: the merchant's price check gave no price this purchase could
   * use — it did not answer in time, or its answer could not be accepted.
   */
  "price_check_unanswered",
  /** `rejected`: the payment layer said the charge did not go through. */
  "payment_not_settled",
  /** `expired`: the price ran out before a payment for it was taken. */
  "price_expired",
  /** `expired`: the merchant did not answer a synchronous purchase in time. */
  "merchant_timed_out",
] as const);

export const OrderEndingReasonSchema = z.enum(ORDER_ENDING_REASONS);

export type OrderEndingReason = z.infer<typeof OrderEndingReasonSchema>;
