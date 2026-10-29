/**
 * The merchants area's reads across merchants, on Postgres; each runs through
 * `read`, one read-only transaction per call. Every merchant's facts are
 * counted in the database, the segment decided there by the twin of
 * `segmentOf`, so the list's counts, order and cut never need every merchant
 * brought back.
 */

import { type Order, outcomeFor, type SurfaceMode } from "@agentify/core";
import type { Card, MerchantFinding } from "@nuanu-ai/agentify-contracts";
import { type SQL, sql } from "drizzle-orm";
import {
  askedOn,
  dayOf,
  MERCHANT_PAGE_CUT,
  MERCHANT_SEGMENTS,
  type MerchantList,
  type MerchantListQuery,
  type MerchantPlace,
  type MerchantRecord,
  type MerchantRow,
  type MerchantSegment,
  merchantLimitOf,
  merchantPlaceOf,
  type OperatorMerchants,
  SELLING_DAYS,
  searchOf,
  sellingFrom,
  WORTH_A_LOOK_STATES,
} from "../../../ports/operator/merchants.js";
import { type Tally, tallyOf } from "../../../ports/operator/money.js";
import type { Integration } from "../../../ports/store.js";
import { listOf, microsOfSum, refuseUnaddable, SETTLED, settledSales } from "./figures-sql.js";
import { PAYMENT_UNKNOWN } from "./predicates.js";
import type { ReadOnlyTransaction } from "./read-only.js";
import type { OperatorScope } from "./scope.js";

const DAY_MS = 86_400_000;

type Row = Record<string, unknown>;

const rowsOf = async (tx: ReadOnlyTransaction, query: SQL): Promise<Row[]> =>
  (await tx.execute(query)).rows as Row[];

/**
 * A moment as whole milliseconds since the epoch, which the driver hands back
 * as a number; it hands a timestamp back as text in a spelling of its own.
 * Whole, because a row the database's own clock wrote holds microseconds,
 * which the memory reader and a cursor in an address cannot.
 */
const ms = (moment: string): SQL => sql.raw(`floor(extract(epoch from ${moment}) * 1000)::float8`);

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
    sales as (${settledSales(scope.network)}),
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
        (select ${ms("mc.polled_at")} from merchant_contact mc
          where mc.merchant_id = s.id and mc.integration = 'api') as last_contact,
        (select count(*)::int from orders o
          where o.merchant_id = s.id
            and o.created_at between ${from} and ${now}) as orders_counted,
        (select max(sa.settled_at) from sales sa where sa.merchant_id = s.id) as last_sale
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

/** Settled sales as the database counted and added them, written as the memory reader writes them. */
const tallyFrom = (rows: readonly Row[]): Tally =>
  tallyOf(
    rows.reduce((sum, row) => sum + microsOfSum(row.amount as string | null), 0n),
    rows.reduce((sum, row) => sum + Number(row.n), 0),
  );

/**
 * Settled sales dated between `from` and `at`, by merchant, and by UTC day
 * besides where `byDay`. The caller has refused any it could not add.
 */
const settledIn = (
  scope: OperatorScope,
  merchantIds: readonly string[],
  from: number,
  at: number,
  byDay = false,
): SQL => sql`
  with sales as (${settledSales(scope.network)})
  select merchant_id,
    ${byDay ? sql`to_char(to_timestamp(settled_at / 1000.0) at time zone 'UTC', 'YYYY-MM-DD')` : sql`''`} as per,
    count(*)::int as n, sum(amount::numeric)::text as amount
  from sales
  where merchant_id in ${listOf(merchantIds)} and settled_at between ${from} and ${at}
  group by merchant_id, per`;

function rowOf(row: Row, surface: SurfaceMode, settled: Tally, from: number): MerchantRow {
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

/**
 * Where a merchant stands in the list, as one row comparison in the list's
 * order: who waits for the operator, the latest sale (never is the least),
 * when they were made, and the identifier by its bytes.
 */
const PLACE = sql`((j.segment = 'waiting')::int, coalesce(j.last_sale, -1)::float8, j.created_ms,
  j.id collate "C")`;
const placeOf = (place: MerchantPlace): SQL =>
  sql`(${Number(place.waiting)}::int, ${place.lastSaleAt ?? -1}::float8, ${place.createdAt}::float8,
    ${place.id}::text collate "C")`;

export const postgresOperatorMerchants = (scope: OperatorScope): OperatorMerchants => ({
  async list(query) {
    const from = sellingFrom(query.at);
    return await scope.read(async (tx): Promise<MerchantList> => {
      // As the figures do: the list orders every merchant by their sales, so a
      // settled order anywhere that cannot be added fails the read.
      await refuseUnaddable(tx, SETTLED);
      const facts = judged(scope, query.at, query.surface);
      const page = query.from;
      const back = page !== undefined && "before" in page;
      const past =
        page === undefined
          ? undefined
          : "after" in page
            ? sql`${PLACE} < ${placeOf(page.after)}`
            : sql`${PLACE} > ${placeOf(page.before)}`;
      // Going on, the merchants short of the cursor precede the page; going
      // back, the ones past it are the page and every merchant before it.
      const ahead = past === undefined ? sql`false` : back ? past : sql`not (${past})`;
      const counted = await rowsOf(
        tx,
        sql`with ${facts} select j.segment, count(*)::int as n,
          (count(*) filter (where ${ahead}))::int as ahead
          from judged j where ${found(query)} group by 1`,
      );
      const segments = Object.fromEntries([
        ["all", counted.reduce((sum, row) => sum + Number(row.n), 0)],
        ...MERCHANT_SEGMENTS.map((segment) => [
          segment,
          Number(counted.find((row) => row.segment === segment)?.n ?? 0),
        ]),
      ]) as MerchantList["segments"];
      const inSegment = query.segment === undefined ? sql`true` : sql`j.segment = ${query.segment}`;
      const total = query.segment === undefined ? segments.all : segments[query.segment];
      const aheadOf = counted
        .filter((row) => query.segment === undefined || row.segment === query.segment)
        .reduce((sum, row) => sum + Number(row.ahead), 0);
      const direction = sql.raw(back ? "asc" : "desc");
      const limit = merchantLimitOf(query);
      // One more than the page, to tell whether the list goes on past it.
      const read = await rowsOf(
        tx,
        sql`with ${facts} select j.* from judged j
          where ${found(query)} and ${inSegment} and ${past ?? sql`true`}
          order by (j.segment = 'waiting') ${direction}, coalesce(j.last_sale, -1) ${direction},
            j.created_ms ${direction}, j.id collate "C" ${direction}
          limit ${limit + 1}`,
      );
      const rows = read.slice(0, limit);
      if (back) rows.reverse();
      const sales = await rowsOf(
        tx,
        settledIn(
          scope,
          rows.map((row) => String(row.id)),
          from,
          query.at,
        ),
      );
      const listed = rows.map((row) =>
        rowOf(
          row,
          query.surface,
          tallyFrom(sales.filter((sale) => sale.merchant_id === row.id)),
          from,
        ),
      );
      const newer = back ? aheadOf - listed.length : aheadOf;
      const older = back ? total - aheadOf > 0 : read.length > limit;
      const first = listed[0];
      const last = listed.at(-1);
      return {
        rows: listed,
        total,
        newer,
        previous: newer > 0 && first !== undefined ? merchantPlaceOf(first) : null,
        next: older && last !== undefined ? merchantPlaceOf(last) : null,
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
      await refuseUnaddable(tx, sql`${SETTLED} and orders.merchant_id = ${id}`);
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
      const byDay = await rowsOf(tx, settledIn(scope, [id], from, at, true));
      const worthy = sql`orders.merchant_id = ${id} and (${PAYMENT_UNKNOWN}
        or orders.state in (select jsonb_array_elements_text(${JSON.stringify(WORTH_A_LOOK_STATES)}::jsonb)))`;
      const worth = await rowsOf(
        tx,
        sql`select orders.id, orders.record -> 'order' as machine,
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
        days.push({ day, ...tallyFrom(sold) });
      }
      const {
        keys: _keys,
        cards: counts,
        thirtyDays,
        ...facts
      } = rowOf(head, surface, tallyFrom(byDay), from);
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
          working: Number(head.keys_working),
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
              status: outcomeFor(row.machine as Order),
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
