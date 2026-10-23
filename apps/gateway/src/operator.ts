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
export type {
  OperatorFigures,
  OperatorMerchants,
  OperatorOrders,
  OperatorReader,
  OperatorSplits,
} from "./ports/operator/index.js";
export { paymentUnknown } from "./ports/operator/index.js";
