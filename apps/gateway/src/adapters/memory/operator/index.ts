/**
 * The operator's reader in memory, for tests: every area's reads over the
 * memory store's holdings, answering as the Postgres reader does over the
 * same rows. It reads only; nothing here can write to the store.
 */

import type { OperatorReader } from "../../../ports/operator/index.js";
import type { MemoryStore } from "../store.js";
import { memoryOperatorAccounts } from "./accounts.js";
import { memoryOperatorFigures } from "./figures.js";
import { memoryOperatorMerchants } from "./merchants.js";
import { memoryOperatorOrders } from "./orders.js";
import { memoryOperatorSplits } from "./splits.js";

/** What every area's memory reads are built over: what the store holds when a read asks. */
export type MemoryScope = Readonly<{
  holdings: MemoryStore["holdings"];
  network: string;
}>;

export function memoryOperatorReader(store: MemoryStore): OperatorReader {
  const scope: MemoryScope = { holdings: () => store.holdings(), network: store.network };
  return {
    merchants: memoryOperatorMerchants(scope),
    orders: memoryOperatorOrders(scope),
    figures: memoryOperatorFigures(scope),
    splits: memoryOperatorSplits(scope),
    accounts: memoryOperatorAccounts(scope),
  };
}
