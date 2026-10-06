/**
 * The Agentify merchant cabinet: the cards with their pause, the orders, the
 * receipts and the keys, rendered on the server, behind a sign-in that knows
 * who a person is — and a registration that makes the merchant behind it.
 *
 * It is its own process rather than a part of the gateway, and it reaches the
 * gateway through the same public API a merchant's own tooling uses (ADR-0005
 * §2). Pages for people change for reasons that have nothing to do with money,
 * and the deal is that the money path never pays for that churn — while the
 * cabinet, by being an ordinary consumer of the API, cannot draw a screen the
 * merchant could not have built themselves.
 *
 * Its identity tables are its own: the people who sign in, their sessions,
 * one-time links and privacy-bounded send evidence. The component's credential
 * table remains empty after password removal. None of that is a merchant's
 * catalogue data and no public API carries it. One column on the person is the
 * key that account reaches the gateway with (ADR-0014 §2), which is what makes
 * two accounts here two merchants rather than two people looking at one.
 */

export { runAccount, type Terminal } from "./account-command.js";
export { type CabinetConfig, loadConfig } from "./config.js";
export { connect, migrateAccounts } from "./database.js";
export {
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
  type CabinetDestination,
  type CabinetIdentity,
  type CabinetLinkResult,
  emailAs,
  type Identity,
  type IdentityParts,
  identityFor,
  type LinkRequestResult,
  type MerchantKeyReplacement,
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
export { buildApp, type CabinetParts } from "./server.js";
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
