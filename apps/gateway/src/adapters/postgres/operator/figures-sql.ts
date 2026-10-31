/**
 * The SQL the operator's figures and splits share on Postgres: where a
 * merchant stands at a moment, and every settled sale with the moment its
 * money moved. Each is the twin of a function in
 * `adapters/memory/operator/figures-standing.ts`, and the contract both
 * readers run holds them to one answer.
 */

import { PAYABLE_CURRENCIES, PAYABLE_DECIMALS } from "@nuanu-ai/agentify-contracts";
import { type SQL, sql } from "drizzle-orm";
import { askedOn, type FiguresAsked } from "../../../ports/operator/figures.js";
import { microsOf, paidWithNoPrice } from "../../../ports/operator/money.js";
import type { ReadOnlyTransaction } from "./read-only.js";

/** An amount `microsOf` takes, as a pattern the database matches. */
const DOLLARS_WRITTEN = `^\\s*[0-9]+([.][0-9]{1,${PAYABLE_DECIMALS}})?\\s*$`;

/** An order whose payment settled. */
export const SETTLED = sql`orders.record -> 'order' ->> 'payment' = 'settled'`;

/** A list handed to the database as one value, so an empty one is still a list. */
export const listOf = (values: readonly string[]): SQL =>
  sql`(select jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;

/** The wallet merchant `m` is paid at `at`, a waiting change whose moment has come included. */
export const walletNow = (at: number): SQL =>
  sql`(case when m.pending_payout_wallet is not null and m.pending_payout_wallet_from <= ${new Date(at)}
            then m.pending_payout_wallet else m.payout_wallet end)`;

/** Whether merchant `m` has a seller name and, where the channel asks, a wallet with a recorded split. */
const namedAndPaid = (asked: FiguresAsked, network: string): SQL => {
  const paid = askedOn(asked.surface).wallet
    ? sql`exists (select 1 from payout_splits ws
                   where ws.network = ${network} and ws.merchant_id = m.id
                     and lower(ws.merchant_wallet) = lower(${walletNow(asked.at)}))`
    : sql`true`;
  return sql`(m.service_name is not null and ${paid})`;
};

/** Whether nothing the channel asks of merchant `m` is missing. */
export const ready = (asked: FiguresAsked, network: string): SQL => {
  const admitted = askedOn(asked.surface).admission
    ? sql`m.live_approved_at is not null`
    : sql`true`;
  return sql`(${namedAndPaid(asked, network)} and ${admitted})`;
};

/**
 * Whether card `c` of merchant `m` is on sale now, as the merchant's switches
 * and readiness have it. The public catalogue also leaves a card out while its
 * seller's code is silent or their unserved orders stop their sales; this does
 * not, and the operator's admin note says why that waits.
 */
export const onSale = (asked: FiguresAsked, network: string): SQL =>
  sql`(m.selling = 'open' and not c.paused and c.integration = m.integration and ${ready(asked, network)})`;

/**
 * Every settled sale as rows of `id`, `state`, `merchant_id`, `amount`,
 * `currency`, the split it was paid into with its allocations (nulls where it
 * went straight to a wallet), and `settled_at`: the block's time where the
 * payment was observed on the chain, otherwise when the order entered paid, in
 * milliseconds, or null where the order records neither.
 */
export const settledSales = (network: string): SQL => sql`
  select orders.id, orders.state, orders.merchant_id,
         orders.record -> 'order' -> 'price' ->> 'amount' as amount,
         orders.record -> 'order' -> 'price' ->> 'currency' as currency,
         sp.address as split_address, sp.commission_allocation, sp.total_allocation,
         floor(coalesce(
           case when orders.record -> 'paymentAttempt' -> 'completion' ->> 'settled' = 'true'
                then (orders.record -> 'paymentAttempt' -> 'completion' ->> 'executedAt')::numeric end,
           (orders.record -> 'order' -> 'timestamps' ->> 'paidAt')::numeric
         ))::bigint as settled_at
    from orders
    left join payout_splits sp
      on sp.network = ${network} and lower(sp.address) = lower(orders.record ->> 'payTo')
   where ${SETTLED}`;

/**
 * Throws, as the memory reader does, where an order `among` names carries no
 * price or an amount that is not dollars, so no sum is made from rows that
 * cannot be added. `among` is a condition on the orders table.
 */
export async function refuseUnaddable(tx: ReadOnlyTransaction, among: SQL): Promise<void> {
  const { rows } = await tx.execute<{
    id: string;
    amount: string | null;
    currency: string | null;
  }>(sql`
    select orders.id,
           orders.record -> 'order' -> 'price' ->> 'amount' as amount,
           orders.record -> 'order' -> 'price' ->> 'currency' as currency
      from orders
     where ${among}
       and (orders.record -> 'order' -> 'price' ->> 'amount' is null
            or orders.record -> 'order' -> 'price' ->> 'currency' is null
            or orders.record -> 'order' -> 'price' ->> 'currency' not in ${listOf(PAYABLE_CURRENCIES)}
            or orders.record -> 'order' -> 'price' ->> 'amount' !~ ${DOLLARS_WRITTEN})
     order by orders.id collate "C"
     limit 1`);
  const [unaddable] = rows;
  if (unaddable === undefined) return;
  if (unaddable.amount === null || unaddable.currency === null) throw paidWithNoPrice(unaddable.id);
  microsOf(unaddable.amount, unaddable.currency);
  throw new Error(`the order ${unaddable.id} carries an amount that cannot be added`);
}

/** An instant as whole milliseconds since 1970, which the driver hands back as a string. */
export const msOf = (instant: SQL): SQL =>
  sql`floor(extract(epoch from ${instant}) * 1000)::bigint`;

/** Millionths of a dollar from a sum the database made, nothing where it summed no rows. */
export const microsOfSum = (sum: string | null): bigint => (sum === null ? 0n : microsOf(sum));
