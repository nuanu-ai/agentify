/**
 * The commerce domain core: orders and their state machine. It does no I/O and
 * has no runtime dependencies; everything external comes in as parameters and
 * goes out as values.
 */

/**
 * The exhaustiveness guard for the default branch of a `switch`: a new variant
 * breaks the build on this line instead of an order nobody handled in
 * production. A value that fooled the types, read from the database or the
 * network, throws with the variant named rather than passing silently.
 */
export function assertNever(value: never, context?: string): never {
  const where = context === undefined ? "" : ` (${context})`;
  throw new Error(`Unhandled variant${where}: ${JSON.stringify(value)}`);
}

export type { Environment, SurfaceMode } from "./deployment/environment.js";
export {
  CDP_FACILITATOR_URL,
  environmentOf,
  environmentOfKeyPrefix,
  isSandboxFacilitator,
  isTestnetChain,
  keyPrefixFor,
  LIVE_CHAINS,
  PUBLIC_X402_FACILITATOR_URL,
  SANDBOX_FACILITATOR,
  SITES,
  SURFACE_MARKER_ATTRIBUTE,
  SURFACE_WORDS,
  surfaceModeOf,
  TESTNET_CHAINS,
} from "./deployment/environment.js";
export type { MerchantFacts, Readiness, Unknown } from "./merchant/readiness.js";
export { readinessOf, UNKNOWN } from "./merchant/readiness.js";
/**
 * The order state machine. The gateway builds an order with `createOrder`,
 * feeds it events with `transition`, runs the effects that come back, schedules
 * timers off `deadlines`, answers the agent with `outcomeFor`, and may check an
 * order before writing it down with `moneyInvariantViolations`.
 */
export type {
  CreateOrderInput,
  CreateOrderResult,
  CreateRejection,
  MerchantSelling,
  PriceCheck,
} from "./orders/create.js";
export { CREATE_REJECTIONS, createOrder, MERCHANT_SELLING, PRICE_CHECKS } from "./orders/create.js";
export { deadlines, fulfillmentDeadline } from "./orders/deadlines.js";
export { transition } from "./orders/machine.js";
export type {
  Closure,
  Deadline,
  DeadlineKind,
  DeadlinePolicy,
  Effect,
  FulfillmentMode,
  MerchantAnswer,
  MerchantAnswerError,
  MerchantAnswerResult,
  MerchantEvent,
  Order,
  OrderEvent,
  OrderEventKind,
  OrderMode,
  OrderPolicy,
  OrderState,
  OrderTimestamps,
  PaymentStage,
  PaymentVerificationFailure,
  Price,
  QuoteSource,
  RedeliveryPolicy,
  SettleTiming,
  StateEvent,
  TransitionRejection,
  TransitionRejectionCode,
  TransitionResult,
} from "./orders/model.js";
export {
  CLOSED_ORDER_STATES,
  DEADLINE_KINDS,
  endedWithNothingHeld,
  FULFILLMENT_MODES,
  holdsShipTo,
  isOpen,
  MERCHANT_ANSWER_ERRORS,
  MERCHANT_ANSWER_RESULTS,
  MERCHANT_EVENTS,
  modeOf,
  OPEN_ORDER_STATES,
  ORDER_EVENT_KINDS,
  ORDER_STATES,
  PAYMENT_STAGES,
  PAYMENT_VERIFICATION_FAILURES,
  QUOTE_SOURCES,
  RECOMMENDED_REFUSAL_CODES,
  SETTLE_TIMINGS,
  TRANSITION_REJECTION_CODES,
} from "./orders/model.js";
export { moneyInvariantViolations } from "./orders/money.js";
export type { EndingReason, OrderOutcome } from "./orders/outcome.js";
export {
  ENDING_REASONS,
  endingReasonFor,
  ORDER_OUTCOMES,
  onTheMerchantsOpenList,
  outcomeFor,
} from "./orders/outcome.js";
