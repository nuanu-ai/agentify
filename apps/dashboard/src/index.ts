/**
 * The Agentify merchant dashboard: the cards with their pause, the orders, the
 * receipts and the keys, rendered on the server, behind a sign-in that knows
 * who a person is — and a registration that makes the merchant behind it.
 *
 * It runs in one process with the gateway, on a listener of its own, and calls
 * the gateway's application there as the merchant on the signed-in account's
 * row (ADR-0030), with requests and answers held to the contract's schemas.
 *
 * Its identity tables are its own: the people who sign in, their sessions,
 * one-time links and privacy-bounded send evidence. The component's credential
 * table remains empty after password removal. None of that is a merchant's
 * catalogue data and no public API carries it. One column on the person names
 * the merchant that account acts for, which is what makes two accounts here
 * two merchants rather than two people looking at one.
 */

export { runAccount, type Terminal } from "./account-command.js";
export { type DashboardConfig, loadConfig } from "./config.js";
export { connect, migrateAccounts } from "./database.js";
export {
  type Acting,
  type Answer,
  type GatewayClient,
  gatewayFor,
  type Registrar,
  registrarFor,
} from "./gateway.js";
export {
  type AccountMerchant,
  type AccountSummary,
  type AttachMerchantResult,
  type DashboardDestination,
  type DashboardIdentity,
  type DashboardLinkResult,
  emailAs,
  type Identity,
  type IdentityParts,
  identityFor,
  type LinkRequestResult,
  type Person,
} from "./identity.js";
export { keysScreen, newKeyScreen } from "./keys.js";
export {
  type Handover,
  isSandboxMail,
  type Message,
  type Postman,
  postmanFor,
  SANDBOX_MAIL,
} from "./mail.js";
export { cardsScreen, ordersScreen, receiptsScreen, type Viewer } from "./screens.js";
export { chooseNameScreen, settingsScreen } from "./seller-name.js";
export { buildApp, type DashboardParts } from "./server.js";
export {
  FULFILLMENT_WORDS,
  moment,
  money,
  NEEDS_ATTENTION,
  needsAttention,
  ORDER_WORDS,
  SELLING_WORDS,
  type Tone,
  type Word,
} from "./words.js";
