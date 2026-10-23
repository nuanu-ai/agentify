/** The merchants area's reads across merchants, on Postgres; each runs through `read`. */

import type { OperatorMerchants } from "../../../ports/operator/merchants.js";
import type { OperatorScope } from "./scope.js";

export const postgresOperatorMerchants = (_scope: OperatorScope): OperatorMerchants => ({});
