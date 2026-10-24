/** The accounts area's reads about merchants, on Postgres; each runs through `read`. */

import { count, eq, inArray } from "drizzle-orm";
import type { OperatorAccounts } from "../../../ports/operator/accounts.js";
import { merchants, orders, receipts } from "../schema.js";
import type { OperatorScope } from "./scope.js";

export const postgresOperatorAccounts = (scope: OperatorScope): OperatorAccounts => ({
  async merchantsNamed(ids) {
    if (ids.length === 0) return [];
    return await scope.read(
      async (tx) =>
        await tx
          .select({ id: merchants.id, serviceName: merchants.serviceName })
          .from(merchants)
          .where(inArray(merchants.id, [...ids])),
    );
  },
  async historyOf(merchantId) {
    return await scope.read(async (tx) => {
      const [ordered] = await tx
        .select({ n: count() })
        .from(orders)
        .where(eq(orders.merchantId, merchantId));
      const [received] = await tx
        .select({ n: count() })
        .from(receipts)
        .where(eq(receipts.merchantId, merchantId));
      return { orders: ordered?.n ?? 0, receipts: received?.n ?? 0 };
    });
  },
});
