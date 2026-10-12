/**
 * The Agentify gateway: the 402 edge, the order queue and the receipts. The
 * order machine in `@agentify/core` decides everything about an order; the
 * gateway loads the order, hands it one event, stores what comes back and
 * carries out the effects. The HTTP surface is mounted from the table in
 * `@nuanu-ai/agentify-contracts`, so both sides use the same addresses.
 */

export { ScriptedFacilitator } from "./adapters/memory/facilitator.js";
export { MemoryQueue } from "./adapters/memory/queue.js";
export { MemoryStore } from "./adapters/memory/store.js";
export { PgBossQueue, queueOn } from "./adapters/pgboss/queue.js";
export { connect, PostgresStore } from "./adapters/postgres/store.js";
export { X402Facilitator } from "./adapters/x402/facilitator.js";
export {
  type Caller,
  Gateway,
  type PurchaseAttempt,
  type WalletChangeRefusal,
} from "./app/gateway.js";
export {
  grantLiveApproval,
  type IssuedKey,
  issueKey,
  keyDigest,
  type LiveApprovalGrant,
  newKeySecret,
  SEEDED_MERCHANT,
  type SeedOutcome,
  seedSandboxKey,
  setPayoutWallet,
} from "./app/merchants.js";
export { type Applied, OrderRunner, orderDocumentOf, type PresentResult } from "./app/runner.js";
export {
  modeForCard,
  policyFor,
  priceCheckOf,
  type Runtime,
} from "./app/runtime.js";
export { Waiting } from "./app/waiting.js";
export { type CommandApplication, openCommandApplication } from "./command-application.js";
export {
  type DeadlineConfig,
  type GatewayConfig,
  loadConfig,
  type PaymentConfig,
  type RedeliveryConfig,
  type WorkerConfig,
} from "./config.js";
export {
  bodyRefused,
  CONFLICT,
  merchantDeparted,
  merchantOrderAnswer,
  merchantOrderList,
  NO_SUCH_ITEM,
  NO_SUCH_KEY,
  NO_SUCH_ORDER,
  type Refused,
} from "./http/merchant-answers.js";
export {
  buildApp,
  hold,
  type MountedRoute,
  type RouteAnswer,
  type RouteHandler,
} from "./http/server.js";
export { PaymentEdge, paymentFingerprint, presentedPayment } from "./http/x402.js";
export { type AnnouncementOutcome, type Announcer, nobodyAnnounces } from "./ports/announcer.js";
export { asTimestamp, type Clock, type Ids, randomIds, systemClock } from "./ports/clock.js";
export type { Charge, Facilitator, SettleOutcome, VerifyOutcome } from "./ports/facilitator.js";
export type { DrawnEnvelope, Queue, Reminder } from "./ports/queue.js";
export type {
  CatalogEntry,
  Integration,
  IntegrationSwitch,
  MerchantScope,
  OrderChange,
  OrderLookup,
  PaymentClaim,
  PaymentWord,
  Store,
  StoredCard,
  StoredKey,
  StoredMerchant,
  StoredOrder,
} from "./ports/store.js";
