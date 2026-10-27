/** The orders area's reads across merchants, on Postgres; each runs through `read`. */

import { and, asc, desc, eq, type SQL, sql } from "drizzle-orm";
import { lookupOf } from "../../../ports/operator/lookup.js";
import {
  type Found,
  type OperatorOrderRow,
  type OperatorOrders,
  ORDERS_PAGE,
  type OrderMerchant,
  type OrdersCursor,
  type OrdersQuery,
  type OrdersShown,
} from "../../../ports/operator/orders.js";
import { operatorOrderOf, orderRowOf } from "../../../ports/operator/orders-as-read.js";
import { cards, merchants, orders, payoutSplits, receipts } from "../schema.js";
import {
  DELIVERED_NOT_PAID,
  ENDED,
  IN_PROGRESS,
  LAPSED,
  PAYMENT_UNKNOWN,
  UNFULFILLED,
} from "./predicates.js";
import type { ReadOnlyTransaction } from "./read-only.js";
import type { OperatorScope } from "./scope.js";

const SHOWN: Readonly<Record<OrdersShown, SQL>> = {
  payment_unknown: sql`(${PAYMENT_UNKNOWN})`,
  unfulfilled: UNFULFILLED,
  delivered_unpaid: DELIVERED_NOT_PAID,
  in_progress: IN_PROGRESS,
  ended: ENDED,
  lapsed: LAPSED,
  all: sql`true`,
};

const TITLE = sql<string | null>`${cards.card} ->> 'title'`;

/** Every transaction an order's payment names: the one that paid it, and recovery's hint. */
const TRANSACTIONS = [
  sql`${orders.record} -> 'settlement' ->> 'transaction'`,
  sql`${orders.record} -> 'paymentAttempt' ->> 'transaction'`,
  sql`${orders.record} -> 'paymentAttempt' -> 'completion' ->> 'transaction'`,
];

/** Identifiers compare by their bytes, as the memory reader compares them. */
const ID_BYTES = sql`${orders.id} collate "C"`;

const contains = (field: SQL, lowered: string): SQL =>
  sql`strpos(lower(coalesce(${field}, '')), ${lowered}) > 0`;

function filterOf(query: OrdersQuery): SQL | undefined {
  const search = query.search?.trim().toLowerCase() ?? "";
  return and(
    query.merchantId === undefined ? undefined : eq(orders.merchantId, query.merchantId),
    search === ""
      ? undefined
      : sql`(${sql.join(
          [orders.id, TITLE, orders.merchantItemId, ...TRANSACTIONS].map((field) =>
            contains(sql`${field}`, search),
          ),
          sql` or `,
        )})`,
  );
}

/** Where an order stands from a cursor in the list, newest first, as one row comparison. */
const PLACE = sql`(${orders.createdAt}, ${ID_BYTES})`;
const placeOf = (cursor: OrdersCursor): SQL =>
  sql`(${new Date(cursor.createdAt)}::timestamptz, ${cursor.id}::text collate "C")`;
const olderThan = (cursor: OrdersCursor): SQL => sql`${PLACE} < ${placeOf(cursor)}`;
const newerThan = (cursor: OrdersCursor): SQL => sql`${PLACE} > ${placeOf(cursor)}`;

const cursorOf = (row: OperatorOrderRow): OrdersCursor => ({
  createdAt: row.createdAt,
  id: row.id,
});

const counted = (condition: SQL) => sql<number>`(count(*) filter (where ${condition}))::int`;

/**
 * The rows the condition names, each with its merchant and its card's title,
 * newest first, or oldest first where `oldestFirst`.
 */
async function rowsWhere(
  tx: ReadOnlyTransaction,
  condition: SQL | undefined,
  limit?: number,
  oldestFirst = false,
): Promise<OperatorOrderRow[]> {
  const chosen = tx
    .select({
      record: orders.record,
      id: merchants.id,
      name: merchants.name,
      serviceName: merchants.serviceName,
      title: TITLE,
    })
    .from(orders)
    .innerJoin(merchants, eq(merchants.id, orders.merchantId))
    .leftJoin(cards, eq(cards.id, orders.itemId))
    .where(condition)
    .orderBy(
      ...(oldestFirst
        ? [asc(orders.createdAt), sql`${ID_BYTES} asc`]
        : [desc(orders.createdAt), sql`${ID_BYTES} desc`]),
    );
  const rows = await (limit === undefined ? chosen : chosen.limit(limit));
  return rows.map((row) =>
    orderRowOf(row.record, { id: row.id, name: row.name, serviceName: row.serviceName }, row.title),
  );
}

const MERCHANT = { id: merchants.id, name: merchants.name, serviceName: merchants.serviceName };

const merchantsFound = (
  by: "id" | "wallet" | "split" | "site",
  found: readonly OrderMerchant[],
): Found[] => found.map((merchant) => ({ kind: "merchant" as const, by, merchant }));

const ordersFound = (by: "id" | "transaction", found: readonly OperatorOrderRow[]): Found[] =>
  [...found]
    .sort((one, other) => (one.id < other.id ? -1 : one.id > other.id ? 1 : 0))
    .map((order) => ({ kind: "order" as const, by, order }));

export const postgresOperatorOrders = ({ read, network }: OperatorScope): OperatorOrders => {
  /** A split of this network that does not wait behind its merchant's wallet change at `at`. */
  const splitInForce = (at: number) =>
    sql`${payoutSplits.network} = ${network} and not coalesce(
      ${merchants.pendingPayoutWalletFrom} > ${new Date(at)}
      and lower(${merchants.pendingPayoutWallet}) = lower(${payoutSplits.merchantWallet}),
      false)`;

  const merchantsWhere = async (tx: ReadOnlyTransaction, condition: SQL) =>
    await tx
      .select(MERCHANT)
      .from(merchants)
      .where(condition)
      .orderBy(sql`${merchants.id} collate "C"`);

  return {
    async orders(query) {
      return await read(async (tx) => {
        const filter = filterOf(query);
        const shown = SHOWN[query.shown];
        const from = query.from;
        const back = from !== undefined && "before" in from;
        const past =
          from === undefined
            ? undefined
            : "after" in from
              ? olderThan(from.after)
              : newerThan(from.before);
        // Going on, the orders short of the cursor precede the page; going
        // back, the ones past it are the page and every order before it.
        const ahead = past === undefined ? sql`false` : back ? past : sql`not (${past})`;
        const [count] = await tx
          .select({
            payment_unknown: counted(SHOWN.payment_unknown),
            unfulfilled: counted(UNFULFILLED),
            delivered_unpaid: counted(DELIVERED_NOT_PAID),
            in_progress: counted(IN_PROGRESS),
            ended: counted(ENDED),
            lapsed: counted(LAPSED),
            all: sql<number>`count(*)::int`,
            ahead: counted(sql`${shown} and ${ahead}`),
          })
          .from(orders)
          .leftJoin(cards, eq(cards.id, orders.itemId))
          .where(filter);
        if (count === undefined) throw new Error("a count of the channel's orders came back empty");
        const { ahead: aheadOf, ...counts } = count;
        // One more than the page, to tell whether the list goes on past it.
        const read = await rowsWhere(tx, and(filter, shown, past), ORDERS_PAGE + 1, back);
        const page = read.slice(0, ORDERS_PAGE);
        if (back) page.reverse();
        const newer = back ? aheadOf - page.length : aheadOf;
        const older = back ? counts[query.shown] - aheadOf > 0 : read.length > ORDERS_PAGE;
        const first = page[0];
        const last = page.at(-1);
        return {
          counts,
          rows: page,
          newer,
          previous: newer > 0 && first !== undefined ? cursorOf(first) : null,
          next: older && last !== undefined ? cursorOf(last) : null,
          merchants: await merchantsWhere(
            tx,
            sql`exists (select 1 from ${orders} where ${orders.merchantId} = ${merchants.id})`,
          ),
        };
      });
    },

    async order(id) {
      return await read(async (tx) => {
        const [row] = await tx
          .select({
            record: orders.record,
            ...MERCHANT,
            sellerSite: merchants.sellerSite,
            title: TITLE,
            receipt: receipts.receipt,
          })
          .from(orders)
          .innerJoin(merchants, eq(merchants.id, orders.merchantId))
          .leftJoin(cards, eq(cards.id, orders.itemId))
          .leftJoin(receipts, eq(receipts.orderId, orders.id))
          .where(eq(orders.id, id));
        if (row === undefined) return null;
        const { record, title, receipt, ...merchant } = row;
        return operatorOrderOf(record, merchant, title, receipt);
      });
    },

    async find(text, at) {
      const asked = lookupOf(text);
      if (asked.kind === "none" || asked.kind === "email") return [];
      return await read(async (tx): Promise<Found[]> => {
        switch (asked.kind) {
          case "order":
            return ordersFound("id", await rowsWhere(tx, eq(orders.id, asked.id)));
          case "merchant":
            return merchantsFound("id", await merchantsWhere(tx, eq(merchants.id, asked.id)));
          case "transaction":
            return ordersFound(
              "transaction",
              await rowsWhere(
                tx,
                sql`(${sql.join(
                  TRANSACTIONS.map((field) => sql`lower(${field}) = ${asked.hash}`),
                  sql` or `,
                )})`,
              ),
            );
          case "address": {
            const splits = await merchantsWhere(
              tx,
              sql`exists (select 1 from ${payoutSplits} where ${payoutSplits.merchantId} = ${merchants.id}
                and lower(${payoutSplits.address}) = ${asked.address} and ${splitInForce(at)}
                and exists (select 1 from ${orders} where ${orders.merchantId} = ${payoutSplits.merchantId}
                  and lower(${orders.record} ->> 'payTo') = ${asked.address}))`,
            );
            if (splits.length > 0) return merchantsFound("split", splits);
            const inForce = sql`case when ${merchants.pendingPayoutWalletFrom} <= ${new Date(at)}
              then ${merchants.pendingPayoutWallet} else ${merchants.payoutWallet} end`;
            return merchantsFound(
              "wallet",
              await merchantsWhere(
                tx,
                sql`(lower(${inForce}) = ${asked.address} or exists (select 1 from ${payoutSplits}
                  where ${payoutSplits.merchantId} = ${merchants.id}
                  and lower(${payoutSplits.merchantWallet}) = ${asked.address} and ${splitInForce(at)}))`,
              ),
            );
          }
          case "site":
            return merchantsFound(
              "site",
              await merchantsWhere(tx, sql`lower(${merchants.sellerSite}) = ${asked.origin}`),
            );
        }
      });
    },
  };
};
