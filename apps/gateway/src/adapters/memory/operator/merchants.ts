/** The merchants area's reads across merchants, in memory, over the store's holdings. */

import type { OperatorMerchants } from "../../../ports/operator/merchants.js";
import type { MemoryScope } from "./index.js";

export const memoryOperatorMerchants = (_scope: MemoryScope): OperatorMerchants => ({});
