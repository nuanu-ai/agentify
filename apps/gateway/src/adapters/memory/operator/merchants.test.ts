/** The operator's reads of merchants in memory, held to the contract the Postgres reader is held to. */

import { describeOperatorMerchants } from "../../../testing/operator-merchants-contract.js";
import { MemoryStore } from "../store.js";
import { memoryOperatorReader } from "./index.js";

let issued = 0;
const ids = (prefix: string): string => {
  issued += 1;
  return `${prefix}_${issued}`;
};

describeOperatorMerchants("the operator's merchants in memory", async () => {
  const store = new MemoryStore("eip155:84532", ids);
  return { store, merchants: memoryOperatorReader(store).merchants };
});
