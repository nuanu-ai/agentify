/**
 * The operator's figures and splits in memory. What they promise is written
 * once, in `testing/operator-figures-contract.ts`, and run here and against
 * Postgres, so the memory reader the dashboard's tests draw with cannot say
 * something the channel's own database would not.
 */

import { countedIds } from "../../../testing/harness.js";
import { describeOperatorFigures } from "../../../testing/operator-figures-contract.js";
import { MemoryStore } from "../store.js";
import { memoryOperatorReader } from "./index.js";

describeOperatorFigures("the operator's figures in memory", async () => {
  const store = new MemoryStore("eip155:84532", countedIds());
  return { store, reader: memoryOperatorReader(store) };
});
