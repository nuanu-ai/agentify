/**
 * Runs the order machine: load the order, hand it and one event to
 * `transition`, write down what comes back, and carry out the effects it asked
 * for. Every decision is taken in `@agentify/core`; one taken here would be a
 * second machine disagreeing with the first about somebody's money.
 *
 * A money invariant violation on an order about to be written is thrown, not
 * handled: stopping is safer than writing it down and selling on. Effects that
 * nothing re-emits once the order has moved on, such as the dispatch envelope
 * and the receipt, are written in the same hold as the state that implies them;
 * the rest run after the write and outside the hold, because they call the
 * network and feed the next event about the same order, which under the hold
 * would wait for itself. Everything here is at least once, as the contract
 * promises merchants, never exactly once. Every event carries its instant, read
 * from the clock once at the edge, so a replayed purchase produces the same
 * order.
 */

import type {
  Deadline,
  Effect,
  EndingReason,
  MerchantAnswer,
  Order,
  OrderEvent,
  OrderState,
  StateEvent,
  TransitionRejection,
  TransitionResult,
} from "@agentify/core";
import {
  assertNever,
  deadlines,
  endingReasonFor,
  fulfillmentDeadline,
  holdsShipTo,
  moneyInvariantViolations,
  outcomeFor,
  paidAfterClosure,
  transition,
} from "@agentify/core";
import {
  type Delivery,
  localityOf,
  type Order as OrderDocument,
  type PaymentStatus,
  type Receipt,
  type ReceiptOutcome,
  type RecordedShipment,
  type SalePrice,
  type Seller,
  type UnfulfilledReason,
  type WorkerEnvelope,
} from "@nuanu-ai/agentify-contracts";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { GatewayConfig } from "../config.js";
import { failureNamed } from "../failure-named.js";
import { authorizationFingerprint, paymentFingerprint } from "../http/x402.js";
import { asTimestamp } from "../ports/clock.js";
import {
  type Facilitator,
  type PaymentRecoveryContext,
  type PaymentRecoveryOutcome,
  RecoveryFailure,
  type SettleOutcome,
} from "../ports/facilitator.js";
import type { Reminder } from "../ports/queue.js";
import type {
  Integration,
  MerchantScope,
  OrderChange,
  PaymentAttempt,
  PaymentCompletion,
  PaymentWord,
  StoredOrder,
  WithTheOrder,
} from "../ports/store.js";
import { statusUrlOf } from "./addresses.js";
import type { Runtime } from "./runtime.js";
import { purchaseOf, Waiting } from "./waiting.js";
import type { WrittenOrderStatus } from "./written.js";

/** The queue's name for the daily sweep of what an order is still owed. */
export const SWEEP_EFFECTS = "agentify_sweep_effects";
export const RECONCILE_PAYMENTS = "agentify_reconcile_payments";

function hasObservedPayment(record: StoredOrder): boolean {
  const completion = record.paymentAttempt?.completion;
  return completion?.settled === true && completion.executedAt !== null;
}

/**
 * Saved assertion-only settlements carry this marker without payment evidence.
 * The sweep must not invent an execution time or receipt for those records.
 */
const UNOBSERVED_SETTLE = "the facilitator was not asked";

/**
 * What is written about the purchase alongside the order. Every fact lands in
 * the same write as the order the event moved, so neither is stored without the
 * other; whether the goods are kept depends on what became of the event, which
 * `goodsToKeep` decides once the machine has seen it.
 */
export interface OrderFacts {
  readonly delivery?: Delivery;
  readonly settlement?: { readonly transaction: string };
  /** Something the payment layer said, appended to what it has said before. */
  readonly paymentWord?: PaymentWord;
  readonly priceId?: string;
  readonly openDeliveryId?: string | null;
}

/**
 * What presenting a verified payment came to. `took`: this payment settled
 * ownership, the order moved and its effects ran. `already_yours`: the same
 * owner asking again about a purchase under way. `not_owner`: somebody else's
 * payment, turned away without a mark on the order. `refused`: the machine
 * declined the event, as for a repeat on an order whose charge is still
 * unaccounted for.
 */
export type PresentResult =
  | { readonly kind: "took"; readonly order: StoredOrder; readonly answer: MerchantAnswer | null }
  | { readonly kind: "already_yours"; readonly state: OrderState }
  | { readonly kind: "not_owner"; readonly state: OrderState }
  | { readonly kind: "refused"; readonly rejection: TransitionRejection }
  /** A payment fit only to return a paid purchase, for an order that would now charge it. */
  | { readonly kind: "payee_left" }
  | { readonly kind: "no_such_order" };

/** What one hold on an order came to, before its effects are carried out. */
type Decided =
  | {
      readonly kind: "decided";
      readonly moved: TransitionResult;
      readonly known: StoredOrder;
    }
  /** The caller's `whileWaitingOn` was no longer true; nothing was written. */
  | { readonly kind: "moved_on" };

/** What the hold in `presentVerifiedPayment` came to, before its effects run. */
type PresentDecided =
  | {
      readonly kind: "took";
      readonly known: StoredOrder;
      readonly effects: readonly Effect[];
    }
  | { readonly kind: "already_yours"; readonly state: OrderState }
  | { readonly kind: "not_owner"; readonly state: OrderState }
  | { readonly kind: "refused"; readonly rejection: TransitionRejection }
  | { readonly kind: "payee_left" };

export type Applied =
  | {
      readonly outcome: "moved";
      readonly order: StoredOrder;
      readonly effects: readonly Effect[];
      /** What the merchant's own call is answered with, where the event was one. */
      readonly answer: MerchantAnswer | null;
    }
  | { readonly outcome: "refused"; readonly rejection: TransitionRejection }
  /**
   * The order had moved on from what the caller was holding it to, and nothing
   * was written. Only a caller that passed `whileWaitingOn` can be told this.
   */
  | { readonly outcome: "moved_on" }
  | { readonly outcome: "no_such_order" };

/** What a parked purchase is woken with: the order as it finally stands. */
export type PurchaseSettled = StoredOrder;

/** What one run of the sweep repaired, and what it could not. */
export interface Swept {
  /** Orders paid for that had reached nobody and were sent out again. */
  dispatched: number;
  /** Delivered orders that had no receipt and now have one. */
  receipted: number;
  /** Clocks that had run out with nothing waiting on them, started again. */
  rearmed: number;
  /** Orders the sweep could not repair, each one logged. */
  refused: number;
}

/**
 * Whether this effect runs after the order is written rather than being
 * written with it. An effect belongs with the write when nothing can re-drive
 * it once the order has moved past the transition that asked for it; the
 * switch is exhaustive so a new effect cannot fall on the wrong side unnoticed.
 *
 * Whether the sweep may issue one again is a separate question: a merchant
 * event is delivered at most once, and a parcel's erasure deletes rather than
 * sends, so `sweep` re-issues neither, and no arm may be added there for an
 * effect whose receiver was not promised a repeat.
 */
function carriedOutAfterwards(effect: Effect): boolean {
  switch (effect.kind) {
    case "dispatch_order":
    case "redeliver_order":
    case "emit_merchant_event":
    case "issue_receipt":
    // Erasing a parcel's address changes the order itself and the envelopes
    // that carry it, so it is written with the state.
    case "erase_ship_to":
      return false;
    case "request_quote":
    case "verify_payment":
    case "execute_payment":
    case "invite_payment":
    case "dispatch_confirmation_request":
    case "release_goods_to_agent":
    case "hold_fulfillment":
    case "mark_unfulfilled":
    case "answer_merchant":
      return true;
    default:
      return assertNever(effect, "effect");
  }
}

export class OrderRunner {
  readonly #runtime: Runtime;
  readonly purchases = new Waiting<PurchaseSettled>();

  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }

  /**
   * Writes down a new order and carries out the effects its creation asked
   * for; the machine has already decided that the order exists. `through` is
   * the integration its card was sold through: if the merchant has stopped
   * selling through it by the time the order would be written, nothing is
   * written or carried out and null comes back.
   */
  async create(
    record: StoredOrder,
    effects: readonly Effect[],
    at: number,
    through: Integration,
  ): Promise<StoredOrder | null> {
    refuseToWriteAnImpossibleOrder(record.order);
    refuseToKeepAnAddressPastItsTime(record);
    // The clock is started before the order is written: a reminder for an order
    // never written finds nothing, while an order written with no clock on it is
    // one nothing will ever close.
    await this.#arm([], deadlines(record.order), record.order.id);

    // `addOrder` takes nothing to write alongside the order, so an effect that
    // must be written with it is refused here, before the order exists.
    const written = this.#writesWithTheOrder(record, record.order, effects, at);
    if (written.length > 0) {
      throw new Error(
        `creating ${record.order.id} asked for ${written.length} thing(s) to be written down with it, and the birth of an order has nowhere to write them`,
      );
    }

    if (!(await this.#runtime.store.addOrder(record, through))) {
      return null;
    }
    await this.#run(record, effects);
    return record;
  }

  /**
   * Feeds one event to the machine and carries out whatever comes back.
   *
   * With `scope`, the store finds nothing where the order belongs to another
   * merchant, and ownership is read under the same hold as the order, so the
   * caller cannot tell "not yours" from "not there". It is left out where there
   * is no merchant to hold the caller to: our own reminder, or an agent's
   * payment.
   *
   * With `whileWaitingOn`, the event and facts apply only while the order still
   * waits on that hand-over, checked under the hold; otherwise the caller is
   * told the order moved on. Checked by the caller beforehand, it would race the
   * merchant's answer, a worker's own hand-over or a repeated reminder.
   */
  async apply(
    orderId: string,
    event: OrderEvent,
    facts: OrderFacts = {},
    scope?: MerchantScope,
    whileWaitingOn?: string,
    completion?: { readonly attemptId: string; readonly result: PaymentCompletion },
  ): Promise<Applied> {
    const decided = await this.#runtime.store.withOrder(
      orderId,
      async (found): Promise<OrderChange<Decided>> => {
        if (
          completion !== undefined &&
          (found.paymentAttempt?.id !== completion.attemptId ||
            found.paymentAttempt.completion !== null)
        ) {
          return { result: { kind: "moved_on" } };
        }
        if (whileWaitingOn !== undefined && found.openDeliveryId !== whileWaitingOn) {
          // Somebody else got here first. Nothing is written, not even the
          // cleared hand-over: it would erase the hand-over the order now waits
          // on and leave its silence unnoticed.
          return { result: { kind: "moved_on" } };
        }

        let before = found.order;
        const elapsedEffects: Effect[] = [];
        if (
          completion !== undefined &&
          before.state !== "fulfilled" &&
          before.state !== "delivered_unpaid"
        ) {
          const elapsed = deadlines(before).find(
            (deadline) =>
              deadline.kind === "settle_response" && deadline.at <= this.#runtime.clock(),
          );
          if (elapsed !== undefined) {
            const expired = transition(before, {
              kind: "deadline_expired",
              deadline: elapsed.kind,
              at: elapsed.at,
            });
            if (expired.ok) {
              before = expired.order;
              elapsedEffects.push(...expired.effects);
            }
          }
        }
        const known: StoredOrder = {
          ...found,
          order: before,
          ...(completion === undefined || found.paymentAttempt === undefined
            ? {}
            : { paymentAttempt: { ...found.paymentAttempt, completion: completion.result } }),
          ...(facts.settlement === undefined ? {} : { settlement: facts.settlement }),
          ...(facts.paymentWord === undefined ? {} : this.#alsoSaid(found, facts.paymentWord)),
          ...(facts.priceId === undefined ? {} : { priceId: facts.priceId }),
          ...(facts.openDeliveryId === undefined ? {} : { openDeliveryId: facts.openDeliveryId }),
        };

        const changed = transition(known.order, event);
        let moved = changed.ok
          ? { ...changed, effects: [...elapsedEffects, ...changed.effects] }
          : changed;
        if (!moved.ok) {
          // Nothing is written for a refused event, not even its facts: an
          // event with no meaning here leaves no trace of having been believed.
          return { result: { kind: "decided", moved, known } };
        }

        let effectsAt = completion?.result.source === "chain" ? this.#runtime.clock() : event.at;
        const overdueGoods =
          completion?.result.settled && moved.order.state === "paid"
            ? fulfillmentDeadline(moved.order).find(
                (deadline) => deadline.at <= this.#runtime.clock(),
              )
            : undefined;
        if (overdueGoods !== undefined) {
          const expired = transition(moved.order, {
            kind: "deadline_expired",
            deadline: overdueGoods.kind,
            at: overdueGoods.at,
          });
          if (expired.ok) {
            moved = {
              ...expired,
              effects: [
                ...moved.effects.filter((effect) => effect.kind !== "dispatch_order"),
                ...expired.effects,
              ],
            };
            effectsAt = overdueGoods.at;
          }
        }

        refuseToWriteAnImpossibleOrder(moved.order);
        const next: StoredOrder = {
          ...known,
          order: moved.order,
          ...this.#paymentIntent(known, moved.effects, event.at),
          ...goodsToKeep(found, facts.delivery, moved.effects),
          ...addressToKeep(moved.effects, this.#runtime.clock()),
        };
        refuseToKeepAnAddressPastItsTime(next);

        // The clocks are started before the change is committed. A reminder
        // left by a write that then fails is refused by the machine as a
        // deadline not running; arming after the write and failing would leave
        // a moved order with no clock on it, hanging with nothing to close it.
        await this.#arm(deadlines(known.order), deadlines(next.order), orderId);

        return {
          save: next,
          // The effects that must not be lost go in with the order.
          alongside: this.#writesWithTheOrder(next, known.order, moved.effects, effectsAt),
          result: { kind: "decided", moved, known: next },
        };
      },
      scope,
    );

    if (!decided.found) {
      return { outcome: "no_such_order" };
    }
    if (decided.result.kind === "moved_on") {
      return { outcome: "moved_on" };
    }

    const { moved, known } = decided.result;
    if (!moved.ok) {
      return { outcome: "refused", rejection: moved.rejection };
    }

    const answer = await this.#run(known, moved.effects.filter(carriedOutAfterwards));
    this.#wakeTheAgent(known);

    return { outcome: "moved", order: known, effects: moved.effects, answer };
  }

  /**
   * Presents a payment the payment layer has already verified, deciding
   * ownership and changing the order inside the store's hold. Two verified
   * payments for one order can both reach here, and deciding from a copy read
   * before the hold would let both take it, with goods handed over against a
   * charge that fails. So the guard reads `found.paidBy` under the lock: the
   * first becomes the owner and the second is turned away without a mark on
   * the order.
   *
   * Verification happens before the lock, since a network round-trip must not
   * hold a row, so the machine's own `verify_payment` effect is dropped here as
   * already answered.
   *
   * `owner` must arrive in the one spelling `walletThatPaid` in `gateway.ts`
   * produces, and this is the only writer of `paidBy`, so the guard compares
   * exactly; an address spelled the way a facilitator happened to spell it would
   * make one wallet into two buyers, and nothing here could tell.
   */
  async presentVerifiedPayment(
    orderId: string,
    owner: string,
    payment: string,
    payTo: string | null,
    at: number,
    verified?: {
      readonly recovery?: PaymentRecoveryContext;
      readonly fingerprint: string;
      /**
       * Checked against the split a paid order's money went to, which is no
       * longer where its merchant is paid, so the payment may return the
       * purchase and must not be charged.
       */
      readonly onlyReturns?: boolean;
    },
  ): Promise<PresentResult> {
    const word: PaymentWord = { at, about: "verify", said: `checked out, paid by ${owner}` };

    const decided = await this.#runtime.store.withOrder(
      orderId,
      async (found): Promise<OrderChange<PresentDecided>> => {
        if (found.paidBy !== null && found.paidBy !== owner) {
          // Somebody else's payment owns this order. Nothing is written.
          return { result: { kind: "not_owner", state: found.order.state } };
        }

        const events = eventsForVerifiedPayment(found.order, at);
        if (events.length === 0) {
          // A merchant may close an unpaid order while payment verification is
          // outside this lock. Its public payment reference establishes no owner.
          if (found.paidBy !== owner) {
            return { result: { kind: "not_owner", state: found.order.state } };
          }
          // The owner is asking again about a purchase already under way. The
          // answer is wherever it has got to, and nothing changes.
          return { result: { kind: "already_yours", state: found.order.state } };
        }
        // The order came to take a new charge while the payment was checked,
        // and charged now its money would go to a wallet the merchant left.
        if (verified?.onlyReturns === true) {
          return { result: { kind: "payee_left" } };
        }

        let order = found.order;
        const effects: Effect[] = [];
        for (const event of events) {
          const moved = transition(order, event);
          if (!moved.ok) {
            // The machine declines — a repeat on an order whose charge never
            // reported back, for one. Nothing is written.
            return { result: { kind: "refused", rejection: moved.rejection } };
          }
          order = moved.order;
          refuseToWriteAnImpossibleOrder(order);
          effects.push(...moved.effects);
        }

        const {
          paymentRecovery: _previousRecovery,
          paymentAttempt: _previousAttempt,
          ...prior
        } = found;
        const accepted: StoredOrder = {
          ...prior,
          order,
          payment,
          // The address this payment was checked against. The charge runs
          // later, after fulfilment in the synchronous mode, and reading the
          // merchant's wallet then could send the money somewhere other than
          // where the payer signed for.
          payTo,
          paidBy: owner,
          ...(verified?.recovery === undefined
            ? {}
            : { paymentRecovery: { ...verified.recovery } }),
          ...(verified === undefined ? {} : { paymentFingerprint: verified.fingerprint }),
          ...this.#alsoSaid(found, word),
        };
        const next: StoredOrder = { ...accepted, ...this.#paymentIntent(accepted, effects, at) };
        // A verified payment never ends a parcel's need for its address, so
        // nothing here erases it; should the machine change that, this stops
        // the write rather than keep an address past its time.
        refuseToKeepAnAddressPastItsTime(next);

        // The clocks are armed before the change is committed, for the same
        // reason `apply` arms them there.
        await this.#arm(deadlines(found.order), deadlines(order), orderId);
        return {
          save: next,
          alongside: [
            ...this.#writesWithTheOrder(next, found.order, effects, at),
            ...(verified === undefined
              ? []
              : [{ kind: "retain_payment" as const, fingerprint: verified.fingerprint, orderId }]),
          ],
          result: { kind: "took", known: next, effects },
        };
      },
    );

    if (!decided.found) {
      return { kind: "no_such_order" };
    }
    const result = decided.result;
    if (result.kind !== "took") {
      return result;
    }

    // The payment is already verified, so the machine's request to verify it is
    // answered and dropped; what was written down with the order is not carried
    // out a second time; and what is left runs outside the lock.
    const runnable = result.effects.filter(
      (effect) => effect.kind !== "verify_payment" && carriedOutAfterwards(effect),
    );
    const answer = await this.#run(result.known, runnable);
    this.#wakeTheAgent(result.known);
    return { kind: "took", order: result.known, answer };
  }

  /**
   * Repairs what the orders are still owed, read from the orders themselves
   * with no second record of intent: a paid order that reached nobody is put on
   * its merchant's stream, a delivered order with no receipt gets one, and an
   * open order whose clock ran out has it started again so the machine can end
   * it. Each repair is a no-op on a second run because the world has changed,
   * not because a run was remembered.
   *
   * Two runs at once are not safe: both would find an envelope missing and send
   * it, spending one of that order's deliveries. One process never overlaps
   * runs, but with two gateways a run outliving the job's expiry is retried on
   * the other, so the work is taken under a named lock and a run that finds it
   * held does nothing. The lock lasts only as long as the holding session's
   * connection; a run whose connection died carries on without it.
   *
   * The orders are a snapshot, so an order that finished mid-sweep is acted on
   * as it stood, and the receipt arm can overwrite a receipt the ordinary path
   * wrote after the snapshot with one under a different identifier, built from
   * the older reading, which matters because merchants reconcile against it.
   *
   * An arm may only re-drive an effect whose receiver is promised it can arrive
   * more than once: a hand-over, which the merchant's handler expects to see
   * again, and a receipt, one row keyed by its order. A merchant event is
   * delivered at most once, so the sweep cannot duplicate its original notice.
   */
  async sweep(): Promise<Swept | null> {
    const ran = await this.#runtime.store.runAlone(SWEEP_EFFECTS, () => this.#sweepAlone());
    if (!ran.ran) {
      console.log("[gateway] the sweep found another run already holding it, and did nothing");
      return null;
    }
    return ran.result;
  }

  async #sweepAlone(): Promise<Swept> {
    const now = this.#runtime.clock();
    const swept: Swept = { dispatched: 0, receipted: 0, rearmed: 0, refused: 0 };

    for (const record of await this.#runtime.store.openOrders()) {
      try {
        swept.dispatched += await this.#sweepTheDispatch(record, now);
        swept.rearmed += await this.#sweepTheClocks(record, now);
      } catch (thrown) {
        // One order that cannot be repaired does not stop the rest, and it is
        // logged so that nobody is left unaware of it.
        swept.refused += 1;
        console.error(
          `[gateway] the sweep could not repair ${record.order.id}: ${failureNamed(thrown)}`,
        );
      }
    }

    for (const record of await this.#runtime.store.deliveredWithoutReceipt()) {
      // An asserted settlement has no observed execution time. Writing its
      // receipt here would falsely date payment to the time of this sweep.
      const asserted = record.paymentWords.some(
        (word) => word.about === "settle" && word.said.includes(UNOBSERVED_SETTLE),
      );
      if (asserted && !hasObservedPayment(record)) {
        continue;
      }
      try {
        await this.#runtime.store.putReceipt(
          record.merchantId,
          this.#receiptFor(record, record.order, now),
        );
        swept.receipted += 1;
      } catch (thrown) {
        swept.refused += 1;
        console.error(
          `[gateway] the sweep could not receipt ${record.order.id}: ${failureNamed(thrown)}`,
        );
      }
    }

    if (swept.dispatched + swept.receipted + swept.rearmed + swept.refused > 0) {
      console.log(
        `[gateway] the sweep sent ${swept.dispatched} orders out again, wrote ${swept.receipted} receipts, started ${swept.rearmed} clocks, and could not repair ${swept.refused}`,
      );
    }
    return swept;
  }

  /**
   * Puts a paid order that has reached nobody on its merchant's stream again.
   *
   * The stream is asked first: every hand-over counts toward the machine's
   * attempt cap, whose result is an unfulfilled paid order, so an envelope still sitting
   * unclaimed is left alone rather than spend a delivery the merchant never
   * failed. An envelope already drawn is on no stream and looks the same as one
   * never written, since the order stays `paid` until the hand-over is
   * recorded; `sweepDispatchGraceMs`, counted from when the money landed, covers
   * a worker that drew promptly and is still working. A worker that polls less
   * often than that gets a second hand-over, at most one per daily sweep, so the
   * grace is the number to raise for a slow-polling merchant.
   */
  async #sweepTheDispatch(record: StoredOrder, now: number): Promise<number> {
    const paidAt = record.order.timestamps.paidAt;
    if (record.order.state !== "paid" || paidAt === null) {
      return 0;
    }
    if (paidAt + this.#runtime.config.sweepDispatchGraceMs > now) {
      return 0;
    }
    if (await this.#runtime.queue.holdsOrder(record.merchantId, record.order.id)) {
      return 0;
    }

    if (record.shipTo === undefined) {
      await this.#runtime.queue.publish(record.merchantId, this.#orderEnvelope(record, now));
      return 1;
    }
    // A parcel's hand-over carries its buyer's address, and this order was read
    // at the start of the sweep; taken on since, its address is gone. So it is
    // built under the hold from the order as it stands, only while it is still
    // paid and still holds the address.
    const sent = await this.sendWhileTheAddressIsHeld(record.order.id, (found) =>
      found.order.state === "paid" ? this.#orderEnvelope(found, now) : null,
    );
    return sent ? 1 : 0;
  }

  /**
   * Puts an envelope carrying a parcel's address on its merchant's stream
   * outside a transition, under the hold on the order and only while the order
   * still holds the address. The erasure deletes what is on the stream under
   * that same hold; an envelope written outside it from an earlier copy could
   * land after the deletion and keep the address as long as the queue keeps the
   * job. `envelopeOf` answers null when the caller's reason for sending has
   * gone, and the result says whether anything was written.
   */
  async sendWhileTheAddressIsHeld(
    orderId: string,
    envelopeOf: (found: StoredOrder) => WorkerEnvelope | null,
    afterMs?: number,
  ): Promise<boolean> {
    const decided = await this.#runtime.store.withOrder(orderId, (found): OrderChange<boolean> => {
      const envelope = holdsShipTo(found.order) ? envelopeOf(found) : null;
      if (envelope === null) {
        return { result: false };
      }
      return {
        alongside: [
          {
            kind: "envelope",
            merchantId: found.merchantId,
            envelope,
            ...(afterMs === undefined ? {} : { afterMs }),
          },
        ],
        result: true,
      };
    });
    return decided.found && decided.result;
  }

  /**
   * Starts again the clocks an order is waiting on that have already run out.
   * Only a reminder declares an order overdue, so one armed and then lost, as
   * by a handler that threw past the queue's patience, leaves an order nothing
   * will close. Repeating is safe because the
   * machine refuses an expiry for a deadline not running or not yet reached.
   */
  async #sweepTheClocks(record: StoredOrder, now: number): Promise<number> {
    let rearmed = 0;
    for (const deadline of deadlines(record.order)) {
      if (deadline.at > now) {
        continue;
      }
      await this.#runtime.queue.remind(
        {
          kind: "deadline",
          orderId: record.order.id,
          deadline: deadline.kind,
          at: deadline.at,
        },
        0,
      );
      rearmed += 1;
    }
    return rearmed;
  }

  /**
   * Arms the clocks that are running now and were not before. A stray reminder
   * is harmless, since the machine refuses an expiry for a deadline not running
   * or not yet reached, so the mistake to guard against is a clock nobody
   * started. Kind and instant are compared together so that a deadline that
   * moved gets a new reminder.
   */
  async #arm(
    before: readonly Deadline[],
    after: readonly Deadline[],
    orderId: string,
  ): Promise<void> {
    const now = this.#runtime.clock();
    for (const deadline of after) {
      const alreadyRunning = before.some(
        (was) => was.kind === deadline.kind && was.at === deadline.at,
      );
      if (alreadyRunning) {
        continue;
      }
      const reminder: Reminder = {
        kind: "deadline",
        orderId,
        deadline: deadline.kind,
        at: deadline.at,
      };
      await this.#runtime.queue.remind(reminder, Math.max(deadline.at - now, 0));
    }
  }

  /**
   * The writes that go into the same hold as the order, out of the effects one
   * transition asked for; none of them can be re-driven once the order has moved
   * past that transition. Being written here does not make an effect one the
   * sweep may repeat: a hand-over and a receipt may be, a merchant event may not
   * since it is delivered at most once, and a parcel's erasure sends nothing.
   */
  #writesWithTheOrder(
    record: StoredOrder,
    before: Order,
    effects: readonly Effect[],
    at: number,
  ): WithTheOrder[] {
    const writes: WithTheOrder[] = [];

    for (const effect of effects) {
      switch (effect.kind) {
        // The stream comes off the order and is never guessed: its merchant was
        // settled when the order was made, so a redelivery reaches the same
        // worker as the first hand-over did.
        case "dispatch_order":
          writes.push({
            kind: "envelope",
            merchantId: record.merchantId,
            envelope: this.#orderEnvelope(record, at),
          });
          break;

        case "redeliver_order":
          writes.push({
            kind: "envelope",
            merchantId: record.merchantId,
            envelope: this.#orderEnvelope(record, at),
            afterMs: effect.delayMs,
          });
          break;

        case "emit_merchant_event":
          writes.push({
            kind: "envelope",
            merchantId: record.merchantId,
            envelope: this.#eventEnvelope(record, effect.event, at),
          });
          break;

        case "issue_receipt":
          // An unknown payment needs a facilitator answer or observed chain
          // execution before a receipt can claim that money moved.
          if (
            before.payment === "outcome_unknown" &&
            record.settlement === null &&
            !hasObservedPayment(record)
          ) {
            break;
          }
          writes.push({
            kind: "receipt",
            merchantId: record.merchantId,
            receipt: this.#receiptFor(record, before, at),
          });
          break;

        case "erase_ship_to":
          // The order itself already keeps only when (`addressToKeep`); what is
          // left is everything on the merchant's stream that carries any of
          // the address, deleted in the same unit as the order.
          writes.push({
            kind: "forget",
            merchantId: record.merchantId,
            orderId: record.order.id,
            priceQuestion: record.priceQuestion ?? null,
          });
          break;

        default:
          // Everything else runs after the write, and `carriedOutAfterwards` is
          // asked rather than assumed: an effect it does not run that is missing
          // here would be written by neither half, and a merchant would never be
          // handed the work.
          if (!carriedOutAfterwards(effect)) {
            throw new Error(
              `${effect.kind} on ${record.order.id} is written down with the order and this does not know how to write it`,
            );
          }
          break;
      }
    }

    return writes;
  }

  /** Carries out the effects that were not written down, and hands back the answer the merchant is owed. */
  async #run(record: StoredOrder, effects: readonly Effect[]): Promise<MerchantAnswer | null> {
    let answer: MerchantAnswer | null = null;

    for (const effect of effects) {
      switch (effect.kind) {
        case "request_quote":
          // The purchase flow puts the question, since it waits for the answer.
          // The machine armed `quote_response` when the order was created, so a
          // merchant who never answers is answered by the reminder.
          break;

        case "verify_payment":
          // The gateway verifies a payment before taking the order's lock,
          // since a network round-trip must not hold a row and deciding
          // ownership needs the verified payer, so by the time any transition
          // runs the payment this names is already checked.
          break;

        case "execute_payment":
          await this.#settle(record);
          break;

        case "dispatch_order":
        case "redeliver_order":
        case "emit_merchant_event":
        case "issue_receipt":
        case "erase_ship_to":
          // These were written with the state that implies them. Reaching here
          // means a caller did not filter them out, and doing them again would
          // put a duplicate on a merchant's stream while looking like the code
          // working.
          throw new Error(
            `${effect.kind} on ${record.order.id} was written down with the order and must not be carried out again`,
          );

        case "mark_unfulfilled":
          // The state records incomplete fulfillment; its event carries the
          // original price. No goods were released, so no receipt is issued.
          break;

        case "answer_merchant":
          answer = effect.answer;
          break;

        case "release_goods_to_agent":
          // Handing the goods over is waking whoever is parked on the purchase,
          // which happens once after every effect has run, so the agent never
          // wakes to an order still half-decided.
          break;

        case "hold_fulfillment":
          // Holding is keeping what the merchant produced on the order, which
          // nothing here throws away; a repeat of the purchase reads the
          // machine's own flag.
          break;

        case "invite_payment":
        case "dispatch_confirmation_request":
          // Both belong to the mode that asks the merchant before the money
          // moves, which has no shape on the wire, so no card can be published
          // in it; inventing a message here would put a document on the
          // merchant's stream that no contract describes.
          throw new Error(
            `${effect.kind} belongs to the confirmation mode, which has no shape on the wire yet`,
          );

        default:
          throw new Error(`unhandled effect: ${JSON.stringify(effect)}`);
      }
    }

    return answer;
  }

  async #settle(record: StoredOrder): Promise<void> {
    const payment = record.payment;
    const price = record.order.price;
    if (payment === null || price === null) {
      throw new Error(
        `the machine asked for the charge on ${record.order.id} to be executed and there is nothing to execute`,
      );
    }

    const outcome = await this.#runtime.facilitator.settle({
      paymentRef: record.paymentRef,
      amount: price.amount,
      currency: price.currency,
      payment,
      // The address this payment was verified against, not the merchant's
      // current one: it is what the buyer's authorisation names, so a charge to
      // a wallet moved since would be refused after the goods went out.
      payTo: record.payTo,
    });
    if (record.paymentAttempt === undefined)
      throw new Error("a charge has no durable payment attempt");
    await this.completePaymentAttempt(
      record.order.id,
      record.paymentAttempt.id,
      outcome,
      "facilitator",
    );
  }

  #paymentIntent(
    record: StoredOrder,
    effects: readonly Effect[],
    at: number,
  ): Pick<StoredOrder, "paymentAttempt"> {
    if (!effects.some((effect) => effect.kind === "execute_payment")) return {};
    return {
      paymentAttempt: {
        id: this.#runtime.ids("pay"),
        startedAt: at,
        ...(record.paymentRecovery === undefined
          ? {}
          : { recovery: { ...record.paymentRecovery } }),
        completion: null,
      },
    };
  }

  /** Applies an answer only to the submitted attempt it names. Recovery never submits a charge. */
  async completePaymentAttempt(
    orderId: string,
    attemptId: string,
    outcome: SettleOutcome | PaymentRecoveryOutcome,
    source: "facilitator" | "chain",
    at = this.#runtime.clock(),
  ): Promise<Applied> {
    if (outcome.settled === "unknown") {
      const recorded = await this.#runtime.store.withOrder(
        orderId,
        (found): OrderChange<boolean> => {
          const attempt = found.paymentAttempt;
          if (attempt?.id !== attemptId || attempt.completion !== null) return { result: false };
          const progressed = "nextBlock" in outcome ? outcome.nextBlock : undefined;
          const nextBlock =
            progressed !== undefined && /^\d+$/.test(progressed)
              ? attempt.nextBlock === undefined || BigInt(progressed) > BigInt(attempt.nextBlock)
                ? progressed
                : attempt.nextBlock
              : attempt.nextBlock;
          const transaction = "transaction" in outcome ? outcome.transaction : undefined;
          // Recovery polls every minute; repeating its words would push out
          // what the facilitator said, which is said once.
          const repeated = source === "chain" && found.paymentWords.at(-1)?.said === outcome.reason;
          return {
            save: {
              ...found,
              paymentAttempt: {
                ...attempt,
                ...(nextBlock === undefined ? {} : { nextBlock }),
                ...(transaction === undefined ? {} : { transaction }),
              },
              ...(repeated
                ? {}
                : this.#alsoSaid(found, { at, about: "settle", said: outcome.reason })),
            },
            result: true,
          };
        },
      );
      if (recorded.found && recorded.result && source === "facilitator") {
        console.error(
          `[gateway] ${orderId}: the payment layer left the settle unanswered; its words are kept on the order`,
        );
      }
      return !recorded.found ? { outcome: "no_such_order" } : { outcome: "moved_on" };
    }
    const result: PaymentCompletion = outcome.settled
      ? {
          settled: true,
          transaction: outcome.transaction,
          executedAt: "executedAt" in outcome ? outcome.executedAt : null,
          source,
        }
      : { settled: false, reason: outcome.reason, source };
    return this.apply(
      orderId,
      {
        kind: outcome.settled ? "payment_settled" : "payment_settle_failed",
        at: outcome.settled && "executedAt" in outcome ? outcome.executedAt : at,
      },
      {
        ...(outcome.settled && source === "facilitator"
          ? { settlement: { transaction: outcome.transaction } }
          : {}),
        paymentWord: {
          at,
          about: "settle",
          said: outcome.settled ? `${source} confirmed ${outcome.transaction}` : outcome.reason,
        },
      },
      undefined,
      undefined,
      { attemptId, result },
    );
  }

  /**
   * Revisits persisted unanswered attempts, including purchases already closed
   * on a timeout. Each run ends with one log line while any payment is
   * unresolved, saying how many and how long the oldest has waited, and one
   * more naming the failure when the chain could not be read: a recovery that
   * cannot finish is visible, not silent.
   */
  async reconcilePayments(): Promise<void> {
    const reconcile = this.#runtime.facilitator.reconcile;
    await this.#runtime.store.runAlone(RECONCILE_PAYMENTS, async () => {
      const now = this.#runtime.clock();
      let unresolved = 0;
      let oldest = now;
      let failed = 0;
      let failure = "";
      let afterId = "";
      for (;;) {
        const records = await this.#runtime.store.unresolvedPayments(afterId, 100);
        if (records.length === 0) break;
        for (const record of records) {
          afterId = record.order.id;
          if (
            record.order.payment === "settling" &&
            deadlines(record.order).some(
              (deadline) => deadline.kind === "settle_response" && deadline.at > now,
            )
          )
            continue;
          try {
            if (await this.#reconcileOne(record, reconcile)) continue;
          } catch (thrown) {
            failed += 1;
            failure ||= thrown instanceof RecoveryFailure ? thrown.message : failureNamed(thrown);
          }
          unresolved += 1;
          const since =
            record.paymentAttempt?.startedAt ??
            record.order.timestamps.settleStartedAt ??
            record.order.timestamps.createdAt;
          if (since < oldest) oldest = since;
        }
      }
      if (failed > 0)
        console.error(
          `[gateway] payment recovery could not look for ${failed} of ${unresolved} unresolved payments: ${failure.replace(/\.?$/, ".")} It tries again every minute; an endpoint that keeps failing is replaced through PAYMENT_RPC_URL`,
        );
      if (unresolved > 0)
        console.warn(
          `[gateway] ${unresolved} unresolved payment${unresolved === 1 ? "" : "s"}, the oldest waiting ${Math.floor((now - oldest) / 60_000)} minutes${reconcile === undefined ? "; payment recovery is off because no RPC is configured, and setting PAYMENT_RPC_URL to a Base endpoint turns it on" : ""}`,
        );
    });
  }

  /**
   * Whether the chain settled this record's payment one way or the other. It
   * throws when the chain could not be read, after keeping any progress.
   */
  async #reconcileOne(record: StoredOrder, reconcile: Facilitator["reconcile"]): Promise<boolean> {
    if (reconcile === undefined) return false;
    const attempt = record.paymentAttempt ?? (await this.#recoverAttempt(record));
    if (attempt?.recovery === undefined || attempt.completion !== null) return false;
    const outcome = await reconcile.call(this.#runtime.facilitator, {
      context: attempt.recovery,
      ...(attempt.transaction === undefined ? {} : { transaction: attempt.transaction }),
      ...(attempt.nextBlock === undefined ? {} : { nextBlock: attempt.nextBlock }),
    });
    await this.completePaymentAttempt(record.order.id, attempt.id, outcome, "chain");
    // The progress is saved; the read that stopped it still counts as a failure.
    if (outcome.settled === "unknown" && outcome.failure !== undefined)
      throw new RecoveryFailure(outcome.failure);
    return outcome.settled !== "unknown";
  }

  async #recoverAttempt(record: StoredOrder): Promise<PaymentAttempt | undefined> {
    const recoveryFor = this.#runtime.facilitator.recoveryFor;
    const price = record.order.price;
    if (
      recoveryFor === undefined ||
      record.payment === null ||
      record.payTo === null ||
      price === null
    )
      return undefined;
    // The payment was checked after the order existed, so its transfer is later still.
    const recovery = await recoveryFor.call(
      this.#runtime.facilitator,
      {
        paymentRef: record.paymentRef,
        payment: record.payment,
        payTo: record.payTo,
        amount: price.amount,
        currency: price.currency,
      },
      record.order.timestamps.createdAt,
    );
    if (recovery === null || record.paidBy?.toLowerCase() !== recovery.payer.toLowerCase())
      return undefined;
    const fingerprint = authorizationFingerprint(recovery);
    if (await this.#authorizationIsAmbiguous(record.order.id, recovery, fingerprint))
      return undefined;
    const claim = await this.#runtime.store.claimPayment(fingerprint, record.order.id);
    if (!claim.claimed) return undefined;
    const recovered = await this.#runtime.store.withOrder(
      record.order.id,
      (found): OrderChange<PaymentAttempt | undefined> => {
        if (found.paymentAttempt !== undefined) return { result: found.paymentAttempt };
        if (
          found.payment !== record.payment ||
          (found.order.payment !== "settling" && found.order.payment !== "outcome_unknown")
        )
          return { result: undefined };
        const attempt: PaymentAttempt = {
          id: this.#runtime.ids("pay"),
          startedAt: found.order.timestamps.settleStartedAt ?? found.order.timestamps.createdAt,
          recovery: { ...recovery },
          completion: null,
        };
        return {
          save: {
            ...found,
            paymentRecovery: recovery,
            paymentFingerprint: fingerprint,
            paymentAttempt: attempt,
          },
          alongside: [{ kind: "retain_payment", fingerprint, orderId: found.order.id }],
          result: attempt,
        };
      },
    );
    return recovered.found ? recovered.result : undefined;
  }

  async #authorizationIsAmbiguous(
    orderId: string,
    recovery: PaymentRecoveryContext,
    fingerprint: string,
  ): Promise<boolean> {
    // Old accepted claims were pruned by age. Check saved authorizations before attributing their money.
    let afterId = "";
    for (;;) {
      const records = await this.#runtime.store.paymentOrders(afterId, 100);
      if (records.length === 0) return false;
      for (const record of records) {
        afterId = record.order.id;
        if (record.order.id === orderId || record.payment === null) continue;
        if (record.paymentFingerprint === fingerprint) return true;
        try {
          const payload = decodePaymentSignatureHeader(record.payment);
          if (
            payload.accepted?.network.toLowerCase() !== recovery.network.toLowerCase() ||
            payload.accepted?.asset.toLowerCase() !== recovery.asset.toLowerCase()
          )
            continue;
          if (paymentFingerprint(payload, recovery) === fingerprint) return true;
        } catch {
          /* An unreadable saved authorization supplies no matching evidence. */
        }
      }
    }
  }

  /**
   * Appends one more thing the payment layer said, keeping the last few and
   * counting what fell off. Bounded because anyone with an order's identifier
   * can present a payment and append here, and every later decision about the
   * order rewrites this under a lock; the count tells a reader of what is kept
   * how much more there was.
   */
  #alsoSaid(
    record: StoredOrder,
    word: PaymentWord,
  ): Pick<StoredOrder, "paymentWords" | "paymentWordsDropped"> {
    const said = [...record.paymentWords, word];
    const kept = this.#runtime.config.paymentWordsKept;
    const dropped = Math.max(said.length - kept, 0);

    return {
      paymentWords: dropped === 0 ? said : said.slice(dropped),
      paymentWordsDropped: record.paymentWordsDropped + dropped,
    };
  }

  /**
   * Builds rather than writes the receipt, because the store writes it inside
   * the same hold as the order; the sweep builds the same receipt on its own,
   * which is why this takes its instants rather than reading a clock.
   */
  #receiptFor(record: StoredOrder, before: Order, at: number): Receipt {
    const price = record.order.price;
    if (price === null) {
      throw new Error(`a receipt was asked for on ${record.order.id}, which has no price`);
    }

    // When the money moved: now if it moved on this transition, otherwise the
    // instant the order carries. Stamping the moment somebody asked would be a
    // claim about a payment nobody made then.
    const moneyMovedNow = before.payment !== "settled" && record.order.payment === "settled";
    const completion = record.paymentAttempt?.completion;
    const paidAt =
      completion?.settled && completion.executedAt !== null
        ? completion.executedAt
        : moneyMovedNow
          ? at
          : (record.order.timestamps.paidAt ?? at);
    const transaction = paidTransactionOf(record);

    // The merchant comes from the order, not through the card: a card can be
    // republished or taken off sale, and a receipt names who made the sale
    // whatever became of the catalog.
    return {
      id: this.#runtime.ids("rcp"),
      order_id: record.order.id,
      item_id: record.itemId,
      price: {
        amount: price.amount,
        currency: price.currency,
        at: asTimestamp(record.order.timestamps.quotedAt ?? record.order.timestamps.createdAt),
        as_of: asTimestamp(price.asOf),
      },
      ...(record.priceId === null ? {} : { price_id: record.priceId }),
      paid_at: asTimestamp(paidAt),
      outcome: receiptOutcomeOf(record.order),
      ...(transaction === undefined ? {} : { transaction }),
      test: record.order.test,
    };
  }

  #orderEnvelope(record: StoredOrder, at: number): WorkerEnvelope {
    return {
      kind: "order",
      id: this.#runtime.ids("env"),
      sent_at: asTimestamp(at),
      payload: orderDocumentOf(record),
    };
  }

  #eventEnvelope(record: StoredOrder, event: string, at: number): WorkerEnvelope {
    const common = { order_id: record.order.id, at: asTimestamp(at) } as const;

    switch (event) {
      case "order.unfulfilled": {
        // The event names the original sale price, never a refund amount or
        // the card's current list price.
        const price = record.order.price;
        if (price === null) {
          throw new Error(`the paid unfulfilled order ${record.order.id} carries no sale price`);
        }
        return {
          kind: "order_event",
          id: this.#runtime.ids("env"),
          sent_at: asTimestamp(at),
          payload: {
            type: "order.unfulfilled",
            ...common,
            price: { amount: price.amount, currency: price.currency },
            reason: unfulfilledReasonOf(record.order),
          },
        };
      }
      case "order.unpaid_after_confirmation":
      case "order.payment_failed_after_delivery":
        return {
          kind: "order_event",
          id: this.#runtime.ids("env"),
          sent_at: asTimestamp(at),
          payload: { type: event, ...common },
        };
      default:
        throw new Error(`no shape on the wire for the merchant event ${event}`);
    }
  }

  /**
   * Wakes an agent parked on this purchase once the order has an answer for
   * him. "In progress" is not one: woken with it, he would read a purchase still
   * going through as finished.
   */
  #wakeTheAgent(record: StoredOrder): void {
    if (record.paidBy !== null && outcomeFor(record.order) !== "in_progress") {
      this.purchases.answer(purchaseOf(record.order.id, record.paidBy), record);
    }
  }
}

/**
 * What this order sold for, or nothing where nobody ever named a price. The
 * merchant's order and the buyer's status both read it here, so the two sides
 * are always told the same number.
 */
function salePriceOf(record: StoredOrder): SalePrice | null {
  const price = record.order.price;
  if (price === null) {
    return null;
  }

  return {
    amount: price.amount,
    currency: price.currency,
    at: asTimestamp(record.order.timestamps.quotedAt ?? record.order.timestamps.createdAt),
    as_of: asTimestamp(price.asOf),
  };
}

/**
 * Where one order stands, as the agent that bought it reads it, both from the
 * purchase and from a later read by identifier alone; one builder keeps the two
 * answers alike. It is built field by field rather than trimmed from the order,
 * because anyone holding the identifier can read it and a field later added to
 * the merchant's record would otherwise leak here unnoticed. `config` is taken
 * whole rather than as a base string, so that the address cannot quietly become
 * one read off a request.
 */
export function agentOrderStatusOf(
  record: StoredOrder,
  seller: Seller,
  config: Pick<GatewayConfig, "publicBaseUrl">,
): WrittenOrderStatus {
  const status = outcomeFor(record.order);
  const closure = record.order.closure;

  return {
    order_id: record.order.id,
    status_url: statusUrlOf(config, record.order.id),
    status,
    payment_status: paymentStatusOf(record.order),
    ...transactionOf(record),
    ...merchantClosureOf(record.order),
    // Null where nobody named a price, never the card's figure: an order that
    // closed before it was priced was never sold at anything.
    price: salePriceOf(record),
    // The goods only once they are the buyer's, which is narrower than once the
    // merchant handed them over: a synchronous delivery whose charge failed
    // leaves goods on an unpaid order, and answering with them would be a way
    // to collect for free what a failed charge left behind. A charge that went
    // silent reads `in_progress`, the one case where goods exist, the buyer may
    // have been charged, and nothing here hands them over.
    delivered: status === "delivered" ? (record.delivery ?? null) : null,
    // A parcel's record of handing it to a carrier, and the instant it has to
    // be with one by: present on a parcel's order only, and null until there
    // is something to say. Nothing reached the agent, so the shipment is never
    // under `delivered`.
    ...(record.order.mode.parcel === true
      ? {
          shipment: status === "shipped" ? (record.delivery as RecordedShipment | null) : null,
          ship_by: shipByOf(record.order),
        }
      : {}),
    // The same word the merchant's receipt carries. Every other field reads
    // the same whether the charge was real or not, so without it a buyer would
    // hold what looks like proof of a payment.
    test: record.order.test,
    // Who sold it, as the catalog shows the merchant now: where an agent takes
    // a question this document cannot answer. Passed in, so that building the
    // document stays a reading of what the caller holds.
    seller,
    // The merchant's own code and sentence for why they would not sell, copied
    // and not rephrased. The condition is the closure, not the status word: one
    // refusal reaches the agent as `rejected`, `declined` or `unfulfilled`
    // depending on when it arrived, and the merchant's sentence belongs in all
    // three. Nothing else fills it; an ending this gateway decided is said in
    // its own voice under `reason`.
    ...(closure?.cause === "merchant_refused"
      ? { refusal: { code: closure.code, message: closure.message } }
      : {}),
    ...reasonOf(record.order),
  };
}

/**
 * The transaction that paid this order: the one the chain showed for a payment
 * recovery found there, otherwise the one the facilitator named when it
 * confirmed the charge. Neither is recorded for a charge that failed or went
 * unanswered. An empty one is left off: the contract refuses one, and a single
 * refused document would break a whole list.
 */
export function paidTransactionOf(record: StoredOrder): string | undefined {
  const completion = record.paymentAttempt?.completion;
  const transaction =
    completion?.settled && completion.executedAt !== null
      ? completion.transaction
      : record.settlement?.transaction;
  return transaction === undefined || transaction.trim() === "" ? undefined : transaction;
}

/** The transaction field of a document about this order, where it has one. */
function transactionOf(record: StoredOrder): { readonly transaction?: string } {
  const transaction = paidTransactionOf(record);
  return transaction === undefined ? {} : { transaction };
}

export function paymentStatusOf(order: Order): PaymentStatus {
  if (order.payment === "settled") return "paid";
  return order.payment === "settling" || order.payment === "outcome_unknown"
    ? "unresolved"
    : "not_paid";
}

export function merchantClosureOf(order: Order): {
  readonly merchant_closure?: { readonly closed_at: string; readonly message?: string };
} {
  const closed = order.merchantClosure;
  return closed === undefined
    ? {}
    : {
        merchant_closure: {
          closed_at: asTimestamp(closed.at),
          ...(closed.message === undefined ? {} : { message: closed.message }),
        },
      };
}

/**
 * Why an order stopped: a code to branch on and a sentence explaining the
 * observed payment and fulfillment facts. Agreements remain with the parties.
 */
function reasonOf(order: Order): {
  reason?: { code: EndingReason | UnfulfilledReason; message: string };
} {
  // A payment after closure is the merchant's news; the agent reads that order
  // as closed.
  const unfulfilled = outcomeFor(order) === "unfulfilled" ? unfulfilledReasonOf(order) : null;
  if (unfulfilled !== null && unfulfilled !== "paid_after_closure") {
    return { reason: { code: unfulfilled, message: UNFULFILLED_WORDS[unfulfilled](order) } };
  }
  const code = endingReasonFor(order);
  if (code === null) {
    return {};
  }
  return { reason: { code, message: REASON_WORDS[code](order) } };
}

const UNFULFILLED_WORDS: Readonly<
  Record<Exclude<UnfulfilledReason, "paid_after_closure">, (order: Order) => string>
> = {
  refused: () =>
    "The seller refused this paid order, in their own words under refusal. Agentify has no delivery recorded. Contact the seller about fulfillment or any agreement; Agentify does not confirm refunds.",
  deadline_passed: (order) =>
    order.closure?.cause === "payment_outcome_unknown"
      ? "The original payment was confirmed after Agentify stopped waiting for its result. Agentify did not dispatch this order and has no delivery recorded. Contact the seller about fulfillment or any agreement; Agentify does not confirm refunds."
      : order.mode.parcel === true
        ? "This paid parcel has no shipment recorded by its deadline. Contact the seller about fulfillment or any agreement; Agentify does not confirm refunds."
        : "This paid order has no delivery recorded by its deadline. Contact the seller about fulfillment or any agreement; Agentify does not confirm refunds.",
  merchant_left: () =>
    "The seller stopped selling through Agentify before this paid order was fulfilled. Contact the seller about fulfillment or any agreement; Agentify does not confirm refunds.",
};

/**
 * The sentence an order's `reason` carries where Agentify ended it, or null
 * where it carries none.
 */
export function endingSentenceOf(order: Order): string | null {
  const code = endingReasonFor(order);
  return code === null ? null : REASON_WORDS[code](order);
}

const REASON_WORDS: Readonly<Record<EndingReason, (order: Order) => string>> = {
  unavailable: () =>
    "The seller's price check said this is not available, and gave no reason; nothing was charged. Buy it elsewhere, or ask the seller at their site.",
  price_check_unanswered: () =>
    "The seller's price check gave no price this purchase could use: it did not answer in time, or its answer could not be accepted. Nothing was charged. Trying again later may work if the seller's price check recovers.",
  payment_not_settled: (order) =>
    order.state === "delivered_unpaid"
      ? "The seller made the goods, but the charge did not go through, so nothing was taken, and Agentify is holding the goods. Check the paying wallet, then pay for this same purchase again from the wallet that signed it, by signing the same payment request again: the goods are released without being delivered a second time. If the seller has changed where they are paid since, that payment is refused with nothing charged, and a new purchase is the way to buy it."
      : "The charge did not go through, and nothing was taken. Check the paying wallet before buying again.",
  price_expired: () =>
    "The price ran out before the payment was taken; nothing was charged. Start a new purchase to get a fresh price.",
  merchant_closed: (order) =>
    paidAfterClosure(order)
      ? "The payment for this order completed after the seller had closed fulfillment through Agentify, so the seller's words under merchant_closure were written before it arrived. Agentify has no delivery recorded and has not verified any refund or agreement. Contact the seller."
      : "This order is paid, and the seller closed fulfillment through Agentify with no delivery recorded. The words under merchant_closure are the seller's own; Agentify has not verified any refund or agreement. Contact the seller.",
  merchant_timed_out: (order) =>
    order.heldFulfillment
      ? "The seller's goods arrived after the purchase had closed; nothing was charged. Pay this same order again, from the same wallet, to collect them."
      : "The seller did not deliver within the time a synchronous purchase allows; nothing was charged. Trying again later may find the seller answering.",
};

/** The order as the merchant's worker reads it. */
export function orderDocumentOf(record: StoredOrder): OrderDocument {
  const price = salePriceOf(record);
  if (price === null) {
    throw new Error(`the order ${record.order.id} was sent to a merchant with no price on it`);
  }

  return {
    id: record.order.id,
    merchant_item_id: record.merchantItemId,
    params: { ...record.params },
    price,
    ...(record.priceId === null ? {} : { price_id: record.priceId }),
    ...shipToAsTheMerchantReadsIt(record),
    test: record.order.test,
  };
}

/**
 * A parcel's address on the merchant's order, as far as the order has got: the
 * place the price was asked for until the order is paid, the whole address once
 * it is, and only when it was erased once it is gone. Nothing on an order that
 * is not a parcel's.
 */
function shipToAsTheMerchantReadsIt(record: StoredOrder): {
  readonly ship_to?: OrderDocument["ship_to"];
} {
  const held = record.shipTo;
  if (held === undefined) {
    return {};
  }
  if ("erasedAt" in held) {
    return { ship_to: { erased_at: asTimestamp(held.erasedAt) } };
  }
  return { ship_to: record.order.timestamps.paidAt === null ? localityOf(held) : held };
}

/**
 * The receipt's word for where the order stands. The machine asks for a
 * receipt only on the way into `delivered`, and this gateway writes none of the
 * receipt's other words, so a receipt asked for anywhere else stops here rather
 * than going out saying "delivered" over an order that was not.
 */
function receiptOutcomeOf(order: Order): ReceiptOutcome {
  if (order.state !== "delivered") {
    throw new Error(
      `a receipt was asked for on an order in ${order.state}, and this gateway has no word for that`,
    );
  }
  // A parcel's receipt says what its status says: it went to a carrier, and
  // nothing reached the agent.
  return order.mode.parcel === true ? "shipped" : "delivered";
}

/**
 * When a parcel has to be with its carrier by: the card's time to ship counted
 * from the charge, and nothing before the order is paid.
 */
function shipByOf(order: Order): string | null {
  const [deadline] = fulfillmentDeadline(order);
  return deadline === undefined ? null : asTimestamp(deadline.at);
}

/**
 * Why paid fulfillment stopped, in the words the merchant's event carries. A
 * charge that reported in after we gave up on it is folded into
 * `deadline_passed`, meaning our deadline on the charge and not his on the
 * goods, because the vocabulary has no word for our side losing track of the
 * money. A payment that completed after the merchant closed fulfillment is
 * `paid_after_closure`, whatever had happened before.
 */
function unfulfilledReasonOf(order: Order): UnfulfilledReason {
  if (paidAfterClosure(order)) {
    return "paid_after_closure";
  }
  const closure = order.closure;
  if (closure === null) {
    throw new Error(`the paid order ${order.id} is unfulfilled with nothing recording why`);
  }

  switch (closure.cause) {
    case "merchant_refused":
      return "refused";
    case "merchant_departed":
      return "merchant_left";
    case "deadline_expired":
    case "payment_outcome_unknown":
      return "deadline_passed";
    case "unavailable":
    case "quote_silent":
    case "payment_not_verified":
    case "payment_not_settled":
      throw new Error(
        `the order ${order.id} is marked paid and unfulfilled after ${closure.cause}, which takes no payment`,
      );
    default:
      return assertNever(closure, "closure cause");
  }
}

/**
 * The goods to write down, out of the ones this call carried. Only the first
 * delivery is kept: delivery is at least once, the machine answers repeats with
 * a successful `already_delivered`, and goods riding on a repeat would otherwise
 * overwrite what the agent was already handed with nothing to show it. Goods on
 * a call the machine answered with a failure for the merchant, such as on a
 * closed order, are not kept either: they were never released to the buyer.
 */
function goodsToKeep(
  found: StoredOrder,
  delivery: Delivery | undefined,
  effects: readonly Effect[],
): { readonly delivery?: Delivery } {
  if (delivery === undefined || found.delivery !== null) {
    return {};
  }

  const turnedAway = effects.some(
    (effect) => effect.kind === "answer_merchant" && !effect.answer.ok,
  );

  return turnedAway ? {} : { delivery };
}

/**
 * The last check before an order is written down. A violation here is a defect
 * in the machine or in this interpreter, not a case to be handled: the
 * alternative to stopping is to write down an order that says the buyer's money
 * is somewhere it is not, and then go on selling against it.
 */
function refuseToWriteAnImpossibleOrder(order: Order): void {
  const violations = moneyInvariantViolations(order);
  if (violations.length > 0) {
    throw new Error(
      `the order ${order.id} breaks what must be true about money and will not be written down — ${violations.join("; ")}`,
    );
  }
}

/**
 * What becomes of a parcel's address as the order moves: only the instant it
 * was erased, on the transition the machine says it stops being needed on, and
 * nothing on any other. The instant is the clock's as the order is written, not
 * the event's: a deadline's reminder can arrive days after the deadline, and
 * the order must not say the address was gone before it went.
 */
function addressToKeep(
  effects: readonly Effect[],
  at: number,
): { readonly shipTo?: { readonly erasedAt: number } } {
  return effects.some((effect) => effect.kind === "erase_ship_to")
    ? { shipTo: { erasedAt: at } }
    : {};
}

/**
 * The last check before an order is written, for a buyer's address: a parcel's
 * order holds all of it exactly while the machine says it is still needed and
 * afterwards only when it was erased, and no other order holds one. Failing it
 * is a defect that would keep an address past its need or hand a merchant a
 * parcel with nowhere to send it; the error names the order, never the address.
 */
function refuseToKeepAnAddressPastItsTime(record: StoredOrder): void {
  const wrong = whatIsWrongWithTheAddress(record);
  if (wrong !== null) {
    throw new Error(`the order ${record.order.id} ${wrong}, and will not be written down`);
  }
}

function whatIsWrongWithTheAddress(record: StoredOrder): string | null {
  const held = record.shipTo;
  if (record.order.mode.parcel !== true) {
    return held === undefined ? null : "holds an address and is not a parcel";
  }
  if (held === undefined) {
    return "is a parcel with no address";
  }
  const needed = holdsShipTo(record.order);
  const erased = "erasedAt" in held;
  if (needed && erased) {
    return "has erased the address its merchant still needs";
  }
  if (!needed && !erased) {
    return "still holds the buyer's address after it stopped being needed";
  }
  return null;
}

/**
 * Whether a verified payment presented for this order now would be charged,
 * rather than only answered with where the purchase stands.
 */
export const takesANewPayment = (order: Order): boolean =>
  eventsForVerifiedPayment(order, 0).length > 0;

/**
 * The events a verified payment drives an order with, from where it stands:
 * `payment_verified` for an order waiting to be paid, preceded by
 * `purchase_repeated` for one a repeat reopens. An empty list tells the owner
 * asking again that the purchase is wherever it has got to. A repeat the
 * machine will not allow, such as one on an order whose charge never reported
 * back, is refused by `transition`, not here.
 */
function eventsForVerifiedPayment(order: Order, at: number): StateEvent[] {
  switch (order.state) {
    case "quoted":
    case "confirmed":
      return [{ kind: "payment_verified", at }];
    case "delivered_unpaid":
      return [
        { kind: "purchase_repeated", at },
        { kind: "payment_verified", at },
      ];
    case "expired":
      return order.heldFulfillment
        ? [
            { kind: "purchase_repeated", at },
            { kind: "payment_verified", at },
          ]
        : [];
    default:
      return [];
  }
}
