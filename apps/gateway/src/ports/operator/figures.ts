/**
 * The reads the workspace's Overview, Health and Money make: counts and sums
 * across merchants, each from one predicate shared with every place that shows
 * it, summed by day in the database so a busier month draws the same number
 * of bars.
 *
 * Every read is asked with the moment it reads at, counts its windows back
 * from it, and carries it back as `readAt`. A read that fails throws: a zero
 * comes only from a read that succeeded and found nothing. A day is a UTC
 * day, and "the last seven days" is today and the six before it, so a
 * period's total and the sum of its bars are one number.
 *
 * A settled sale is an order whose payment settled, whatever became of the
 * goods, dated by the moment the order records it as paid: the time of the
 * block where the payment was observed on the chain, otherwise when the order
 * entered paid, which is when the money moved for a payment taken at purchase
 * and when it was verified for one taken after the goods. A sale with no such
 * moment is counted in all time and in `undated`, never in a day. Payments
 * whose outcome is unknown are counted apart and never added to sales or to failures.
 */

import { readinessOf, type SurfaceMode } from "@agentify/core";
import type { Integration } from "../store.js";
import type { Dollars, Tally } from "./money.js";

/** What every read of figures is asked with. */
export interface FiguresAsked {
  /** The moment the read is made at: windows are counted back from it, and the answer carries it. */
  readonly at: number;
  /**
   * What this channel asks of a merchant before their cards are on sale: a
   * seller name everywhere, a payout wallet on the test and live channels, and
   * the operator's admission on the live channel alone.
   */
  readonly surface: SurfaceMode;
}

/** Every answer carries the moment it was read at. */
export interface Read {
  readonly readAt: number;
}

/** A merchant with a seller name and a payout wallet who is not admitted to live sales. */
interface WaitingMerchant {
  readonly merchantId: string;
  readonly name: string;
  readonly serviceName: string;
  readonly sellerSite: string | null;
  readonly createdAt: number;
  readonly integration: Integration;
  /** When their own process last polled, or null where no poll was ever recorded. */
  readonly lastContact: number | null;
  /** How many cards they have published, on sale or not. */
  readonly cardsPublished: number;
}

/** How many of the waiting merchants a read names; the rest are counted. */
export const WAITING_NAMED_AT_MOST = 20;

export interface WaitingForAdmission extends Read {
  /** Those who have waited longest first, at most `WAITING_NAMED_AT_MOST`. */
  readonly merchants: readonly WaitingMerchant[];
  /** How many wait in all. */
  readonly of: number;
}

/** How many of the merchants a read of the unknown payments names; the rest are counted. */
export const UNKNOWN_MERCHANTS_NAMED_AT_MOST = 10;

export interface UnknownPayments extends Read, Tally {
  /** When the oldest of them was sent for execution, or null where there are none. */
  readonly oldestSince: number | null;
  /** Whose they are, the merchant with most of them first. */
  readonly merchants: readonly {
    readonly merchantId: string;
    readonly name: string;
    readonly count: number;
  }[];
  /** How many merchants they belong to in all. */
  readonly merchantsOf: number;
}

/** A merchant whose purchases are refused because their own process stopped polling. */
interface SilentMerchant {
  readonly merchantId: string;
  readonly name: string;
  /** Their last poll, or null where none was ever recorded. */
  readonly since: number | null;
}

/** How many of the silent merchants a read names; the rest are counted. */
export const SILENT_NAMED_AT_MOST = 20;

export interface Workers extends Read {
  /** How many merchants' compatible processes polled within the purchase guard's window. */
  readonly connectedWithin: number;
  /** How many merchants' processes ever polled. */
  readonly everConnected: number;
  /**
   * The merchants selling through their own code, with a card on sale, whose
   * process has not polled with a compatible contract within the guard's window, so purchases
   * are being refused and their cards left out of the catalogue; the longest
   * silent first.
   */
  readonly silent: readonly SilentMerchant[];
  readonly silentOf: number;
}

/** The commerce analytics outbox, as far as its rows still exist. */
export interface AnalyticsOutbox extends Read {
  /** Events waiting to leave. */
  readonly waiting: number;
  /** Events the sender stopped trying after they waited too long. */
  readonly givenUp: number;
  /** When the earliest of those was given up, or null where none was. */
  readonly givenUpSince: number | null;
  /** Events Nuanu Analytics refused for good. */
  readonly refused: number;
}

export interface MerchantCounts extends Read {
  /** Every merchant on the channel. */
  readonly total: number;
  /** Those with at least one card on sale now. */
  readonly selling: number;
  /** Those admitted to live sales, whatever else they lack. */
  readonly admitted: number;
  /** Those with a seller name and a payout wallet who are not admitted. */
  readonly waitingForAdmission: number;
}

/** How many days `recentOrders` counts back. */
export const RECENT_DAYS = 7;

export interface RecentOrders extends Read {
  /** Orders made in the last `RECENT_DAYS` days. */
  readonly count: number;
  /** Of them, those delivered (a parcel handed to its carrier among them). */
  readonly delivered: number;
  /** Of them, those whose payment outcome is unknown. */
  readonly paymentUnknown: number;
}

/** The periods Money reads over. */
export type MoneyPeriod = "7d" | "30d" | "all";

/** How many UTC days each period holds, today included; null for all time. */
export const PERIOD_DAYS: Readonly<Record<MoneyPeriod, number | null>> = {
  "7d": 7,
  "30d": 30,
  all: null,
};

export interface Money extends Read {
  readonly period: MoneyPeriod;
  /** The first moment the period holds, or null for all time. */
  readonly from: number | null;
  /** Every settled sale. */
  /** Every settled sale of the period; for all time, the undated ones included. */
  readonly sales: Tally;
  /** Every settled sale whose order records no moment it was paid, which no day or period but all time holds. */
  readonly undated: Tally;
  /** The commission accrued in the splits on the part of `sales` paid into them. */
  readonly commission: Dollars;
  /** The part of `sales` paid into a recorded split. */
  readonly intoSplits: Tally;
  /**
   * The part of `sales` paid straight to a merchant's wallet, as payments were
   * before they went to splits; it carries no commission.
   */
  readonly straightToWallet: Tally;
  /** The part of `sales` whose order records no delivery. */
  readonly noDelivery: Tally;
  /** How those orders stand, by the order's state. */
  readonly noDeliveryByState: readonly { readonly state: string; readonly count: number }[];
}

/** How many days `salesByDay` draws. */
export const CHART_DAYS = 30;

interface SalesDay {
  /** The UTC day, as "2026-10-23". */
  readonly day: string;
  readonly delivered: Tally;
  readonly noDelivery: Tally;
}

export interface SalesByDay extends Read {
  /** Exactly `CHART_DAYS` days, the oldest first, today last; a day with nothing settled holds zeros. */
  readonly days: readonly SalesDay[];
  /** Every settled sale whose order records no moment it was paid, drawn on no day. */
  readonly undated: Tally;
}

/** The steps of the funnel, in order. */
export const FUNNEL_STEPS = [
  "created",
  "seller_name",
  "payout_wallet",
  "key_or_shop",
  "connected",
  "admitted",
  "card_on_sale",
  "first_sale",
] as const;

export type FunnelStep = (typeof FUNNEL_STEPS)[number];

/** What the gateway does not hold about shops, from the dashboard that does. */
interface ShopsConnected {
  /** The merchants whose WooCommerce shop is connected. */
  readonly merchantIds: readonly string[];
}

export interface Funnel extends Read {
  /**
   * How many merchants stand at each step or past it, each step counting only
   * those who took every step before it. `admitted` is left out on a channel
   * that admits nobody.
   */
  readonly steps: readonly { readonly step: FunnelStep; readonly merchants: number }[];
}

export interface OperatorFigures {
  /** The merchants waiting for the operator's admission; nobody waits on a channel that admits nobody. */
  waitingForAdmission(asked: FiguresAsked): Promise<WaitingForAdmission>;
  /** Every payment whose outcome is unknown now, through the one predicate the orders' segment uses. */
  unknownPayments(asked: FiguresAsked): Promise<UnknownPayments>;
  /** The merchants' processes: who polled lately, and whose purchases are refused for silence. */
  workers(asked: FiguresAsked): Promise<Workers>;
  analyticsOutbox(asked: FiguresAsked): Promise<AnalyticsOutbox>;
  merchantCounts(asked: FiguresAsked): Promise<MerchantCounts>;
  recentOrders(asked: FiguresAsked): Promise<RecentOrders>;
  money(asked: FiguresAsked, period: MoneyPeriod): Promise<Money>;
  /** Settled sales by UTC day over the last `CHART_DAYS` days. */
  salesByDay(asked: FiguresAsked): Promise<SalesByDay>;
  funnel(asked: FiguresAsked, shops: ShopsConnected): Promise<Funnel>;
}

const DAY_MS = 86_400_000;

/** The UTC day an instant falls on, counted from 1970-01-01. */
export const dayNumberOf = (at: number): number => Math.floor(at / DAY_MS);

/** A UTC day counted from 1970-01-01, written as "2026-10-23". */
export const dayWritten = (day: number): string =>
  new Date(day * DAY_MS).toISOString().slice(0, 10);

/** The first instant of the UTC day `days - 1` days before the one `at` falls on. */
export const daysBackFrom = (at: number, days: number): number =>
  (dayNumberOf(at) - (days - 1)) * DAY_MS;

/** The first instant after the UTC day `at` falls on. */
export const endOfDayOf = (at: number): number => (dayNumberOf(at) + 1) * DAY_MS;

/**
 * Strings in the order of their code points, as Postgres orders them under
 * the "C" collation, so a tie between two rows breaks the same way in both
 * readers whatever the database's locale.
 */
export const inCodeOrder = (one: string, other: string): number =>
  one < other ? -1 : one > other ? 1 : 0;

/**
 * Whether a channel asks for a payout wallet, and for the operator's
 * admission, before a card is on sale: the rule the gateway and the dashboard
 * share, asked of a merchant who has nothing.
 */
export const askedOn = (surface: SurfaceMode) => {
  const { asked } = readinessOf(
    { sellerName: null, payoutWallet: null, liveApproval: false },
    surface,
  );
  return {
    wallet: asked.includes("no_payout_wallet"),
    admission: asked.includes("no_operator_approval"),
  };
};
