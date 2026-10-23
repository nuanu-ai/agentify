/**
 * The merchants area's reads across merchants, on Postgres; each runs through
 * `read`, one read-only transaction per call. Every merchant's facts are
 * counted in the database, the segment decided there by the twin of
 * `segmentOf`, so the list's counts, order and cut never need every merchant
 * brought back.
 */

import type { SurfaceMode } from "@agentify/core";
import type { Card, MerchantFinding, Money } from "@nuanu-ai/agentify-contracts";
import { type SQL, sql } from "drizzle-orm";
import {
  amountOfScaled,
  askedOn,
  dayOf,
  MERCHANT_PAGE_CUT,
  MERCHANT_SEGMENTS,
  type MerchantList,
  type MerchantListQuery,
  type MerchantRecord,
  type MerchantRow,
  type MerchantSegment,
  merchantLimitOf,
  type OperatorMerchants,
  SELLING_DAYS,
  type SettledSales,
  scaledAmount,
  searchOf,
  sellingFrom,
  WORTH_A_LOOK_STATES,
} from "../../../ports/operator/merchants.js";
import type { Integration } from "../../../ports/store.js";
import { PAYMENT_UNKNOWN } from "./predicates.js";
import type { ReadOnlyTransaction } from "./read-only.js";
import type { OperatorScope } from "./scope.js";

const DAY_MS = 86_400_000;

type Row = Record<string, unknown>;

const rowsOf = async (tx: ReadOnlyTransaction, query: SQL): Promise<Row[]> =>
  (await tx.execute(query)).rows as Row[];

/**
 * A moment as milliseconds since the epoch, which the driver hands back as a
 * number; it hands a timestamp back as text in a spelling of its own.
 */
const ms = (moment: string): SQL => sql.raw(`(extract(epoch from ${moment}) * 1000)::float8`);

const instantOf = (value: unknown): number => Number(value);
const instantOrNull = (value: unknown): number | null => (value === null ? null : instantOf(value));

/**
 * Every merchant, or the one `only` names, with the facts their row is drawn
 * from as of `at` on `surface`. The wallet in force is the waiting one once its
 * moment has come, and its split the one the registry holds for it on this
 * network, as `payoutWalletAt` reads them.
 */
function judged(scope: OperatorScope, at: number, surface: SurfaceMode, only?: string): SQL {
  const asked = askedOn(surface);
  const asks = (finding: MerchantFinding) => sql.raw(asked.includes(finding) ? "true" : "false");
  const now = new Date(at);
  const from = new Date(sellingFrom(at));
  return sql`
    standing as (
      select m.id, m.service_name, m.seller_site, m.created_at, m.integration, m.selling,
        m.live_approved_at, m.payout_wallet, m.pending_payout_wallet_from,
        case when m.pending_payout_wallet_from <= ${now}
          then m.pending_payout_wallet else m.payout_wallet end as wallet
      from merchants m
      ${only === undefined ? sql`` : sql`where m.id = ${only}`}
    ),
    facts as (
      select s.*,
        ${ms("s.created_at")} as created_ms,
        ${ms("s.live_approved_at")} as live_approved_ms,
        ${ms("s.pending_payout_wallet_from")} as pending_from_ms,
        (select ps.address from payout_splits ps
          where ps.network = ${scope.network} and ps.merchant_id = s.id
            and lower(ps.merchant_wallet) = lower(s.wallet)) as split,
        (select count(*)::int from cards c where c.merchant_id = s.id) as published,
        (select count(*)::int from cards c
          where c.merchant_id = s.id and c.integration = s.integration) as of_integration,
        (select count(*)::int from cards c
          where c.merchant_id = s.id and c.integration = s.integration and not c.paused) as unpaused,
        (select count(*)::int from merchant_keys k where k.merchant_id = s.id) as keys_issued,
        (select count(*)::int from merchant_keys k
          where k.merchant_id = s.id and k.disabled_at is null) as keys_working,
        (select ${ms("mc.polled_at")} from merchant_contact mc where mc.merchant_id = s.id) as last_contact,
        (select count(*)::int from orders o
          where o.merchant_id = s.id and not o.lapsed
            and o.created_at between ${from} and ${now}) as orders_counted,
        (select ${ms("max((r.receipt ->> 'paid_at')::timestamptz)")} from receipts r
          where r.merchant_id = s.id) as last_sale
      from standing s
    ),
    missing as (
      select f.*,
        (${asks("no_seller_name")} and f.service_name is null) as no_seller_name,
        (${asks("no_payout_wallet")} and f.split is null) as no_payout_wallet,
        (${asks("no_operator_approval")} and f.live_approved_at is null) as no_operator_approval
      from facts f
    ),
    judged as (
      select j.*,
        case
          when j.no_seller_name or j.no_payout_wallet or j.no_operator_approval then
            case when ${sql.raw(surface === "live" ? "true" : "false")}
                and not j.no_seller_name and not j.no_payout_wallet
              then 'waiting' else 'setting_up' end
          when j.of_integration = 0 then 'setting_up'
          when j.selling = 'paused' or j.unpaused = 0 then 'paused'
          else 'selling'
        end as segment
      from missing j
    )`;
}

/** Text the search finds in, as `searchOf` and the memory reader match it. */
function found(query: MerchantListQuery): SQL {
  const search = searchOf(query);
  if (search === null) return sql`true`;
  const ids = JSON.stringify(query.alsoIds ?? []);
  return sql`(
    position(${search} in lower(coalesce(j.service_name, ''))) > 0
    or position(${search} in lower(coalesce(j.seller_site, ''))) > 0
    or position(${search} in lower(j.id)) > 0
    or j.id in (select jsonb_array_elements_text(${ids}::jsonb))
  )`;
}

/** What the surface asks that the merchant lacks, in the order it asks. */
const missingOf = (row: Row, surface: SurfaceMode): MerchantFinding[] =>
  askedOn(surface).filter((finding) => row[finding] === true);

/** Settled sales as the database added them, by currency, written back as the memory reader writes them. */
function settledFrom(rows: readonly Row[]): SettledSales {
  const sums = new Map<string, bigint>();
  for (const row of rows) {
    const currency = String(row.currency);
    sums.set(currency, (sums.get(currency) ?? 0n) + scaledAmount(String(row.amount)));
  }
  return {
    count: rows.reduce((sum, row) => sum + Number(row.n), 0),
    sums: [...sums.entries()]
      .sort(([one], [other]) => (one < other ? -1 : one > other ? 1 : 0))
      .map(([currency, scaled]): Money => ({ amount: amountOfScaled(scaled), currency })),
  };
}

/** Settled sales between `from` and `at`, by merchant and currency, and by `per` besides where given. */
const settledSql = (
  merchantIds: readonly string[],
  from: number,
  at: number,
  per?: SQL,
): SQL => sql`
  select r.merchant_id, r.receipt -> 'price' ->> 'currency' as currency,
    count(*)::int as n, sum((r.receipt -> 'price' ->> 'amount')::numeric)::text as amount
    ${per === undefined ? sql`` : sql`, ${per} as per`}
  from receipts r
  where r.merchant_id in (select jsonb_array_elements_text(${JSON.stringify(merchantIds)}::jsonb))
    and (r.receipt ->> 'paid_at')::timestamptz between ${new Date(from)} and ${new Date(at)}
  group by 1, 2${per === undefined ? sql`` : sql`, 5`}`;

function rowOf(row: Row, surface: SurfaceMode, settled: SettledSales, from: number): MerchantRow {
  return {
    id: String(row.id),
    serviceName: row.service_name as string | null,
    sellerSite: row.seller_site as string | null,
    createdAt: instantOf(row.created_ms),
    integration: row.integration as Integration,
    segment: row.segment as MerchantSegment,
    missing: missingOf(row, surface),
    keys: { issued: Number(row.keys_issued), working: Number(row.keys_working) },
    lastContactAt: instantOrNull(row.last_contact),
    cards: {
      onSale:
        missingOf(row, surface).length === 0 && row.selling === "open" ? Number(row.unpaused) : 0,
      published: Number(row.published),
    },
    thirtyDays: { from, orders: Number(row.orders_counted), settled },
    lastSaleAt: instantOrNull(row.last_sale),
  };
}

const NO_SALES: SettledSales = { count: 0, sums: [] };

export const postgresOperatorMerchants = (scope: OperatorScope): OperatorMerchants => ({
  async list(query) {
    const from = sellingFrom(query.at);
    return await scope.read(async (tx): Promise<MerchantList> => {
      const facts = judged(scope, query.at, query.surface);
      const counted = await rowsOf(
        tx,
        sql`with ${facts} select j.segment, count(*)::int as n from judged j where ${found(query)} group by 1`,
      );
      const segments = Object.fromEntries([
        ["all", counted.reduce((sum, row) => sum + Number(row.n), 0)],
        ...MERCHANT_SEGMENTS.map((segment) => [
          segment,
          Number(counted.find((row) => row.segment === segment)?.n ?? 0),
        ]),
      ]) as MerchantList["segments"];
      const inSegment = query.segment === undefined ? sql`true` : sql`j.segment = ${query.segment}`;
      const rows = await rowsOf(
        tx,
        sql`with ${facts} select j.* from judged j
          where ${found(query)} and ${inSegment}
          order by (j.segment = 'waiting') desc, j.last_sale desc nulls last,
            j.created_at desc, j.id collate "C"
          limit ${merchantLimitOf(query)}`,
      );
      const sales = await rowsOf(
        tx,
        settledSql(
          rows.map((row) => String(row.id)),
          from,
          query.at,
        ),
      );
      return {
        rows: rows.map((row) =>
          rowOf(
            row,
            query.surface,
            settledFrom(sales.filter((sale) => sale.merchant_id === row.id)),
            from,
          ),
        ),
        total: query.segment === undefined ? segments.all : segments[query.segment],
        segments,
      };
    });
  },

  async merchant(id, { at, surface }) {
    const from = sellingFrom(at);
    return await scope.read(async (tx): Promise<MerchantRecord | null> => {
      const [head] = await rowsOf(
        tx,
        sql`with ${judged(scope, at, surface, id)} select j.* from judged j`,
      );
      if (head === undefined) return null;
      const missing = missingOf(head, surface);
      const sells = missing.length === 0 && head.selling === "open";

      const keys = await rowsOf(
        tx,
        sql`select id, label, ${ms("created_at")} as created_at, ${ms("last_used_at")} as last_used_at,
            ${ms("disabled_at")} as disabled_at
          from merchant_keys
          where merchant_id = ${id}
          order by created_at desc, id collate "C" desc
          limit ${MERCHANT_PAGE_CUT.keys}`,
      );
      const cards = await rowsOf(
        tx,
        sql`select id, card, ${ms("as_of")} as as_of, paused, integration from cards
          where merchant_id = ${id}
          order by merchant_item_id collate "C"
          limit ${MERCHANT_PAGE_CUT.cards}`,
      );
      const byDay = await rowsOf(
        tx,
        settledSql(
          [id],
          from,
          at,
          sql`to_char((r.receipt ->> 'paid_at')::timestamptz at time zone 'UTC', 'YYYY-MM-DD')`,
        ),
      );
      const worthy = sql`orders.merchant_id = ${id} and (${PAYMENT_UNKNOWN}
        or orders.state in (select jsonb_array_elements_text(${JSON.stringify(WORTH_A_LOOK_STATES)}::jsonb)))`;
      const worth = await rowsOf(
        tx,
        sql`select orders.id, orders.state, orders.record -> 'order' ->> 'payment' as payment,
            coalesce(nullif(orders.record -> 'order' -> 'price', 'null'::jsonb),
              orders.record -> 'order' -> 'cardPrice') as price,
            ${ms("orders.created_at")} as created_at, orders.item_id, c.card ->> 'title' as title
          from orders left join cards c on c.id = orders.item_id
          where ${worthy}
          order by orders.created_at desc, orders.id collate "C" desc
          limit ${MERCHANT_PAGE_CUT.orders}`,
      );
      const [worthCount] = await rowsOf(
        tx,
        sql`select count(*)::int as n from orders where ${worthy}`,
      );

      const days = [];
      for (let n = 0; n < SELLING_DAYS; n += 1) {
        const day = dayOf(from + n * DAY_MS);
        const sold = byDay.filter((row) => row.per === day);
        days.push({ day, ...(sold.length === 0 ? NO_SALES : settledFrom(sold)) });
      }
      const {
        keys: _keys,
        cards: counts,
        thirtyDays,
        ...facts
      } = rowOf(head, surface, settledFrom(byDay), from);
      const wallet = head.wallet as string | null;
      const pendingFrom = instantOrNull(head.pending_from_ms);

      return {
        ...facts,
        selling: head.selling as MerchantRecord["selling"],
        liveApprovedAt: instantOrNull(head.live_approved_ms),
        wallet:
          wallet === null
            ? null
            : {
                address: wallet,
                split: head.split as string | null,
                pending: pendingFrom !== null && pendingFrom > at ? { landsAt: pendingFrom } : null,
              },
        keys: {
          rows: keys.map((key) => ({
            id: String(key.id),
            label: String(key.label),
            createdAt: instantOf(key.created_at),
            lastUsedAt: instantOrNull(key.last_used_at),
            disabledAt: instantOrNull(key.disabled_at),
          })),
          total: Number(head.keys_issued),
        },
        cards: {
          rows: cards.map((card) => ({
            id: String(card.id),
            card: card.card as Card,
            publishedAt: instantOf(card.as_of),
            paused: card.paused === true,
            integration: card.integration as Integration,
            onSale: sells && card.paused !== true && card.integration === head.integration,
          })),
          total: counts.published,
          onSale: counts.onSale,
        },
        thirtyDays: { ...thirtyDays, days },
        worthALook: {
          rows: worth.map((row) => {
            const price = row.price as { amount: string; currency: string };
            return {
              id: String(row.id),
              state: row.state as MerchantRecord["worthALook"]["rows"][number]["state"],
              payment: row.payment as MerchantRecord["worthALook"]["rows"][number]["payment"],
              price: { amount: price.amount, currency: price.currency },
              createdAt: instantOf(row.created_at),
              itemId: String(row.item_id),
              title: row.title as string | null,
            };
          }),
          total: Number(worthCount?.n ?? 0),
        },
      };
    });
  },
});
