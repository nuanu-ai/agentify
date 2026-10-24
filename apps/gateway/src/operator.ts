/**
 * The operator's reader, for the dashboard's admin services alone: the reads
 * that cross merchants, on Postgres inside read-only transactions with a
 * bounded statement time, and in memory for tests. No gateway route imports
 * this module, and in the dashboard only the admin services and the code that
 * builds them do (`operator-reach.test.ts`).
 */

export { memoryOperatorReader } from "./adapters/memory/operator/index.js";
export { postgresOperatorReader } from "./adapters/postgres/operator/index.js";
export { checkFacilitatorKey, type FacilitatorKeyCheck } from "./facilitator-key-check.js";
export { type GatewayHealthFacts, gatewayHealthFacts } from "./health-facts.js";
export {
  checkListingNow,
  type ListingCheck,
  overTheNetwork,
  type Reach,
} from "./listing-check.js";
export { type PayoutListing, payoutListing } from "./payout-listing.js";
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
  UnknownPayments,
  WaitingForAdmission,
  Workers,
} from "./ports/operator/figures.js";
export { CHART_DAYS } from "./ports/operator/figures.js";
export type {
  MoneyHistory,
  OperatorFigures,
  OperatorOrders,
  OperatorReader,
} from "./ports/operator/index.js";
export { lookupOf } from "./ports/operator/lookup.js";
export {
  askedOn,
  MERCHANT_SEGMENTS,
  type MerchantList,
  type MerchantRecord,
  type MerchantRow,
  type MerchantSegment,
} from "./ports/operator/merchants.js";
export { dollarsOf, microsOf } from "./ports/operator/money.js";
export type {
  Found,
  OperatorOrder,
  OperatorOrderRow,
  OrderMerchant,
  OrderSegment,
  OrderStep,
  OrdersCursor,
  OrdersPage,
  OrdersShown,
} from "./ports/operator/orders.js";
export type { Splits } from "./ports/operator/splits.js";
