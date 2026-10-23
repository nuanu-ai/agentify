/**
 * The reads the workspace's Merchants and one merchant's page make across
 * merchants: the list with its segments and setup, a merchant's head facts,
 * keys, cards, selling and orders worth a look. A waiting wallet change is
 * said to wait and when it lands, never with its split's address.
 *
 * Every read answers as of the instant it is handed, on the surface it is
 * handed, because what a merchant lacks and whether a wallet change has landed
 * depend on both. It returns facts, never words: the dashboard words them.
 * A read that fails throws; nothing here stands a zero in for a failure.
 */

import {
  type MerchantSelling,
  type Order,
  type OrderState,
  readinessOf,
  type SurfaceMode,
} from "@agentify/core";
import type { Card, MerchantFinding, Money } from "@nuanu-ai/agentify-contracts";
import type { Integration } from "../store.js";

/**
 * Where a merchant stands, as the list's segments split them:
 * - `waiting`: on the live channel, a seller name and a payout wallet and no
 *   admission; the one decision only an operator takes. Whether their
 *   integration connected and whether cards are published are facts beside it,
 *   not conditions.
 * - `setting_up`: anything else the surface asks is missing, or nothing is
 *   missing and no card of the integration they sell through is published.
 * - `paused`: nothing is missing and nothing is on sale because the merchant
 *   paused their sales or every card of their integration.
 * - `selling`: nothing is missing and at least one card is on sale.
 */
export const MERCHANT_SEGMENTS = ["waiting", "selling", "setting_up", "paused"] as const;

export type MerchantSegment = (typeof MERCHANT_SEGMENTS)[number];

/** The longest list one read hands back, whatever it asked for. */
export const MERCHANT_LIST_MAX = 200;

/** How many of one merchant's keys, cards and orders worth a look one read hands back. */
export const MERCHANT_PAGE_CUT = { keys: 100, cards: 100, orders: 20 } as const;

/** The days a merchant's selling is counted over: today, UTC, and the twenty-nine before it. */
export const SELLING_DAYS = 30;

const DAY_MS = 86_400_000;

/** The first instant counted in the thirty days that end at `at`: midnight UTC, twenty-nine days before today. */
export const sellingFrom = (at: number): number =>
  Math.floor(at / DAY_MS) * DAY_MS - (SELLING_DAYS - 1) * DAY_MS;

/** The UTC day an instant falls on, as `YYYY-MM-DD`. */
export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** What a surface asks of every merchant before it sells their card, in the order the dots are drawn. */
export const askedOn = (surface: SurfaceMode): readonly MerchantFinding[] =>
  readinessOf({ sellerName: null, payoutWallet: null, liveApproval: false }, surface).asked;

/** The facts a merchant's segment is decided from. */
export interface SegmentFacts {
  readonly surface: SurfaceMode;
  readonly missing: readonly MerchantFinding[];
  readonly selling: MerchantSelling;
  /** Cards of the integration the merchant sells through, published. */
  readonly ofIntegration: number;
  /** Of those, the ones not paused. */
  readonly unpaused: number;
}

/** The segment a merchant stands in; the SQL twin is in the Postgres reader and the contract holds them alike. */
export function segmentOf(facts: SegmentFacts): MerchantSegment {
  if (facts.missing.length > 0) {
    const onlyAdmission = facts.missing.every((finding) => finding === "no_operator_approval");
    return facts.surface === "live" && onlyAdmission ? "waiting" : "setting_up";
  }
  if (facts.ofIntegration === 0) return "setting_up";
  if (facts.selling === "paused" || facts.unpaused === 0) return "paused";
  return "selling";
}

/**
 * Settled sales: payments whose money moved, one per receipt, with the sum in
 * each currency they were priced in, every amount an exact decimal written as
 * text with at least two places.
 */
export interface SettledSales {
  readonly count: number;
  readonly sums: readonly Money[];
}

/** A merchant's selling over the thirty days that end at the read's instant. */
export interface ThirtyDays {
  /** The first instant counted. */
  readonly from: number;
  /** Orders made in those days, attempts that lapsed unpaid left out. */
  readonly orders: number;
  /** Payments whose money moved in those days, by when it moved. */
  readonly settled: SettledSales;
}

/** One merchant as the list draws them. */
export interface MerchantRow {
  readonly id: string;
  /** The name buyers read, or null where none is set. */
  readonly serviceName: string | null;
  readonly sellerSite: string | null;
  readonly createdAt: number;
  readonly integration: Integration;
  readonly segment: MerchantSegment;
  /** What the surface asks that this merchant lacks, in the order `askedOn` lists it. */
  readonly missing: readonly MerchantFinding[];
  /** Keys issued in all, and how many of them still work. */
  readonly keys: { readonly issued: number; readonly working: number };
  /** The latest poll of the merchant's worker, or null where none was ever recorded. */
  readonly lastContactAt: number | null;
  readonly cards: { readonly onSale: number; readonly published: number };
  readonly thirtyDays: ThirtyDays;
  /** When the money of their latest settled sale moved, or null where none ever did. */
  readonly lastSaleAt: number | null;
}

export interface MerchantListQuery {
  readonly at: number;
  readonly surface: SurfaceMode;
  /**
   * Text found, ignoring case, in the seller name, the site or the merchant's
   * identifier. Blank or absent finds every merchant.
   */
  readonly search?: string;
  /**
   * Merchants the caller matched to the search by what this side does not
   * hold, an account's email address: listed whatever the text finds.
   */
  readonly alsoIds?: readonly string[];
  /** One segment, or every merchant where absent. */
  readonly segment?: MerchantSegment;
  /** At most this many rows, held between one and `MERCHANT_LIST_MAX`. */
  readonly limit: number;
}

/**
 * One cut of the list: its rows, first what needs the operator (waiting for
 * admission), then by the latest sale, newest first, merchants who never sold
 * after, newest merchant first; how many the search and segment find in all;
 * and how many the search finds in each segment.
 */
export interface MerchantList {
  readonly rows: readonly MerchantRow[];
  readonly total: number;
  readonly segments: Readonly<Record<MerchantSegment | "all", number>>;
}

/** A merchant's wallet as the page shows it. */
export interface MerchantWallet {
  /** The wallet paid now, as the merchant spelled it. */
  readonly address: string;
  /** The split payments go into now, or null where none is recorded for it: a defect, read as no wallet. */
  readonly split: string | null;
  /** A change the merchant made that has not landed yet: only when it lands. */
  readonly pending: { readonly landsAt: number } | null;
}

export interface MerchantKey {
  readonly id: string;
  readonly label: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly disabledAt: number | null;
}

export interface MerchantCard {
  readonly id: string;
  /** The card as the merchant published it, as agents read it. */
  readonly card: Card;
  readonly publishedAt: number;
  readonly paused: boolean;
  readonly integration: Integration;
  readonly onSale: boolean;
}

/** An order the page names because it may need explaining. */
export interface OrderWorthALook {
  readonly id: string;
  readonly state: OrderState;
  readonly payment: Order["payment"];
  /** The price the order is sold at, or the card's where none was named yet. */
  readonly price: Money;
  readonly createdAt: number;
  readonly itemId: string;
  /** The card's title where the card is still published, or null. */
  readonly title: string | null;
}

/** One cut of a list on a merchant's page, and how many there are in all. */
export interface Cut<T> {
  readonly rows: readonly T[];
  readonly total: number;
}

/** One UTC day of a merchant's settled sales; a day without any reads zero. */
export interface SellingDay extends SettledSales {
  readonly day: string;
}

export interface MerchantRecord extends Omit<MerchantRow, "keys" | "cards" | "thirtyDays"> {
  readonly selling: MerchantSelling;
  readonly liveApprovedAt: number | null;
  /** Null where the merchant never set a wallet. */
  readonly wallet: MerchantWallet | null;
  /** Newest first. */
  readonly keys: Cut<MerchantKey>;
  /** By the merchant's own item identifier. */
  readonly cards: Cut<MerchantCard> & { readonly onSale: number };
  readonly thirtyDays: ThirtyDays & {
    /** Every one of the thirty days, oldest first. */
    readonly days: readonly SellingDay[];
  };
  /**
   * Orders whose payment outcome nobody has said yet, and orders left
   * unfulfilled or delivered and not paid; newest first.
   */
  readonly worthALook: Cut<OrderWorthALook>;
}

export interface OperatorMerchants {
  /** The list, searched, narrowed to a segment and cut. */
  list(query: MerchantListQuery): Promise<MerchantList>;
  /** Everything one merchant's page draws from the gateway's records, or null where there is no such merchant. */
  merchant(
    id: string,
    at: Readonly<{ at: number; surface: SurfaceMode }>,
  ): Promise<MerchantRecord | null>;
}

/** Whether an order is one a merchant's page names as worth a look; the SQL twin is in the Postgres reader. */
export const WORTH_A_LOOK_STATES = [
  "unfulfilled",
  "delivered_unpaid",
] as const satisfies readonly OrderState[];

/** A list query's limit, held between one and the list's most. */
export const merchantLimitOf = (query: MerchantListQuery): number =>
  Math.max(1, Math.min(MERCHANT_LIST_MAX, Math.floor(query.limit)));

/** The search as it is matched: trimmed and in lower case, or null where it finds everybody. */
export const searchOf = (query: MerchantListQuery): string | null => {
  const text = query.search?.trim().toLowerCase() ?? "";
  return text === "" ? null : text;
};

// --- exact sums ---------------------------------------------------------------

/** The places every amount is held to while summed: the most an amount may carry. */
const PLACES = 18;
const SCALE = 10n ** BigInt(PLACES);

/** An exact decimal written as text, as an integer of its smallest places. */
export function scaledAmount(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (match === null) throw new Error(`"${amount}" is not an amount`);
  const [, whole = "0", fraction = ""] = match;
  if (fraction.length > PLACES)
    throw new Error(`"${amount}" carries more places than an amount may`);
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(PLACES, "0"));
}

/** A scaled integer written back as an amount, with at least two places and no trailing zeros past them. */
export function amountOfScaled(scaled: bigint): string {
  const whole = scaled / SCALE;
  const fraction = (scaled % SCALE).toString().padStart(PLACES, "0").replace(/0+$/, "");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}
