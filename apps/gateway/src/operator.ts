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
export { type Lookup, lookupOf } from "./ports/operator/lookup.js";
export type { Dollars, Tally } from "./ports/operator/money.js";
export type {
  AgentReads,
  Found,
  MerchantReads,
  OperatorOrder,
  OperatorOrderRow,
  OrderAmount,
  OrderAttempt,
  OrderMerchant,
  OrderPayment,
  OrderProduct,
  OrderSegment,
  OrderStep,
  OrdersCursor,
  OrdersPage,
  OrdersQuery,
  OrdersShown,
  SaidWord,
  Withheld,
} from "./ports/operator/orders.js";
export { ORDER_SEGMENTS, ORDERS_PAGE } from "./ports/operator/orders.js";
export type { SplitRow, Splits } from "./ports/operator/splits.js";
export { SPLITS_LISTED_AT_MOST } from "./ports/operator/splits.js";
