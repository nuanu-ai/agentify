/** The registry of payout splits read across merchants, in memory, over the store's holdings. */

import type { OperatorSplits } from "../../../ports/operator/splits.js";
import type { MemoryScope } from "./index.js";

export const memoryOperatorSplits = (_scope: MemoryScope): OperatorSplits => ({});
