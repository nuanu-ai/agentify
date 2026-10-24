/** The registry of payout splits read across merchants, in memory, over the store's holdings. */

import { inCodeOrder } from "../../../ports/operator/figures.js";
import { tallyOf } from "../../../ports/operator/money.js";
import {
  type OperatorSplits,
  SPLITS_LISTED_AT_MOST,
  type SplitRow,
} from "../../../ports/operator/splits.js";
import { settledSales, walletAt } from "./figures-standing.js";
import type { MemoryScope } from "./index.js";

export const memoryOperatorSplits = (scope: MemoryScope): OperatorSplits => ({
  async splits(asked) {
    const holdings = scope.holdings();
    const merchants = new Map(holdings.merchants.map((merchant) => [merchant.id, merchant]));
    const namedBy = (merchantId: string, address: string) =>
      `${merchantId}\u0000${address.toLowerCase()}`;
    const named = new Set(
      holdings.orders.flatMap(({ record }) =>
        record.payTo === null ? [] : [namedBy(record.merchantId, record.payTo)],
      ),
    );
    const settled = new Map<string, { micros: bigint; count: number }>();
    for (const sale of settledSales(holdings, scope.network)) {
      if (sale.split === null) continue;
      const key = sale.split.address.toLowerCase();
      const held = settled.get(key) ?? { micros: 0n, count: 0 };
      settled.set(key, { micros: held.micros + sale.micros, count: held.count + 1 });
    }

    let waiting = 0;
    const rows: (SplitRow & { readonly micros: bigint })[] = [];
    for (const split of holdings.splits.filter((each) => each.network === scope.network)) {
      const merchant = merchants.get(split.merchantId);
      const key = split.address.toLowerCase();
      const pending = merchant?.payoutWallet.pending;
      if (
        pending != null &&
        pending.takesEffectAt > asked.at &&
        pending.address.toLowerCase() === split.merchantWallet.toLowerCase() &&
        !named.has(namedBy(split.merchantId, split.address))
      ) {
        waiting += 1;
        continue;
      }
      const held = settled.get(key) ?? { micros: 0n, count: 0 };
      const now = merchant === undefined ? null : walletAt(merchant, asked.at).address;
      rows.push({
        address: split.address,
        merchantId: split.merchantId,
        merchantName: merchant?.name ?? null,
        merchantWallet: split.merchantWallet,
        commissionWallet: split.commissionWallet,
        recordedAt: split.recordedAt,
        inForce: now !== null && now.toLowerCase() === split.merchantWallet.toLowerCase(),
        settled: tallyOf(held.micros, held.count),
        micros: held.micros,
      });
    }
    rows.sort(
      (one, other) =>
        (one.micros === other.micros ? 0 : one.micros > other.micros ? -1 : 1) ||
        other.recordedAt - one.recordedAt ||
        inCodeOrder(one.address.toLowerCase(), other.address.toLowerCase()),
    );
    return {
      readAt: asked.at,
      rows: rows.slice(0, SPLITS_LISTED_AT_MOST).map(({ micros: _, ...row }) => row),
      of: rows.length,
      empty: rows.filter((row) => row.settled.count === 0).length,
      waiting,
    };
  },
});
