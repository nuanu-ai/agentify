/** The registry of payout splits read across merchants, on Postgres; each read runs through `read`. */

import type { OperatorSplits } from "../../../ports/operator/splits.js";
import type { OperatorScope } from "./scope.js";

export const postgresOperatorSplits = (_scope: OperatorScope): OperatorSplits => ({});
