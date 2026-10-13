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
export { connect, PostgresStore } from "./adapters/postgres/store.js";
export { X402Facilitator } from "./adapters/x402/facilitator.js";
export { type Caller, Gateway, type WalletChangeRefusal } from "./app/gateway.js";
export {
  grantLiveApproval,
  issueKey,
  SEEDED_MERCHANT,
  seedSandboxKey,
  setPayoutWallet,
} from "./app/merchants.js";
export type { Runtime } from "./app/runtime.js";
export { openCommandApplication } from "./command-application.js";
export { type GatewayConfig, loadConfig } from "./config.js";
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
export { buildApp, hold } from "./http/server.js";
export { PaymentEdge } from "./http/x402.js";
export { nobodyAnnounces } from "./ports/announcer.js";
export { randomIds, systemClock } from "./ports/clock.js";
export type { Facilitator } from "./ports/facilitator.js";
export type { Integration, StoredOrder } from "./ports/store.js";
