/**
 * The operator's reader: every read that crosses merchants, for the operator's
 * workspace alone. Each area of the workspace has its file here with the reads
 * it needs. Every read runs inside a read-only transaction with a bounded
 * statement time, so a page of the workspace can neither change anything nor
 * hold the database; a read that fails throws, and the page says the figure
 * could not be read rather than drawing a zero.
 *
 * Nothing a merchant's key or a buyer reaches is handed this reader: the
 * gateway's routes are built without it, and the dashboard hands it only to
 * its admin services, behind the operator flag. `operator-reach.test.ts`
 * holds which modules may import it.
 */

import type { OperatorAccounts } from "./accounts.js";
import type { OperatorFigures } from "./figures.js";
import type { OperatorMerchants } from "./merchants.js";
import type { OperatorOrders } from "./orders.js";
import type { OperatorSplits } from "./splits.js";

export type { MoneyHistory } from "./accounts.js";
export type { OperatorFigures } from "./figures.js";
export type { OperatorOrders } from "./orders.js";

export interface OperatorReader {
  readonly merchants: OperatorMerchants;
  readonly orders: OperatorOrders;
  readonly figures: OperatorFigures;
  readonly splits: OperatorSplits;
  readonly accounts: OperatorAccounts;
}
