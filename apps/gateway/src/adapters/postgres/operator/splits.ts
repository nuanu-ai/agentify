/** The registry of payout splits read across merchants, on Postgres; each read runs through `read`. */

import { sql } from "drizzle-orm";
import { tallyOf } from "../../../ports/operator/money.js";
import { type OperatorSplits, SPLITS_LISTED_AT_MOST } from "../../../ports/operator/splits.js";
import {
  microsOfSum,
  msOf,
  refuseUnaddable,
  SETTLED,
  settledSales,
  walletNow,
} from "./figures-sql.js";
import type { OperatorScope } from "./scope.js";

export const postgresOperatorSplits = (scope: OperatorScope): OperatorSplits => ({
  async splits(asked) {
    const at = new Date(asked.at);
    // A split is waiting while it is the split of a change not yet in force
    // and no order was ever asked to pay it: its address is the new wallet's.
    const listed = sql`
      with s as (${settledSales(scope.network)}),
      settled as (
        select lower(s.split_address) as address, count(*)::int as count,
               sum(s.amount::numeric) as amount
          from s where s.split_address is not null group by 1),
      registry as (
        select sp.*, ${msOf(sql`sp.recorded_at`)} as recorded_ms, m.name as merchant_name,
               coalesce(lower(${walletNow(asked.at)}) = lower(sp.merchant_wallet), false) as in_force,
               (m.pending_payout_wallet is not null and m.pending_payout_wallet_from > ${at}
                and lower(m.pending_payout_wallet) = lower(sp.merchant_wallet)
                and not exists (select 1 from orders
                                 where orders.merchant_id = sp.merchant_id
                                   and lower(orders.record ->> 'payTo') = lower(sp.address))) as waiting,
               coalesce(settled.count, 0) as settled_count,
               settled.amount as settled_amount
          from payout_splits sp
          left join merchants m on m.id = sp.merchant_id
          left join settled on settled.address = lower(sp.address)
         where sp.network = ${scope.network})`;
    return await scope.read(async (tx) => {
      await refuseUnaddable(tx, SETTLED);
      const { rows } = await tx.execute<{
        address: string;
        merchant_id: string;
        merchant_name: string | null;
        merchant_wallet: string;
        commission_wallet: string;
        recorded_ms: string;
        in_force: boolean;
        settled_count: number;
        settled_amount: string | null;
      }>(sql`
        ${listed}
        select address, merchant_id, merchant_name, merchant_wallet, commission_wallet, recorded_ms,
               in_force, settled_count, settled_amount::text as settled_amount
          from registry
         where not waiting
         order by coalesce(settled_amount, 0) desc, recorded_at desc, lower(address) collate "C"
         limit ${SPLITS_LISTED_AT_MOST}`);
      const {
        rows: [counts],
      } = await tx.execute<{ of: number; empty: number; waiting: number }>(sql`
        ${listed}
        select (count(*) filter (where not waiting))::int as of,
               (count(*) filter (where not waiting and settled_count = 0))::int as empty,
               (count(*) filter (where waiting))::int as waiting
          from registry`);
      return {
        readAt: asked.at,
        rows: rows.map((row) => ({
          address: row.address,
          merchantId: row.merchant_id,
          merchantName: row.merchant_name,
          merchantWallet: row.merchant_wallet,
          commissionWallet: row.commission_wallet,
          recordedAt: Number(row.recorded_ms),
          inForce: row.in_force,
          settled: tallyOf(microsOfSum(row.settled_amount), row.settled_count),
        })),
        of: counts?.of ?? 0,
        empty: counts?.empty ?? 0,
        waiting: counts?.waiting ?? 0,
      };
    });
  },
});
