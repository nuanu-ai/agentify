/**
 * The vocabulary of the order state machine: what an order can be, what can
 * happen to it, and what the gateway is asked to do about it. The merchant
 * reads the same model on the portal, in `apps/docs/orders.md` and
 * `apps/docs/failures.md`.
 *
 * Two rules hold everywhere in this package. Time is a value: every event
 * carries the instant it happened at and nothing here reads a clock, so the
 * same inputs always produce the same order. And the deadlines are a policy,
 * not constants: the numbers are each deployment's configuration, published by
 * the portal as that deployment's settings.
 */

import { assertNever } from "../index.js";

/**
 * Every state an order can be in.
 *
 * The backbone is one for all three fulfillment modes; the mode switches
 * decide when the money moves.
 *
 * - `created` — the intent to buy: the card was found and the purchase
 *   parameters passed the card's schema. No price yet.
 * - `quoted` — the price is fixed, either by the merchant's answer or by the
 *   card's snapshot, and the payment question is next.
 * - `paid` — the payment question is settled as far as this mode requires
 *   before the order reaches the merchant. With the settle on purchase that
 *   means the money moved; with the settle after fulfillment it means the
 *   payment was verified and will be executed last.
 * - `dispatched` — the order was queued and handed to the merchant's handler.
 *   Delivery is at least once, so this state can be entered again.
 * - `fulfilled` — the merchant produced the goods and the money still has to
 *   move. Reachable only where the settle comes after fulfillment.
 * - `delivered` — the successful terminal: the goods are the agent's, the
 *   money is the merchant's, the receipt points at the quote.
 * - `delivered_unpaid` — the merchant produced the goods after a synchronous
 *   purchase whose settle then failed. Rare, open, and closed by the agent
 *   repeating the purchase; no second fulfillment is ever asked for.
 * - `unfulfilled` — the original payment settled and no delivery is recorded.
 *   It remains open to late fulfillment until the merchant closes it.
 * - `fulfillment_closed` — Agentify will perform no further fulfillment.
 *   The original payment outcome is independent of this state.
 * - `failed` — the merchant's handler refused a purchase whose money had not
 *   moved. The agent sees a refusal; the merchant's own metrics can still tell
 *   this apart from a purchase that never reached his handler.
 * - `rejected` — closed before the merchant's handler ever saw the order: no
 *   stock, a payment that did not pass verification, a silent price check on a
 *   card whose money moves on purchase.
 * - `expired` — a deadline ran out. Free for the agent in every case it can
 *   reach, because every deadline whose expiry would leave money taken sends
 *   the order to `unfulfilled` instead.
 */
export const ORDER_STATES = [
  "created",
  "quoted",
  "paid",
  "dispatched",
  "fulfilled",
  "delivered",
  "delivered_unpaid",
  "unfulfilled",
  "fulfillment_closed",
  "failed",
  "rejected",
  "expired",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

/**
 * Orders that can still progress through Agentify. `unfulfilled` allows late
 * delivery; `delivered_unpaid` allows payment against goods already held.
 */
export const OPEN_ORDER_STATES = [
  "created",
  "quoted",
  "paid",
  "dispatched",
  "fulfilled",
  "unfulfilled",
  "delivered_unpaid",
] as const;

/** The states in which Agentify no longer expects fulfillment. */
export const CLOSED_ORDER_STATES = [
  "delivered",
  "fulfillment_closed",
  "failed",
  "rejected",
  "expired",
] as const;

export function isOpen(state: OrderState): boolean {
  return (OPEN_ORDER_STATES as readonly OrderState[]).includes(state);
}

/**
 * The endings that hold nothing for the buyer: no goods kept for them and, on
 * every one but a `rejected` order whose charge went unanswered, no money taken.
 * An `expired` order is one only while it holds no goods its buyer could still
 * pay to collect.
 */
export function endedWithNothingHeld(order: Order): boolean {
  switch (order.state) {
    case "failed":
    case "rejected":
      return true;
    case "expired":
      return !order.heldFulfillment;
    default:
      return false;
  }
}

/**
 * When the payment is executed. This is the switch that turns the three modes
 * into one machine.
 *
 * `after_fulfillment` is the literal reading of "refusal before the charge":
 * the payment is verified, the order goes to the merchant, the goods come
 * back, and only then does the money move. `on_purchase` moves the money
 * before the merchant is asked anything at all.
 */
const SETTLE_TIMINGS = ["on_purchase", "after_fulfillment"] as const;

type SettleTiming = (typeof SETTLE_TIMINGS)[number];

/**
 * The switches of a card. When the money moves is the first. A parcel the
 * merchant hands to a carrier is the second, recorded at
 * purchase so a card republished in another mode changes no order in flight. It
 * adds the buyer's address, which the order holds only until the merchant has
 * it (`holdsShipTo`). Its money moves as the asynchronous mode's does, and the
 * type allows it nowhere else: a synchronous order keeps finished goods for a
 * repeat of the purchase, and that repeat would bring an erased address back to
 * an order that had let it go. The field is present only on a parcel, so a
 * stored order without it reads as not a parcel.
 */
export type OrderMode =
  | { readonly settle: SettleTiming; readonly parcel?: never }
  | { readonly settle: "on_purchase"; readonly parcel: true };

/** The modes a card can declare. */
export const FULFILLMENT_MODES = ["sync", "async", "ship"] as const;

export type FulfillmentMode = (typeof FULFILLMENT_MODES)[number];

export function modeOf(fulfillment: FulfillmentMode): OrderMode {
  switch (fulfillment) {
    case "sync":
      return { settle: "after_fulfillment" };
    case "async":
      return { settle: "on_purchase" };
    case "ship":
      // Goods handed to a carrier: the money moves as the asynchronous mode's
      // does, and the order holds the buyer's address until the merchant has
      // it.
      return { settle: "on_purchase", parcel: true };
    default:
      return assertNever(fulfillment, "fulfillment mode");
  }
}

/**
 * How far the payment has got.
 *
 * Verification and execution are two steps and the machine leans on the gap
 * between them: in the synchronous mode the money is verified before the order
 * goes out and executed after the goods come back.
 *
 * `settling` is the window between sending the payment for execution and
 * hearing back, and it is the only stage in which the machine genuinely does
 * not know where the buyer's money is. It exists so that nothing can close the
 * order as free on a guess: the seconds it lasts are exactly the seconds in
 * which a refusal or a timer would otherwise tell a buyer his
 * purchase never happened while his money was already on its way.
 */
export const PAYMENT_STAGES = [
  "none",
  "verified",
  "settling",
  /**
   * The execution was asked for and never reported back. The money may have
   * moved and may not, and the machine cannot tell — so it says so, and above
   * all it does not send a second charge on top of a first one whose fate is
   * unknown. Only the payment layer ends this stage, by finally answering; it
   * owns that fact and the machine will not invent it.
   */
  "outcome_unknown",
  "settled",
  "settle_failed",
] as const;

type PaymentStage = (typeof PAYMENT_STAGES)[number];

/**
 * A sum of money and the instant the price it came from was true at. The
 * amount is a decimal string: money never becomes a float on the way through
 * this package.
 */
export type Price = {
  readonly amount: string;
  readonly currency: string;
  readonly asOf: number;
};

/**
 * Where the price of this order came from. A snapshot price is the card's own
 * number, used when the card has no price check at all and when a price check
 * went silent on a card whose money moves after the merchant's live answer.
 */
const QUOTE_SOURCES = ["card_snapshot", "merchant_answer"] as const;

export type QuoteSource = (typeof QUOTE_SOURCES)[number];

/** Why a payment did not pass verification. */
export const PAYMENT_VERIFICATION_FAILURES = [
  "signature",
  "insufficient_funds",
  "price_stale",
] as const;

export type PaymentVerificationFailure = (typeof PAYMENT_VERIFICATION_FAILURES)[number];

/**
 * The refusal codes the platform reads the same way everywhere. The set is
 * open — a merchant may send his own code when none of these fits — and the
 * availability metric is fed by `out_of_stock`.
 */
export const RECOMMENDED_REFUSAL_CODES = [
  "out_of_stock",
  "invalid_params",
  "cannot_fulfill",
] as const;

/**
 * Every waiting has a deadline and an owner of that deadline.
 *
 * `quote_response`, `quote_expiry`, `settle_response` and `sync_response` are
 * ours, one number each for the whole system. `async_fulfillment` is the
 * merchant's, declared on the card and visible to the agent before the
 * purchase.
 *
 * The two about the price are not the same waiting. `quote_response` bounds
 * how long we wait for the merchant to say what the goods cost; running out of
 * it is his silence, and silence is answered by mode, not by closing the
 * order. `quote_expiry` bounds how long an answer that did arrive stays good.
 */
export const DEADLINE_KINDS = [
  "quote_response",
  "quote_expiry",
  "settle_response",
  "sync_response",
  "async_fulfillment",
] as const;

export type DeadlineKind = (typeof DEADLINE_KINDS)[number];

type DeadlinePolicy = {
  /**
   * Ours: how long we wait for the merchant to answer what the goods cost and
   * whether they exist. Running out of it is the merchant's silence, answered
   * per mode rather than by closing the order, which is why it is a different
   * number from `quoteTtlMs` and a different deadline from `quote_expiry`.
   */
  readonly quoteResponseMs: number;
  /** Ours: how long a price that has been answered stays good. */
  readonly quoteTtlMs: number;
  /**
   * Ours: how long the machine waits to be told whether the charge went
   * through. A silent charge is a closed failure, and a closed failure needs a
   * moment at which it is declared.
   *
   * The gateway has to check the composition: in the synchronous mode the
   * agent's real worst case is `syncResponseMs + settleResponseMs`, because the
   * goods come back on the first clock and the money moves on the second. The
   * portal promises the agent one ceiling, so the two numbers together must fit
   * inside it.
   */
  readonly settleResponseMs: number;
  /**
   * Ours: how long the merchant has to answer with the goods themselves. See
   * `settleResponseMs` for the sum the two of them have to stay under.
   */
  readonly syncResponseMs: number;
  /** The merchant's, from the card: how long he may take to fulfill. */
  readonly asyncFulfillmentMs: number;
};

/**
 * How an undelivered order is redelivered. An exception in the handler, a dead
 * process and a broken connection are all the same thing — the answer never
 * came back — and they are answered with another delivery, not with a refusal.
 */
export type RedeliveryPolicy = {
  readonly baseDelayMs: number;
  readonly factor: number;
  readonly maxDelayMs: number;
  readonly maxAttempts: number;
};

export type OrderPolicy = {
  readonly deadlines: DeadlinePolicy;
  readonly redelivery: RedeliveryPolicy;
};

/** A deadline that is currently running, with the instant it runs out at. */
export type Deadline = {
  readonly kind: DeadlineKind;
  readonly at: number;
};

/** Why an order stopped where it stopped. */
export type Closure =
  | { readonly cause: "unavailable" }
  | { readonly cause: "quote_silent" }
  | { readonly cause: "payment_not_verified"; readonly reason: PaymentVerificationFailure }
  /** The payment layer said the charge did not go through. */
  | { readonly cause: "payment_not_settled" }
  /**
   * The payment layer never said anything at all. The purchase is closed
   * because a silent charge is a closed failure, but that is a guess that the
   * money did not move, and it must be a different word from the case where the
   * money is known not to have moved: a dispute, an error text and the
   * merchant's reconciliation all read this field.
   */
  | { readonly cause: "payment_outcome_unknown" }
  | { readonly cause: "merchant_refused"; readonly code: string; readonly message: string }
  | { readonly cause: "deadline_expired"; readonly deadline: DeadlineKind };

/**
 * What the merchant is told about without having asked: the cases his side
 * would otherwise learn about only by reconciling by hand.
 */
export const MERCHANT_EVENTS = [
  "order.unfulfilled",
  "order.payment_failed_after_delivery",
] as const;

type MerchantEvent = (typeof MERCHANT_EVENTS)[number];

/**
 * What the merchant's own call gets back. Errors here are returned, never
 * thrown, and say whether repeating the call could change anything.
 *
 * These are the wire's words, and `wire-alignment.test.ts` holds the two lists
 * to each other so the gateway can hand one straight across as the other.
 * Taking an order on is a success with its own word, `accepted`: anything short
 * of saying so reaches the merchant as a fault in an order that is going
 * through.
 */
export const MERCHANT_ANSWER_RESULTS = [
  "accepted",
  "delivered",
  "already_delivered",
  "delivered_late",
  "refused",
  "purchase_already_closed",
] as const;

type MerchantAnswerResult = (typeof MERCHANT_ANSWER_RESULTS)[number];

export const MERCHANT_ANSWER_ERRORS = [
  "fulfillment_closed",
  "fulfillment_complete",
  "nothing_to_close",
  "order_already_closed",
  "not_applicable_in_mode",
] as const;

export type MerchantAnswerError = (typeof MERCHANT_ANSWER_ERRORS)[number];

export type MerchantAnswer =
  | { readonly ok: true; readonly result: MerchantAnswerResult }
  | { readonly ok: false; readonly error: MerchantAnswerError; readonly retryable: boolean };

/**
 * What the gateway is asked to do once a transition has happened. These are
 * descriptions, not actions: this package performs no IO, and the interpreter
 * lives outside it.
 */
export type Effect =
  | { readonly kind: "request_quote" }
  | { readonly kind: "verify_payment" }
  | { readonly kind: "execute_payment" }
  | { readonly kind: "dispatch_order" }
  | { readonly kind: "redeliver_order"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "release_goods_to_agent" }
  | { readonly kind: "issue_receipt" }
  | { readonly kind: "hold_fulfillment" }
  | { readonly kind: "mark_unfulfilled"; readonly closure: Closure }
  | { readonly kind: "emit_merchant_event"; readonly event: MerchantEvent }
  | { readonly kind: "answer_merchant"; readonly answer: MerchantAnswer }
  /**
   * The buyer's address is no longer needed from us: erase it from the order
   * and from every envelope that carries it. Said once per parcel, on the
   * transition where `holdsShipTo` stops being true.
   */
  | { readonly kind: "erase_ship_to" };

/**
 * Whether this order still holds a buyer's address.
 *
 * Only a parcel ever holds one, and it holds it from the priced request until
 * the first of four moments: the merchant takes the order on (they store the
 * address before answering `accepted`), its shipment is recorded, it closes, or
 * it becomes unfulfilled without having been taken on. Each leaves
 * the order closed, unfulfilled or taken on, so the rule is read off the
 * order rather than kept beside it. It only ever goes from true to false
 * because a parcel's money moves first (`OrderMode`): no repeat of the purchase
 * reopens such an order, and an acceptance, once given, stays.
 */
export function holdsShipTo(order: Order): boolean {
  return (
    order.mode.parcel === true &&
    isOpen(order.state) &&
    order.state !== "unfulfilled" &&
    !order.dispatch.accepted
  );
}

/**
 * Everything that can happen to an order from outside the core: the agent's
 * moves, the payment layer's outcomes, the merchant handler's answers, his
 * separate calls, and the expiry of a deadline.
 *
 * `handler_undelivered` is the one that carries no answer at all — an
 * exception, a dead process, a broken connection. The machine answers it with
 * another delivery, because a refusal means "this cannot be fulfilled" and
 * closes the order for good — unless the merchant has already taken the order
 * on, and the silence is only his answer coming later than we waited.
 */
export type OrderEvent =
  | {
      readonly kind: "quote_answered";
      readonly at: number;
      readonly available: true;
      readonly price: Price;
    }
  | { readonly kind: "quote_answered"; readonly at: number; readonly available: false }
  | { readonly kind: "quote_silent"; readonly at: number }
  | { readonly kind: "payment_verified"; readonly at: number }
  | {
      readonly kind: "payment_verification_failed";
      readonly at: number;
      readonly reason: PaymentVerificationFailure;
    }
  | { readonly kind: "payment_settled"; readonly at: number }
  | { readonly kind: "payment_settle_failed"; readonly at: number }
  | { readonly kind: "purchase_repeated"; readonly at: number }
  | { readonly kind: "order_dispatched"; readonly at: number }
  | { readonly kind: "handler_accepted"; readonly at: number }
  | { readonly kind: "handler_delivered"; readonly at: number }
  | {
      readonly kind: "handler_refused";
      readonly at: number;
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: "handler_undelivered"; readonly at: number }
  | { readonly kind: "deliver_called"; readonly at: number }
  | {
      readonly kind: "refuse_called";
      readonly at: number;
      readonly code: string;
      readonly message: string;
    }
  | { readonly kind: "close_called"; readonly at: number; readonly message?: string }
  | { readonly kind: "deadline_expired"; readonly at: number; readonly deadline: DeadlineKind };

export type OrderEventKind = OrderEvent["kind"];

/**
 * The same list as a value, for everything that has to walk every pairing of a
 * state and an event. It is built out of a record keyed by the union itself,
 * so an event kind added to the type and forgotten here stops the build.
 */
const EVENT_KIND_INDEX: Record<OrderEventKind, true> = {
  quote_answered: true,
  quote_silent: true,
  payment_verified: true,
  payment_verification_failed: true,
  payment_settled: true,
  payment_settle_failed: true,
  purchase_repeated: true,
  order_dispatched: true,
  handler_accepted: true,
  handler_delivered: true,
  handler_refused: true,
  handler_undelivered: true,
  deliver_called: true,
  refuse_called: true,
  close_called: true,
  deadline_expired: true,
};

export const ORDER_EVENT_KINDS = Object.keys(EVENT_KIND_INDEX) as readonly OrderEventKind[];

/**
 * Everything that can happen to an order except a deadline running out. The
 * expiry of a deadline is answered once, centrally, because a deadline that is
 * not currently running may not close an order in any state whatsoever.
 */
export type StateEvent = Exclude<OrderEvent, { kind: "deadline_expired" | "close_called" }>;

/** When each step of the order happened. Written from the events, never read
 * from a clock. */
type OrderTimestamps = {
  readonly createdAt: number;
  readonly quotedAt: number | null;
  /** When the payment was last sent for execution. */
  readonly settleStartedAt: number | null;
  /**
   * When the order entered `paid`. Where the money moves at the purchase this
   * is when it moved; where it moves after the goods this is when the payment
   * was verified.
   */
  readonly paidAt: number | null;
  readonly dispatchedAt: number | null;
};

export type Order = {
  readonly id: string;
  readonly state: OrderState;
  readonly mode: OrderMode;
  readonly policy: OrderPolicy;
  readonly payment: PaymentStage;
  /** The card's own price, kept for the modes where a silent price check still
   * sells. */
  readonly cardPrice: Price;
  /** The price this order is being sold at, once there is one. */
  readonly price: Price | null;
  readonly quoteSource: QuoteSource | null;
  /**
   * How many times the order has been handed to its merchant, and whether one
   * of those hand-overs was taken on.
   *
   * `attempts` is what the backoff and the attempt cap count off. `accepted`
   * tells an order handed over from one already taken on, since `dispatched`
   * covers both. Once it is true, a silence noticed about the order spends no
   * delivery: the merchant has answered, perhaps later than we waited. A repeat
   * already on his stream is still handed over and counted, except on a parcel,
   * whose address went with the acceptance.
   *
   * Only the asynchronous mode takes an order on, with the goods following
   * through the `deliver` call; a synchronous handler that does is refused for
   * its mode, so the flag is never set on a synchronous order. It is written
   * false on the way into each round (the order once paid, the order once
   * handed over from `paid`) and set only by an acceptance in
   * `dispatched`, so it stays true for the rest of the order's life there.
   */
  readonly dispatch: { readonly attempts: number; readonly accepted: boolean };
  /**
   * The merchant produced the goods for a purchase that was already closed —
   * he started before the deadline and finished after it. The work is not
   * lost: a repeat of the purchase picks it up, this time with the payment.
   */
  readonly heldFulfillment: boolean;
  readonly closure: Closure | null;
  /**
   * The merchant's closure of fulfillment: when, and their optional words.
   * `paymentCompletedAt` is when a payment that was unresolved at closure
   * completed afterwards. It marks the order as waiting for the merchant to
   * close it again, which records a new closure without it.
   */
  readonly merchantClosure?: {
    readonly at: number;
    readonly message?: string;
    readonly paymentCompletedAt?: number;
  };
  readonly test: boolean;
  readonly timestamps: OrderTimestamps;
};

/**
 * Why a transition did not happen.
 *
 * - `event_not_applicable` — this event has no meaning in this state. A stale
 *   message off the queue, or a bug. Sending it again changes nothing.
 * - `deadline_not_armed` — a timer fired for a deadline that is not running.
 *   The list to schedule from is `deadlines(order)`.
 * - `deadline_not_yet_due` — a timer fired early, or fired twice. Rescheduling
 *   off `deadlines(order)` is the fix; re-sending the same expiry is not.
 * - `settle_in_flight` — a charge is being executed, or the outcome of one
 *   that was is still unknown. Either way the machine will not spend the
 *   buyer's money again on top of it, and this is the one rejection that means
 *   "come back later" rather than "no".
 * - `currency_changed` — the merchant's price check answered in a currency the
 *   card does not carry. A quote moves the number; the unit is the card's, and
 *   nothing here converts between units. Sending the same answer again gives
 *   the same refusal, and what clears it is a quote in the card's own currency.
 */
const TRANSITION_REJECTION_CODES = [
  "event_not_applicable",
  "deadline_not_armed",
  "deadline_not_yet_due",
  "settle_in_flight",
  "currency_changed",
] as const;

export type TransitionRejectionCode = (typeof TRANSITION_REJECTION_CODES)[number];

/**
 * A refusal, shaped like the answers the merchant's own calls get: returned,
 * never thrown, and saying whether sending the event again could change
 * anything.
 *
 * `retryable` is an instruction to the interpreter, and the interpreter is
 * expected to follow it: a retryable rejection is re-sent once the thing it is
 * waiting on has happened. Nothing else in this package keeps a queue of
 * refused events, so an interpreter that drops them loses the event.
 */
export type TransitionRejection = {
  readonly code: TransitionRejectionCode;
  readonly retryable: boolean;
  readonly state: OrderState;
  readonly event: OrderEventKind;
  readonly message: string;
};

export type TransitionResult =
  | { readonly ok: true; readonly order: Order; readonly effects: readonly Effect[] }
  | { readonly ok: false; readonly rejection: TransitionRejection };
