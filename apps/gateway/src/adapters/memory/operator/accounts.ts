/** The accounts area's reads about merchants, in memory, over the store's holdings. */

import type { OperatorAccounts } from "../../../ports/operator/accounts.js";
import type { MemoryScope } from "./index.js";

export const memoryOperatorAccounts = (scope: MemoryScope): OperatorAccounts => ({
  async merchantsNamed(ids) {
    return scope
      .holdings()
      .merchants.filter((merchant) => ids.includes(merchant.id))
      .map(({ id, serviceName }) => ({ id, serviceName }));
  },
  async historyOf(merchantId) {
    const held = scope.holdings();
    return {
      orders: held.orders.filter(({ record }) => record.merchantId === merchantId).length,
      receipts: held.receipts.filter((one) => one.merchantId === merchantId).length,
    };
  },
});
