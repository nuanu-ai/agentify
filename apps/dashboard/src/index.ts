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
export {
  type Handover,
  isSandboxMail,
  type Message,
  type Postman,
  postmanFor,
  SANDBOX_MAIL,
} from "./mail.js";
export type { Viewer } from "./screens.js";
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
