/**
 * The operator's reader on Postgres. Every read of every area goes through
 * one read-only runner, and a failure leaves it stripped of the values bound
 * to the statement, as the store's do.
 */

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { OperatorReader } from "../../../ports/operator/index.js";
import { failingWithoutValues } from "../../database-failure.js";
import { postgresOperatorAccounts } from "./accounts.js";
import { postgresOperatorFigures } from "./figures.js";
import { postgresOperatorMerchants } from "./merchants.js";
import { postgresOperatorOrders } from "./orders.js";
import { OPERATOR_STATEMENT_MS, readOnlyOn } from "./read-only.js";
import type { OperatorScope } from "./scope.js";
import { postgresOperatorSplits } from "./splits.js";

export function postgresOperatorReader(
  db: NodePgDatabase,
  network: string,
  statementMs: number = OPERATOR_STATEMENT_MS,
): OperatorReader {
  const scope: OperatorScope = { read: readOnlyOn(db, statementMs), network };
  return {
    merchants: failingWithoutValues(postgresOperatorMerchants(scope), "the operator's merchants"),
    orders: failingWithoutValues(postgresOperatorOrders(scope), "the operator's orders"),
    figures: failingWithoutValues(postgresOperatorFigures(scope), "the operator's figures"),
    splits: failingWithoutValues(postgresOperatorSplits(scope), "the operator's splits"),
    accounts: failingWithoutValues(postgresOperatorAccounts(scope), "the operator's accounts"),
  };
}
