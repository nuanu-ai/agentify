/** The figures area's reads across merchants, on Postgres; each runs through `read`. */

import type { OperatorFigures } from "../../../ports/operator/figures.js";
import type { OperatorScope } from "./scope.js";

export const postgresOperatorFigures = (_scope: OperatorScope): OperatorFigures => ({});
