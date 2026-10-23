/**
 * The operator's orders reads in memory, held to the same contract the
 * Postgres reader runs under `pnpm test:db`.
 */

import { describeOperatorOrders } from "../../../testing/operator-orders-contract.js";
import { MemoryStore } from "../store.js";
import { memoryOperatorReader } from "./index.js";

const counted = () => {
  let issued = 0;
  return (kind: string) => {
    issued += 1;
    return `${kind}_${issued}`;
  };
};

describeOperatorOrders("the operator's orders in memory", async () => {
  const store = new MemoryStore("eip155:84532", counted());
  return { store, orders: memoryOperatorReader(store).orders };
});
