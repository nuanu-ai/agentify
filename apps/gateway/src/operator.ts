/**
 * The operator's reader, for the dashboard's admin services alone: the reads
 * that cross merchants, on Postgres inside read-only transactions with a
 * bounded statement time, and in memory for tests. No gateway route imports
 * this module, and in the dashboard only the admin services and the code that
 * builds them do (`operator-reach.test.ts`).
 */

export { memoryOperatorReader } from "./adapters/memory/operator/index.js";
export { postgresOperatorReader } from "./adapters/postgres/operator/index.js";
export { OPERATOR_STATEMENT_MS } from "./adapters/postgres/operator/read-only.js";
export { checkFacilitatorKey, type FacilitatorKeyCheck } from "./facilitator-key-check.js";
export { type GatewayHealthFacts, gatewayHealthFacts } from "./health-facts.js";
export {
  checkListingNow,
  type ListingCheck,
  overTheNetwork,
  type Reach,
  type ResourceCheck,
} from "./listing-check.js";
export {
  type PayoutChain,
  type PayoutListing,
  type PayoutPart,
  payoutListing,
} from "./payout-listing.js";
export type {
  AnalyticsOutbox,
  FiguresAsked,
  Funnel,
  FunnelStep,
  MerchantCounts,
  Money,
  MoneyPeriod,
  RecentOrders,
  SalesByDay,
  SalesDay,
  ShopsConnected,
  SilentMerchant,
  UnknownPayments,
  WaitingForAdmission,
  WaitingMerchant,
  Workers,
} from "./ports/operator/figures.js";
export {
  CHART_DAYS,
  FUNNEL_STEPS,
  PERIOD_DAYS,
  RECENT_DAYS,
  SILENT_NAMED_AT_MOST,
  UNKNOWN_MERCHANTS_NAMED_AT_MOST,
  WAITING_NAMED_AT_MOST,
} from "./ports/operator/figures.js";
export type {
  OperatorFigures,
  OperatorMerchants,
  OperatorOrders,
  OperatorReader,
  OperatorSplits,
} from "./ports/operator/index.js";
export { paymentUnknown } from "./ports/operator/index.js";
export {
  askedOn,
  MERCHANT_LIST_MAX,
  MERCHANT_PAGE_CUT,
  MERCHANT_SEGMENTS,
  type MerchantCard,
  type MerchantKey,
  type MerchantList,
  type MerchantListQuery,
  type MerchantRecord,
  type MerchantRow,
  type MerchantSegment,
  type MerchantWallet,
  type OrderWorthALook,
  SELLING_DAYS,
  type SellingDay,
} from "./ports/operator/merchants.js";
export type { Dollars, Tally } from "./ports/operator/money.js";
export type { SplitRow, Splits } from "./ports/operator/splits.js";
export { SPLITS_LISTED_AT_MOST } from "./ports/operator/splits.js";
