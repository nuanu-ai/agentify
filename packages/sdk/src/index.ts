/**
 * The Agentify merchant SDK: what a merchant's engineer installs so that their
 * catalog sells to agents.
 *
 * `createClient` builds a handle on the gateway from a key and an address.
 * Through it a merchant says what their process answers with `on`, opens one
 * outgoing subscription that carries paid orders, price questions and order
 * events together, and closes orders they took on earlier. `checkCard` is the
 * check a merchant runs on their own cards before publishing them; the package
 * also installs it as the `agentify verify` command.
 *
 * Every call that can fail answers in one envelope: `ok` says which, and a
 * failure carries one `error` with a code, a sentence, whether repeating could
 * help, and the findings under `problems` where the call refuses what it was
 * handed. A call with no such branch throws `AgentifyError` instead, under the
 * same codes.
 *
 * The runtime dependencies are `@nuanu-ai/agentify-contracts` and zod beneath
 * it, and nothing else. The types an integration is written against — a card,
 * an order, a handler's answer — are re-exported here, so integration code
 * needs one import.
 */

export type {
  CallError,
  Card,
  CardInput,
  Delivery,
  Fulfillment,
  HandlerAnswer,
  MerchantClosure,
  MerchantFinding,
  Money,
  Order,
  OrderCloseRequest,
  OrderCloseResponse,
  Problem,
  PublishResult,
  QuotePurpose,
  QuoteRequest,
  QuoteResponse,
  Refusal,
  RefusalCode,
  SalePrice,
  Shipment,
  ShipTo,
} from "@nuanu-ai/agentify-contracts";
export {
  CARD_REJECTED,
  MERCHANT_FINDINGS,
  ORDER_EVENT_TYPES,
  RECOMMENDED_REFUSAL_CODES,
} from "@nuanu-ai/agentify-contracts";
export type { CardCheck } from "./check-card.js";
export { checkCard } from "./check-card.js";
export type {
  AgentifyClient,
  CatalogNamespace,
  ClientOptions,
  HandlerKind,
  Handlers,
  LiveOrder,
  LiveOrderWithStatus,
  LiveQuoteRequest,
  OrderCalls,
  OrderHandle,
  OrderHandler,
  OrdersNamespace,
  QuoteCalls,
  QuoteHandler,
} from "./client.js";
export {
  AgentifyError,
  ANSWER_NOT_UNDERSTOOD,
  CALL_DID_NOT_REACH_US,
  createClient,
  OUTCOME_UNKNOWN,
} from "./client.js";
export { contractVersion, speaksContract } from "./contract.js";
export type {
  OrderCallResponse,
  OrderCallResult,
  OrderEvent,
  OrderList,
  OrderStatus,
  OrderWithStatus,
  PaymentStatus,
} from "./reading.js";
export type {
  Delivered,
  EventHandler,
  ProblemReporter,
  WorkerProblem,
  WorkerProblemKind,
} from "./worker.js";
export { WORKER_PROBLEM_KINDS } from "./worker.js";
