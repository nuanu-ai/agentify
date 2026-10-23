/** The orders area's reads across merchants, in memory, over the store's holdings. */

import type { OperatorOrders } from "../../../ports/operator/orders.js";
import type { MemoryScope } from "./index.js";

export const memoryOperatorOrders = (_scope: MemoryScope): OperatorOrders => ({});
