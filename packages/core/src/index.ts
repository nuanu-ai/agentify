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
  surfaceModeOf,
  TESTNET_CHAINS,
} from "./deployment/environment.js";
export type { Readiness } from "./merchant/readiness.js";
export { readinessOf, UNKNOWN } from "./merchant/readiness.js";
/**
 * The order state machine. The gateway builds an order with `createOrder`,
 * feeds it events with `transition`, runs the effects that come back, schedules
 * timers off `deadlines`, answers the agent with `outcomeFor`, and may check an
 * order before writing it down with `moneyInvariantViolations`.
 */
export type { MerchantSelling } from "./orders/create.js";
export { createOrder } from "./orders/create.js";
export { deadlines, fulfillmentDeadline } from "./orders/deadlines.js";
export { transition } from "./orders/machine.js";
export type {
  Deadline,
  DeadlineKind,
  Effect,
  MerchantAnswer,
  MerchantAnswerError,
  Order,
  OrderEvent,
  OrderMode,
  OrderPolicy,
  OrderState,
  PaymentVerificationFailure,
  StateEvent,
  TransitionRejection,
  TransitionResult,
} from "./orders/model.js";
export { endedWithNothingHeld, holdsShipTo, isOpen, modeOf, ORDER_STATES } from "./orders/model.js";
export { moneyInvariantViolations } from "./orders/money.js";
export type { EndingReason } from "./orders/outcome.js";
export {
  endingReasonFor,
  listedAsOpen,
  onTheMerchantsOpenList,
  outcomeFor,
  paidAfterClosure,
} from "./orders/outcome.js";
