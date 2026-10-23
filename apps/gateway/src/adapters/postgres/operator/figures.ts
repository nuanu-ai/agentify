/** The figures area's reads across merchants, on Postgres; each runs through `read`. */

import type { OperatorFigures } from "../../../ports/operator/figures.js";
import type { OperatorScope } from "./scope.js";

const notRead = async (): Promise<never> => {
  throw new Error("the operator's figures are not read on Postgres yet");
};

export const postgresOperatorFigures = (_scope: OperatorScope): OperatorFigures => ({
  waitingForAdmission: notRead,
  unknownPayments: notRead,
  workers: notRead,
  analyticsOutbox: notRead,
  merchantCounts: notRead,
  recentOrders: notRead,
  money: notRead,
  salesByDay: notRead,
  funnel: notRead,
});
