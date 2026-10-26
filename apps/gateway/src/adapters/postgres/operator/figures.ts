/**
 * The figures area's reads across merchants, on Postgres; each runs through
 * `read`. Counts and sums are made in the database, grouped by day where a
 * chart needs days, so a busier month brings back the same number of rows.
 */

import { SILENT_AFTER_MS } from "@agentify/core/published";
import { type SQL, sql } from "drizzle-orm";
import { CONTACT_WRITTEN_EVERY_MS } from "../../../app/gateway.js";
import {
  askedOn,
  CHART_DAYS,
  dayNumberOf,
  daysBackFrom,
  dayWritten,
  endOfDayOf,
  FUNNEL_STEPS,
  type FunnelStep,
  type OperatorFigures,
  PERIOD_DAYS,
  RECENT_DAYS,
  SILENT_NAMED_AT_MOST,
  UNKNOWN_MERCHANTS_NAMED_AT_MOST,
  WAITING_NAMED_AT_MOST,
} from "../../../ports/operator/figures.js";
import { commissionOn, dollarsOf, type Tally, tallyOf } from "../../../ports/operator/money.js";
import {
  listOf,
  microsOfSum,
  msOf,
  namedAndPaid,
  onSale,
  ready,
  refuseUnaddable,
  SETTLED,
  settledSales,
} from "./figures-sql.js";
import { PAYMENT_UNKNOWN } from "./predicates.js";
import type { ReadOnlyTransaction } from "./read-only.js";
import type { OperatorScope } from "./scope.js";

/** How long a seller's process may go without a poll before the purchase guard counts it silent. */
const SILENT_WINDOW_MS = SILENT_AFTER_MS + CONTACT_WRITTEN_EVERY_MS;

const instantOf = (ms: string | null): number | null => (ms === null ? null : Number(ms));

/** The settled sales whose order records no moment it was paid. */
async function undatedSales(tx: ReadOnlyTransaction, network: string): Promise<Tally> {
  const {
    rows: [row],
  } = await tx.execute<{ count: number; amount: string | null }>(sql`
    with s as (${settledSales(network)})
    select count(*)::int as count, sum(s.amount::numeric)::text as amount
      from s where s.settled_at is null`);
  return tallyOf(microsOfSum(row?.amount ?? null), row?.count ?? 0);
}

export const postgresOperatorFigures = (scope: OperatorScope): OperatorFigures => ({
  async waitingForAdmission(asked) {
    if (!askedOn(asked.surface).admission) return { readAt: asked.at, merchants: [], of: 0 };
    return await scope.read(async (tx) => {
      const { rows } = await tx.execute<{
        id: string;
        name: string;
        service_name: string;
        seller_site: string | null;
        created_at: string;
        integration: "api" | "woocommerce";
        polled_at: string | null;
        cards: number;
        of: number;
      }>(sql`
        select m.id, m.name, m.service_name, m.seller_site, ${msOf(sql`m.created_at`)} as created_at, m.integration,
               (select ${msOf(sql`mc.polled_at`)} from merchant_contact mc where mc.merchant_id = m.id) as polled_at,
               (select count(*)::int from cards c where c.merchant_id = m.id) as cards,
               (count(*) over ())::int as of
          from merchants m
         where m.live_approved_at is null and ${namedAndPaid(asked, scope.network)}
         order by m.created_at, m.id collate "C"
         limit ${WAITING_NAMED_AT_MOST}`);
      const of = rows[0]?.of ?? 0;
      return {
        readAt: asked.at,
        of,
        merchants: rows.map((row) => ({
          merchantId: row.id,
          name: row.name,
          serviceName: row.service_name,
          sellerSite: row.seller_site,
          createdAt: Number(row.created_at),
          integration: row.integration,
          lastContact: instantOf(row.polled_at),
          cardsPublished: row.cards,
        })),
      };
    });
  },

  async unknownPayments(asked) {
    return await scope.read(async (tx) => {
      await refuseUnaddable(tx, PAYMENT_UNKNOWN);
      const { rows } = await tx.execute<{
        merchant_id: string;
        name: string;
        count: number;
        amount: string;
        oldest: string;
      }>(sql`
        select orders.merchant_id, m.name, count(*)::int as count,
               sum((orders.record -> 'order' -> 'price' ->> 'amount')::numeric)::text as amount,
               min(coalesce((orders.record -> 'order' -> 'timestamps' ->> 'settleStartedAt')::numeric,
                            (orders.record -> 'order' -> 'timestamps' ->> 'createdAt')::numeric))::text as oldest
          from orders
          join merchants m on m.id = orders.merchant_id
         where ${PAYMENT_UNKNOWN}
         group by orders.merchant_id, m.name
         order by count(*) desc, orders.merchant_id collate "C"`);
      const oldest = rows.map((row) => Number(row.oldest));
      return {
        readAt: asked.at,
        ...tallyOf(
          rows.reduce((all, row) => all + microsOfSum(row.amount), 0n),
          rows.reduce((all, row) => all + row.count, 0),
        ),
        oldestSince: oldest.length === 0 ? null : Math.min(...oldest),
        merchants: rows.slice(0, UNKNOWN_MERCHANTS_NAMED_AT_MOST).map((row) => ({
          merchantId: row.merchant_id,
          name: row.name,
          count: row.count,
        })),
        merchantsOf: rows.length,
      };
    });
  },

  async workers(asked) {
    const quiet = new Date(asked.at - SILENT_WINDOW_MS);
    return await scope.read(async (tx) => {
      const {
        rows: [contact],
      } = await tx.execute<{ within: number; ever: number }>(sql`
        select (count(*) filter (where polled_at >= ${quiet}))::int as within, count(*)::int as ever
          from merchant_contact`);
      const { rows } = await tx.execute<{
        id: string;
        name: string;
        polled_at: string | null;
        of: number;
      }>(sql`
        select m.id, m.name, ${msOf(sql`mc.polled_at`)} as polled_at, (count(*) over ())::int as of
          from merchants m
          left join merchant_contact mc on mc.merchant_id = m.id
         where m.selling = 'open' and m.integration = 'api' and ${ready(asked, scope.network)}
           and (mc.polled_at is null or mc.polled_at < ${quiet})
           and exists (select 1 from cards c
                        where c.merchant_id = m.id and not c.paused and c.integration = 'api')
         order by mc.polled_at nulls first, m.id collate "C"
         limit ${SILENT_NAMED_AT_MOST}`);
      return {
        readAt: asked.at,
        connectedWithin: contact?.within ?? 0,
        everConnected: contact?.ever ?? 0,
        silent: rows.map((row) => ({
          merchantId: row.id,
          name: row.name,
          since: instantOf(row.polled_at),
        })),
        silentOf: rows[0]?.of ?? 0,
      };
    });
  },

  async analyticsOutbox(asked) {
    return await scope.read(async (tx) => {
      const {
        rows: [outbox],
      } = await tx.execute<{
        waiting: number;
        given_up: number;
        given_up_since: string | null;
        refused: number;
      }>(sql`
        select (count(*) filter (where state = 'pending'))::int as waiting,
               (count(*) filter (where state = 'given_up'))::int as given_up,
               ${msOf(sql`min(settled_at) filter (where state = 'given_up')`)} as given_up_since,
               (count(*) filter (where state = 'dead'))::int as refused
          from commerce_analytics_events`);
      return {
        readAt: asked.at,
        waiting: outbox?.waiting ?? 0,
        givenUp: outbox?.given_up ?? 0,
        givenUpSince: instantOf(outbox?.given_up_since ?? null),
        refused: outbox?.refused ?? 0,
      };
    });
  },

  async merchantCounts(asked) {
    const waiting = askedOn(asked.surface).admission
      ? sql`m.live_approved_at is null and ${namedAndPaid(asked, scope.network)}`
      : sql`false`;
    return await scope.read(async (tx) => {
      const {
        rows: [counts],
      } = await tx.execute<{
        total: number;
        selling: number;
        admitted: number;
        waiting: number;
      }>(sql`
        select count(*)::int as total,
               (count(*) filter (where exists (select 1 from cards c
                                               where c.merchant_id = m.id
                                                 and ${onSale(asked, scope.network)})))::int as selling,
               (count(*) filter (where m.live_approved_at is not null))::int as admitted,
               (count(*) filter (where ${waiting}))::int as waiting
          from merchants m`);
      return {
        readAt: asked.at,
        total: counts?.total ?? 0,
        selling: counts?.selling ?? 0,
        admitted: counts?.admitted ?? 0,
        waitingForAdmission: counts?.waiting ?? 0,
      };
    });
  },

  async recentOrders(asked) {
    const from = new Date(daysBackFrom(asked.at, RECENT_DAYS));
    const until = new Date(endOfDayOf(asked.at));
    return await scope.read(async (tx) => {
      const {
        rows: [recent],
      } = await tx.execute<{
        count: number;
        delivered: number;
        unknown: number;
        lapsed: number;
      }>(sql`
        select (count(*) filter (where not orders.lapsed))::int as count,
               (count(*) filter (where not orders.lapsed and orders.state = 'delivered'))::int as delivered,
               (count(*) filter (where not orders.lapsed and ${PAYMENT_UNKNOWN}))::int as unknown,
               (count(*) filter (where orders.lapsed))::int as lapsed
          from orders
         where orders.created_at >= ${from} and orders.created_at < ${until}`);
      return {
        readAt: asked.at,
        count: recent?.count ?? 0,
        delivered: recent?.delivered ?? 0,
        paymentUnknown: recent?.unknown ?? 0,
        lapsed: recent?.lapsed ?? 0,
      };
    });
  },

  async money(asked, period) {
    const days = PERIOD_DAYS[period];
    const from = days === null ? null : daysBackFrom(asked.at, days);
    const within: SQL =
      from === null
        ? sql`true`
        : sql`s.settled_at >= ${from} and s.settled_at < ${endOfDayOf(asked.at)}`;
    return await scope.read(async (tx) => {
      await refuseUnaddable(tx, SETTLED);
      const { rows } = await tx.execute<{
        state: string;
        split_address: string | null;
        commission_allocation: number | null;
        total_allocation: number | null;
        count: number;
        amount: string;
      }>(sql`
        with s as (${settledSales(scope.network)})
        select s.state, s.split_address, s.commission_allocation, s.total_allocation,
               count(*)::int as count, sum(s.amount::numeric)::text as amount
          from s
         where ${within}
         group by s.state, s.split_address, s.commission_allocation, s.total_allocation`);

      const tally = (kept: typeof rows): Tally =>
        tallyOf(
          kept.reduce((all, row) => all + microsOfSum(row.amount), 0n),
          kept.reduce((all, row) => all + row.count, 0),
        );
      const bySplit = new Map<string, { micros: bigint; commission: number; total: number }>();
      for (const row of rows) {
        if (row.split_address === null) continue;
        const held = bySplit.get(row.split_address) ?? {
          micros: 0n,
          commission: row.commission_allocation ?? 0,
          total: row.total_allocation ?? 1,
        };
        bySplit.set(row.split_address, { ...held, micros: held.micros + microsOfSum(row.amount) });
      }
      const noDelivery = rows.filter((row) => row.state !== "delivered");
      const byState = new Map<string, number>();
      for (const row of noDelivery)
        byState.set(row.state, (byState.get(row.state) ?? 0) + row.count);

      return {
        readAt: asked.at,
        period,
        from,
        sales: tally(rows),
        undated: await undatedSales(tx, scope.network),
        commission: dollarsOf(
          [...bySplit.values()].reduce(
            (all, split) =>
              all +
              commissionOn(split.micros, {
                commissionAllocation: split.commission,
                totalAllocation: split.total,
              }),
            0n,
          ),
        ),
        intoSplits: tally(rows.filter((row) => row.split_address !== null)),
        straightToWallet: tally(rows.filter((row) => row.split_address === null)),
        noDelivery: tally(noDelivery),
        noDeliveryByState: [...byState]
          .sort(([one], [other]) => (one < other ? -1 : one > other ? 1 : 0))
          .map(([state, count]) => ({ state, count })),
      };
    });
  },

  async salesByDay(asked) {
    const from = daysBackFrom(asked.at, CHART_DAYS);
    const first = dayNumberOf(from);
    return await scope.read(async (tx) => {
      await refuseUnaddable(tx, SETTLED);
      const { rows } = await tx.execute<{
        day: number;
        delivered: boolean;
        count: number;
        amount: string;
      }>(sql`
        with s as (${settledSales(scope.network)})
        select div(s.settled_at, 86400000)::int as day, s.state = 'delivered' as delivered,
               count(*)::int as count, sum(s.amount::numeric)::text as amount
          from s
         where s.settled_at >= ${from} and s.settled_at < ${endOfDayOf(asked.at)}
         group by 1, 2`);
      const on = (day: number, delivered: boolean): Tally => {
        const row = rows.find((each) => each.day === day && each.delivered === delivered);
        return row === undefined ? tallyOf(0n, 0) : tallyOf(microsOfSum(row.amount), row.count);
      };
      return {
        readAt: asked.at,
        days: Array.from({ length: CHART_DAYS }, (_, index) => ({
          day: dayWritten(first + index),
          delivered: on(first + index, true),
          noDelivery: on(first + index, false),
        })),
        undated: await undatedSales(tx, scope.network),
      };
    });
  },

  async funnel(asked, shops) {
    const steps = FUNNEL_STEPS.filter(
      (step) => askedOn(asked.surface).admission || step !== "admitted",
    );
    const shop = sql`m.id in ${listOf(shops.merchantIds)}`;
    const took: Record<FunnelStep, SQL> = {
      created: sql`true`,
      seller_name: sql`m.service_name is not null`,
      payout_wallet: sql`m.payout_wallet is not null`,
      key_or_shop: sql`(exists (select 1 from merchant_keys k where k.merchant_id = m.id) or ${shop})`,
      connected: sql`(exists (select 1 from merchant_contact mc where mc.merchant_id = m.id) or ${shop})`,
      admitted: sql`m.live_approved_at is not null`,
      card_on_sale: sql`exists (select 1 from cards c where c.merchant_id = m.id and ${onSale(asked, scope.network)})`,
      first_sale: sql`exists (select 1 from orders where orders.merchant_id = m.id and ${SETTLED})`,
    };
    const counts = steps.map(
      (_, index) =>
        sql`(count(*) filter (where ${sql.join(
          steps.slice(0, index + 1).map((step) => took[step]),
          sql` and `,
        )}))::int`,
    );
    return await scope.read(async (tx) => {
      const {
        rows: [row],
      } = await tx.execute<{ steps: number[] }>(sql`
        select array[${sql.join(counts, sql`, `)}] as steps from merchants m`);
      return {
        readAt: asked.at,
        steps: steps.map((step, index) => ({ step, merchants: row?.steps[index] ?? 0 })),
      };
    });
  },
});
