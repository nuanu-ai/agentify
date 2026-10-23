/** The orders area's reads across merchants, on Postgres; each runs through `read`. */

import type { OperatorOrders } from "../../../ports/operator/orders.js";
import type { OperatorScope } from "./scope.js";

export const postgresOperatorOrders = (_scope: OperatorScope): OperatorOrders => ({});
