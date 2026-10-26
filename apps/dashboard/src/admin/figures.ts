/**
 * The workspace's Overview, Health and Money. Every figure is read when the
 * page is asked for and says when it was read; each read stands alone, so one
 * that fails says "could not be read" in its own place and never draws a zero,
 * while the rest of the page is drawn. The views are built by the pure
 * functions below from what the reads answered, which the gallery calls with
 * its own example reads.
 *
 * Check now runs the facilitator-key check or the listing check and keeps the
 * last answer of each in this process, so Health shows it with when it was
 * asked. Neither changes anything, so neither asks for a fresh sign-in or
 * writes a journal row.
 */

import {
  type AnalyticsOutbox,
  CHART_DAYS,
  checkFacilitatorKey,
  checkListingNow,
  dollarsOf,
  type FacilitatorKeyCheck,
  type FiguresAsked,
  type Funnel,
  type FunnelStep,
  type GatewayHealthFacts,
  gatewayHealthFacts,
  type ListingCheck,
  type MerchantCounts,
  type Money,
  type MoneyPeriod,
  microsOf,
  overTheNetwork,
  type PayoutListing,
  payoutListing,
  type Reach,
  type RecentOrders,
  type SalesByDay,
  type Splits,
  type UnknownPayments,
  type WaitingForAdmission,
  type Workers,
} from "@agentify/gateway/operator";
import type { SectionCounts } from "@agentify/ui/workspace-view";
import type { AdReportCounts, LinkPurpose } from "../dashboard-entry.js";
import { LINK_CHANNEL_LIMIT } from "../identity.js";
import type { Outcome } from "../page-services.js";
import { dayOf, moment, ORDER_WORDS } from "../words.js";
import { type Operator, signedInFreshly } from "./access.js";
import { type JournalLineView, journalLinesOf } from "./accounts.js";
import { CHECK_FIELD } from "./fields.js";
import type { AdminParts } from "./parts.js";
import { type StepUpView, stepUpViewOf } from "./step-up.js";

export type {
  AnalyticsOutbox,
  Funnel,
  MerchantCounts,
  Money,
  PayoutListing,
  RecentOrders,
  SalesByDay,
  Splits,
  UnknownPayments,
  WaitingForAdmission,
  Workers,
} from "@agentify/gateway/operator";

// --- what a read answered --------------------------------------------------

/** A figure as a read answered it: what it found, or that it could not be read. */
export type Readable<T> = Readonly<{ kind: "read"; value: T }> | Readonly<{ kind: "unread" }>;

const UNREAD = { kind: "unread" } as const;

const readable = async <T>(what: string, read: () => Promise<T>): Promise<Readable<T>> => {
  try {
    return { kind: "read", value: await read() };
  } catch {
    console.error(`[dashboard] the workspace could not read ${what}`);
    return UNREAD;
  }
};

const foundIn = <T>(read: Readable<T>): T | null => (read.kind === "read" ? read.value : null);

// --- the words of numbers and moments --------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const two = (n: number) => String(n).padStart(2, "0");

/** A moment as every page of the dashboard writes it: "2026-10-23 14:05:00 UTC". */
const momentWritten = (at: number): string => moment(new Date(at).toISOString());

/** A day as every page of the dashboard writes it: "23 October 2026". */
const dayWritten = (at: number): string => dayOf(new Date(at).toISOString());

/** A day under a chart's bar, where the year is the chart's: "23 Oct". */
const chartDay = (at: number): string => {
  const d = new Date(at);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

/** "14:05". */
const clockWritten = (at: number): string => {
  const d = new Date(at);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
};

/** "3 h 12 min", "12 min", "2 d 3 h", "under a minute". */
const durationWritten = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const usd = (amount: string) => `${amount} USD`;

const sumOf = (...amounts: readonly string[]): string =>
  dollarsOf(amounts.reduce((all, amount) => all + microsOf(amount), 0n));

/** The share of every payment a split pays Agentify, as "0.1%". */
const shareWritten = (commission: number, total: number): string =>
  `${Number(((commission / total) * 100).toFixed(4))}%`;

// --- the views -------------------------------------------------------------

/** A badge: a tone of the dashboard's and the word in it. */
type Tone = "pass" | "fail" | "notice" | "partial" | "quiet" | "unknown" | "progress";

export interface Badge {
  readonly tone: Tone;
  readonly word: string;
}

/** A sentence of plain text and links, in order. */
export type Said = readonly (string | Readonly<{ text: string; href: string; elsewhere?: true }>)[];

export interface TileView {
  readonly label: string;
  /** The figure, or null where it could not be read. */
  readonly figure: string | null;
  readonly unit?: string;
  readonly of?: string;
  readonly aside: string;
}

interface BarView {
  readonly x: number;
  readonly y: number;
  readonly height: number;
  /** "bar", "bar zero", "bar nodel", "bar last". */
  readonly className: string;
  /** What a screen reader and a pointer read for this bar. */
  readonly label: string;
}

export interface ChartView {
  readonly aria: string;
  readonly ticks: readonly { readonly y: number; readonly label: string }[];
  readonly bars: readonly BarView[];
  readonly days: readonly { readonly x: number; readonly label: string; readonly end?: true }[];
  /** The value written beside the last bar, today's. */
  readonly today: { readonly x: number; readonly y: number; readonly label: string } | null;
  /** Every day in words, for a screen reader. */
  readonly spoken: readonly string[];
}

interface FunnelStepView {
  readonly label: string;
  readonly merchants: number;
  /** Of the first step, for the bar's length. */
  readonly width: string;
  /** Of the step before, empty for the first. */
  readonly rate: string;
}

interface NeedsYouItem {
  readonly merchantId: string;
  readonly name: string;
  readonly site: string | null;
  readonly why: string;
  readonly owner: string | null;
  readonly created: string;
}

interface WorthItem {
  readonly badge: Badge;
  readonly title: string;
  readonly href?: string;
  readonly aside: string;
  readonly why: string;
  readonly links: readonly { readonly label: string; readonly href: string }[];
  readonly meta: readonly string[];
}

export interface OverviewView {
  readonly asOf: string;
  readonly channel: string;
  /** Null on a channel that admits nobody, where nothing can wait for admission. */
  readonly needsYou: Readable<{ items: readonly NeedsYouItem[]; of: number }> | null;
  readonly worth: { readonly items: readonly WorthItem[]; readonly unread: readonly string[] };
  readonly tiles: readonly TileView[];
  readonly chart: Readable<{ head: string; chart: ChartView }>;
  readonly funnel: Readable<{ lead: string; steps: readonly FunnelStepView[] }>;
  readonly journal: Readable<{ lines: readonly JournalLineView[]; cut: string }>;
}

interface SplitRowView {
  readonly merchantId: string;
  readonly merchant: string | null;
  readonly split: string;
  readonly splitPage: string | null;
  readonly wallet: string;
  readonly settled: string;
  readonly empty: boolean;
  readonly since: string;
}

export type PayoutView =
  | Readonly<{
      kind: "listed";
      network: string;
      intro: string;
      parts: readonly {
        readonly title: string;
        readonly network: string;
        readonly to: string;
        readonly data: string;
        readonly pays: readonly string[];
        readonly commission: string;
      }[];
    }>
  | Readonly<{ kind: "said"; badge: Badge; said: string }>;

export interface MoneyView {
  readonly asOf: string;
  readonly periods: readonly {
    readonly label: string;
    readonly href: string;
    readonly here: boolean;
  }[];
  readonly tiles: readonly TileView[];
  readonly explained: string;
  readonly chart: Readable<{ chart: ChartView; foot: string }>;
  readonly splits: Readable<{ rows: readonly SplitRowView[]; count: number; cut: string }>;
  readonly payout: Readable<PayoutView>;
  readonly note: string;
}

export interface HealthRowView {
  readonly part: string;
  readonly badge: Badge;
  readonly fact: Said;
  /** "14:05", or "—" for what is not read. */
  readonly read: string;
  /** The check this row runs again at a press. */
  readonly check?: "key" | "listing";
}

export interface HealthView {
  readonly asOf: string;
  readonly lede: string;
  readonly grafana: string;
  readonly read: readonly HealthRowView[];
  readonly unseen: readonly HealthRowView[];
  readonly note: string;
  /**
   * Where a Check now press came from a sign-in older than the workspace
   * acts on, the step that asks for a fresh one; the check was not run.
   */
  readonly stepUp: StepUpView | null;
}

// --- the facts shared by the views ------------------------------------------

/** Where the channel's request rates, errors and hosts are drawn over time. */
const GRAFANA = "https://grafana.nuanu.ai/d/agentify-overview/service-health";

/** The site's own scanner page, outside the dashboard's prefix. */
const SCANNER_PAGE = "/admin";

const REPOSITORY = "https://github.com/nuanu-ai/agentify";

/** Where the orders whose payment outcome is unknown are listed. */
const UNKNOWN_ORDERS = "/admin/orders?segment=payment-unknown";

const CHANNEL_NAMES = { live: "Live channel", test: "Test channel", sandbox: "Sandbox" } as const;

const CHAIN_NAMES: Readonly<Record<string, string>> = {
  "eip155:8453": "Base",
  "eip155:84532": "Base Sepolia",
};

export interface Channel {
  readonly surface: FiguresAsked["surface"];
  readonly network: string;
  /** Where an address is looked at on the channel's chain, or null where there is none. */
  readonly addressPage: string | null;
  /** Agentify's share of every payment into a split. */
  readonly share: { readonly commission: number; readonly total: number };
}

const chainOf = (channel: Channel) => CHAIN_NAMES[channel.network] ?? channel.network;

// --- the chart --------------------------------------------------------------

const PLOT = { left: 44, right: 752, top: 14, base: 206, labels: 228 } as const;
const BAR = 14;

/** A scale whose four steps are 1, 2 or 5 times a power of ten and reach past `most`. */
const stepOver = (most: number): number => {
  if (most <= 0) return 1;
  const rough = most / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  return ([1, 2, 5, 10].find((m) => m * power >= rough) ?? 10) * power;
};

/**
 * Thirty bars of settled sales, the oldest first, today last. With `stacked`
 * the part paid with no delivery recorded stands on top of the delivered
 * part; without it, each bar is the day's whole. The bars' lengths come from
 * the exact amounts; only the drawing is approximate.
 */
export function chartOf(sales: SalesByDay, stacked: boolean): ChartView {
  const width = (PLOT.right - PLOT.left) / CHART_DAYS;
  const totals = sales.days.map((day) => sumOf(day.delivered.amount, day.noDelivery.amount));
  const step = stepOver(Math.max(...totals.map(Number)));
  const height = PLOT.base - PLOT.top;
  const scale = (amount: string) => (Number(amount) / (step * 4)) * height;
  const last = sales.days.length - 1;
  const bars: BarView[] = [];
  const spoken: string[] = [];
  sales.days.forEach((day, index) => {
    const x = Number((PLOT.left + index * width + (width - BAR) / 2).toFixed(1));
    const when =
      index === last
        ? `${chartDay(Date.parse(day.day))}, until ${clockWritten(sales.readAt)} UTC`
        : chartDay(Date.parse(day.day));
    const total = totals[index] ?? "0.00";
    if (day.delivered.count + day.noDelivery.count === 0) {
      bars.push({
        x,
        y: PLOT.base - 2,
        height: 2,
        className: "bar zero",
        label: `${when}: nothing settled`,
      });
      spoken.push(`${when}: nothing settled`);
      return;
    }
    const tail = index === last ? " last" : "";
    if (!stacked) {
      const h = Math.max(scale(total), 2);
      bars.push({
        x,
        y: Number((PLOT.base - h).toFixed(1)),
        height: Number(h.toFixed(1)),
        className: `bar${tail}`,
        label: `${when}: ${usd(total)} settled`,
      });
      spoken.push(
        `${when}: ${usd(total)} settled in ${plural(day.delivered.count + day.noDelivery.count, "order")}`,
      );
      return;
    }
    const lower = scale(day.delivered.amount);
    if (day.delivered.count > 0) {
      bars.push({
        x,
        y: Number((PLOT.base - lower).toFixed(1)),
        height: Number(Math.max(lower, 2).toFixed(1)),
        className: `bar${tail}`,
        label: `${when}: ${usd(day.delivered.amount)} delivered`,
      });
    }
    if (day.noDelivery.count > 0) {
      const upper = Math.max(scale(day.noDelivery.amount), 2);
      bars.push({
        x,
        y: Number((PLOT.base - lower - upper).toFixed(1)),
        height: Number(upper.toFixed(1)),
        className: "bar nodel",
        label: `${when}: ${usd(day.noDelivery.amount)} paid with no delivery recorded`,
      });
    }
    spoken.push(
      `${when}: ${usd(total)} settled, ${usd(day.delivered.amount)} of it delivered and ${usd(day.noDelivery.amount)} with no delivery recorded`,
    );
  });

  const first = sales.days[0]?.day ?? "";
  const final = sales.days[last]?.day ?? "";
  const whole = sumOf(...totals);
  const lastTotal = totals[last] ?? "0.00";
  const lastBar = [...bars].reverse().find((bar) => bar.x === bars[bars.length - 1]?.x);
  return {
    aria: `Settled sales per day from ${dayWritten(Date.parse(first))} to ${dayWritten(Date.parse(final))}, ${usd(whole)} in all`,
    ticks: [0, 1, 2, 3, 4].map((n) => ({
      y: PLOT.base - (n * height) / 4,
      label: String(Number((n * step).toFixed(6))),
    })),
    bars,
    days: [
      ...[0, 7, 14, 21].map((index) => ({
        x: Number((PLOT.left + index * width + width / 2).toFixed(1)),
        label: chartDay(Date.parse(sales.days[index]?.day ?? first)),
      })),
      {
        x: Number((PLOT.left + last * width + width / 2 - 6).toFixed(1)),
        label: "Today",
        end: true,
      },
    ],
    today:
      lastTotal === "0.00" || lastBar === undefined
        ? null
        : {
            x: Number((PLOT.left + last * width + width / 2 + 1.2).toFixed(1)),
            y: Number(
              (
                Math.min(...bars.filter((bar) => bar.x === lastBar.x).map((bar) => bar.y)) - 8
              ).toFixed(1),
            ),
            label: lastTotal,
          },
    spoken,
  };
}

// --- the overview -----------------------------------------------------------

/** What the overview's reads answered. */
export interface OverviewReads {
  readonly at: number;
  readonly channel: Channel;
  readonly waiting: Readable<WaitingForAdmission>;
  /** Each waiting merchant's owner, by merchant. */
  readonly owners: Readable<ReadonlyMap<string, string>>;
  readonly unknown: Readable<UnknownPayments>;
  readonly workers: Readable<Workers>;
  readonly analytics: Readable<AnalyticsOutbox>;
  readonly adReports: Readable<AdReportCounts>;
  readonly links: Readable<Readonly<Record<LinkPurpose, number>>>;
  /** Null where the deployment offers no connector. */
  readonly uncertainShopOrders: Readable<number> | null;
  readonly recovery: GatewayHealthFacts["recovery"];
  readonly merchants: Readable<MerchantCounts>;
  readonly orders: Readable<RecentOrders>;
  readonly week: Readable<Money>;
  readonly sales: Readable<SalesByDay>;
  readonly funnel: Readable<Funnel>;
  /** The newest rows of the journal, as the Journal draws them. */
  readonly journal: Readable<{ lines: readonly JournalLineView[]; total: number }>;
}

const FUNNEL_WORDS: Readonly<Record<FunnelStep, string>> = {
  created: "Created a merchant",
  seller_name: "Set a seller name",
  payout_wallet: "Saved a payout wallet",
  key_or_shop: "Issued a key or connected a shop",
  connected: "Integration connected",
  admitted: "Admitted",
  card_on_sale: "Card on sale",
  first_sale: "First sale",
};

const percent = (part: number, whole: number) =>
  whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`;

function funnelViewOf(funnel: Funnel): { lead: string; steps: readonly FunnelStepView[] } {
  const first = funnel.steps[0]?.merchants ?? 0;
  return {
    lead: `All ${plural(first, "merchant")}, as they stand`,
    steps: funnel.steps.map((step, index) => {
      const before = funnel.steps[index - 1]?.merchants;
      return {
        label: FUNNEL_WORDS[step.step],
        merchants: step.merchants,
        width: first === 0 ? "0%" : `${Number(((step.merchants / first) * 100).toFixed(1))}%`,
        rate: before === undefined ? "" : percent(step.merchants, before),
      };
    }),
  };
}

const needsYouOf = (
  waiting: WaitingForAdmission,
  owners: ReadonlyMap<string, string> | null,
  at: number,
): { items: readonly NeedsYouItem[]; of: number } => ({
  of: waiting.of,
  items: waiting.merchants.map((merchant) => {
    const integration =
      merchant.integration === "woocommerce"
        ? "It sells through a WooCommerce shop."
        : merchant.lastContact === null
          ? "Its worker has never connected."
          : `Its worker connected ${durationWritten(at - merchant.lastContact)} ago.`;
    const cards =
      merchant.cardsPublished === 0
        ? "No card is published yet."
        : `${plural(merchant.cardsPublished, "card")} ${merchant.cardsPublished === 1 ? "is" : "are"} published; they stay off sale on the live channel until it is admitted.`;
    return {
      merchantId: merchant.merchantId,
      name: merchant.serviceName,
      site: merchant.sellerSite === null ? null : new URL(merchant.sellerSite).host,
      why: `Seller name and payout wallet are set, so admission is the only check missing. ${integration} ${cards} The merchant's dashboard tells them they are not approved and gives them no way to ask.`,
      owner: owners?.get(merchant.merchantId) ?? null,
      created: `Merchant created ${momentWritten(merchant.createdAt)}`,
    };
  }),
});

/** The facts worth a look, each from its own read; a read that failed is named instead. */
function worthOf(reads: OverviewReads): OverviewView["worth"] {
  const items: WorthItem[] = [];
  const unread: string[] = [];
  const { at, channel } = reads;

  const unknown = foundIn(reads.unknown);
  if (unknown === null) unread.push("the payments whose outcome is unknown");
  else if (unknown.count > 0) {
    const [only] = unknown.merchants;
    items.push({
      badge: { tone: "unknown", word: "Payment outcome unknown" },
      title: `${plural(unknown.count, "payment")} with an unknown outcome`,
      href: UNKNOWN_ORDERS,
      aside:
        unknown.oldestSince === null ? "" : `oldest ${durationWritten(at - unknown.oldestSince)}`,
      why: reads.recovery.configured
        ? "The facilitator did not say whether the money moved. Recovery reads the chain and settles each order once it finds the transfer or proof that it cannot happen. Nobody settles them by hand."
        : "The facilitator did not say whether the money moved, and payment recovery is not configured on this channel, so nothing reads the chain for them. Nobody settles them by hand.",
      links: [
        { label: `See the ${unknown.count === 1 ? "order" : "orders"}`, href: UNKNOWN_ORDERS },
      ],
      meta:
        unknown.merchantsOf === 1 && only !== undefined
          ? [
              `${unknown.count === 1 ? "It is" : unknown.count === 2 ? "Both are" : "All are"} ${only.name}'s`,
            ]
          : [`Of ${plural(unknown.merchantsOf, "merchant")}`],
    });
  }

  if (!reads.recovery.configured && channel.surface !== "sandbox") {
    items.push({
      badge: { tone: "fail", word: "Recovery off" },
      title: "Payment recovery is not configured on this channel",
      aside: "",
      why: "No chain endpoint is set, so a payment whose answer was lost stays unknown until the facilitator answers. Health says what recovery reads when it is set.",
      links: [{ label: "See Health", href: "/admin/health" }],
      meta: [],
    });
  }

  const workers = foundIn(reads.workers);
  if (workers === null) unread.push("the merchants' workers");
  else {
    for (const silent of workers.silent) {
      items.push({
        badge: { tone: "fail", word: "Worker out of touch" },
        title: `${silent.name}'s worker has stopped polling`,
        href: `/admin/merchants/${silent.merchantId}`,
        aside:
          silent.since === null
            ? "never connected"
            : `since ${durationWritten(at - silent.since)} ago`,
        why: "Its cards on sale are paid before their goods, so the gateway refuses their purchases until the worker polls again; nothing was charged for them.",
        links: [{ label: "See the merchant", href: `/admin/merchants/${silent.merchantId}` }],
        meta: [],
      });
    }
    if (workers.silentOf > workers.silent.length) {
      items.push({
        badge: { tone: "fail", word: "Worker out of touch" },
        title: `${plural(workers.silentOf - workers.silent.length, "more merchant")} out of touch`,
        aside: "",
        why: "The list names the longest silent first.",
        links: [{ label: "See Health", href: "/admin/health" }],
        meta: [],
      });
    }
  }

  if (reads.uncertainShopOrders !== null) {
    const uncertain = foundIn(reads.uncertainShopOrders);
    if (uncertain === null) unread.push("the WooCommerce orders");
    else if (uncertain > 0) {
      items.push({
        badge: { tone: "partial", word: "Shop order uncertain" },
        title: `${plural(uncertain, "WooCommerce order")} whose shop order may or may not exist`,
        aside: "",
        why: "An attempt sent each to its shop and never heard back. The merchant recovers such an order from their own Orders; the workspace does not.",
        links: [],
        meta: [],
      });
    }
  }

  const analytics = foundIn(reads.analytics);
  if (analytics === null) unread.push("the commerce analytics outbox");
  else if (analytics.givenUp + analytics.refused > 0) {
    items.push({
      badge: { tone: "partial", word: "Given up" },
      title: `${plural(analytics.givenUp + analytics.refused, "commerce analytics event")} ${analytics.givenUp + analytics.refused === 1 ? "was" : "were"} not delivered`,
      aside: analytics.givenUpSince === null ? "" : `since ${dayWritten(analytics.givenUpSince)}`,
      why: `${analytics.givenUp > 0 ? `${plural(analytics.givenUp, "event")} waited too long and the outbox stopped trying` : ""}${analytics.givenUp > 0 && analytics.refused > 0 ? "; " : ""}${analytics.refused > 0 ? `${plural(analytics.refused, "event")} Nuanu Analytics refused` : ""}. Sales, payments and receipts are not affected.`,
      links: [{ label: "See the outboxes in Health", href: "/admin/health" }],
      meta: [],
    });
  }

  const ads = foundIn(reads.adReports);
  if (ads === null) unread.push("the ad reports");
  else if (ads.givenUp + ads.refused > 0) {
    items.push({
      badge: { tone: "partial", word: "Given up" },
      title: `${plural(ads.givenUp + ads.refused, "sign-up report")} to the ad network ${ads.givenUp + ads.refused === 1 ? "was" : "were"} not delivered in 30 days`,
      aside: "",
      why: `${ads.givenUp} given up and ${ads.refused} refused. Nothing a merchant or a buyer does depends on them.`,
      links: [{ label: "See the outboxes in Health", href: "/admin/health" }],
      meta: [],
    });
  }

  const links = foundIn(reads.links);
  if (links === null) unread.push("the sign-in links sent this hour");
  else {
    for (const [purpose, word] of [
      ["dashboard", "Sign-in links"],
      ["report", "Report links"],
    ] as const) {
      if (links[purpose] >= NEAR_THE_CEILING) {
        items.push({
          badge: {
            tone: links[purpose] >= LINK_CHANNEL_LIMIT ? "fail" : "partial",
            word: "Near the ceiling",
          },
          title: `${word}: ${links[purpose]} of ${LINK_CHANNEL_LIMIT} this hour`,
          aside: "",
          why: "At the ceiling nobody on the channel gets an emailed link until the hour clears; Google sign-in does not pass through it.",
          links: [{ label: "See Health", href: "/admin/health" }],
          meta: [],
        });
      }
    }
  }
  return { items, unread };
}

/** From how many links of one purpose in the hour the channel is near its ceiling. */
const NEAR_THE_CEILING = Math.floor(LINK_CHANNEL_LIMIT * 0.8);

export function overviewViewOf(reads: OverviewReads): OverviewView {
  const { at, channel } = reads;
  const merchants = foundIn(reads.merchants);
  const orders = foundIn(reads.orders);
  const week = foundIn(reads.week);
  const live = channel.surface === "live";
  const share = shareWritten(channel.share.commission, channel.share.total);
  const tiles: TileView[] = [
    {
      label: "Merchants selling",
      figure: merchants === null ? null : String(merchants.selling),
      ...(merchants === null ? {} : { of: `of ${merchants.total}` }),
      aside:
        merchants === null
          ? "Merchants with a card on sale now"
          : live
            ? `${merchants.admitted} admitted · ${merchants.waitingForAdmission} waiting for admission`
            : "With a card on sale now; the test channel admits nobody",
    },
    {
      label: "Orders · 7 days",
      figure: orders === null ? null : String(orders.count),
      aside:
        orders === null
          ? "Orders made in the last seven days"
          : `${orders.delivered} delivered · ${orders.paymentUnknown} payment unknown · ${orders.count - orders.delivered - orders.paymentUnknown} other; ${plural(orders.lapsed, "lapsed attempt")} apart`,
    },
    {
      label: "Settled sales · 7 days",
      figure: week === null ? null : week.sales.amount,
      unit: "USD",
      aside:
        week === null
          ? "Orders whose payment settled"
          : `${plural(week.sales.count, "order")} whose payment settled`,
    },
    {
      label: "Commission accrued · 7 days",
      figure: week === null ? null : week.commission,
      unit: "USD",
      aside: `${share} of settled sales paid into splits, in the splits until paid out`,
    },
  ];
  const sales = foundIn(reads.sales);
  const journal = foundIn(reads.journal);
  return {
    asOf: `${CHANNEL_NAMES[channel.surface]} · figures read ${momentWritten(at)} · read the page again to read them again`,
    channel: CHANNEL_NAMES[channel.surface],
    needsYou: !live
      ? null
      : reads.waiting.kind === "unread"
        ? UNREAD
        : { kind: "read", value: needsYouOf(reads.waiting.value, foundIn(reads.owners), at) },
    worth: worthOf(reads),
    tiles,
    chart:
      sales === null
        ? UNREAD
        : {
            kind: "read",
            value: {
              head: (() => {
                const all = sales.days.flatMap((day) => [day.delivered, day.noDelivery]);
                const count = all.reduce((n, tally) => n + tally.count, 0);
                return `${usd(sumOf(...all.map((tally) => tally.amount)))} across ${plural(count, "order")}`;
              })(),
              chart: chartOf(sales, false),
            },
          },
    funnel:
      reads.funnel.kind === "unread"
        ? UNREAD
        : { kind: "read", value: funnelViewOf(reads.funnel.value) },
    journal:
      journal === null
        ? UNREAD
        : {
            kind: "read",
            value: {
              lines: journal.lines,
              cut: `${journal.lines.length} of ${plural(journal.total, "action")} on this channel`,
            },
          },
  };
}

// --- money ------------------------------------------------------------------

export interface MoneyReads {
  readonly at: number;
  readonly channel: Channel;
  readonly period: MoneyPeriod;
  readonly money: Readable<Money>;
  readonly unknown: Readable<UnknownPayments>;
  readonly sales: Readable<SalesByDay>;
  readonly splits: Readable<Splits>;
  readonly payout: Readable<PayoutListing>;
}

const PERIODS: readonly (readonly [MoneyPeriod, string, string])[] = [
  ["7d", "7 days", "in the last 7 days"],
  ["30d", "30 days", "in the last 30 days"],
  ["all", "All time", "in all time"],
];

/** The period a query names, the last thirty days where it names none or another. */
export const periodIn = (query: URLSearchParams): MoneyPeriod => {
  const asked = query.get("period");
  return PERIODS.find(([key]) => key === asked)?.[0] ?? "30d";
};

/** How an order that settled with no delivery recorded stands, in the dashboard's words. */
const stateWords = (state: string): string =>
  state === "unfulfilled"
    ? ORDER_WORDS.unfulfilled.text.toLowerCase()
    : state === "fulfillment_closed"
      ? "fulfillment closed by its merchant"
      : state === "paid" || state === "dispatched"
        ? ORDER_WORDS.in_progress.text.toLowerCase()
        : state.replaceAll("_", " ");

/** The day payments began to go into splits, before which live payments went straight to the wallet. */
const SPLITS_SINCE = "15 October 2026";

const waitingLeftOut = (waiting: number): string =>
  waiting === 0
    ? ""
    : ` ${plural(waiting, "split")} waiting behind a wallet change ${waiting === 1 ? "is" : "are"} left out until the change lands.`;

export function payoutViewOf(listing: PayoutListing): PayoutView {
  switch (listing.kind) {
    case "sandbox":
      return {
        kind: "said",
        badge: { tone: "quiet", word: "Sandbox" },
        said: "Nothing settles on a sandbox and no payout split is ever deployed, so there is nothing to pay out.",
      };
    case "refused":
      return {
        kind: "said",
        badge: { tone: "fail", word: "Not shown" },
        said: `No payout is shown, because the gateway would refuse to start on these splits: ${listing.why}.`,
      };
    case "nothing_recorded":
      return {
        kind: "said",
        badge: { tone: "quiet", word: "Nothing to pay out" },
        said:
          listing.waiting === 0
            ? `No payout split is recorded on ${listing.chain.name}, so there is nothing to pay out.`
            : `Nothing is to pay out on ${listing.chain.name}:${waitingLeftOut(listing.waiting)}`,
      };
    case "listed":
      return {
        kind: "listed",
        network: listing.chain.name,
        intro: `${listing.parts.length === 1 ? "One transaction" : `${listing.parts.length} transactions`} for all ${plural(listing.splits, "recorded split")}, in parts of twenty: each split is created where it has no code yet, distributed, and its merchant's share withdrawn; the commission comes last. Send ${listing.parts.length === 1 ? "it" : "each"} on ${listing.chain.name} only, from a wallet of your own, which pays the gas. Agentify signs and sends nothing.${waitingLeftOut(listing.waiting)}`,
        parts: listing.parts.map((part, index) => ({
          title: `Payout ${index + 1} of ${listing.parts.length}`,
          network: listing.chain.name,
          to: part.to,
          data: part.data,
          pays: part.splits.map(
            (split) => `${split.address} of ${split.merchantId}, to ${split.merchantWallet}`,
          ),
          commission: `and the commission, to ${part.commissionWallets.join(" and ")}`,
        })),
      };
  }
}

export function moneyViewOf(reads: MoneyReads): MoneyView {
  const { at, channel, period } = reads;
  const money = foundIn(reads.money);
  const unknown = foundIn(reads.unknown);
  const within = PERIODS.find(([key]) => key === period)?.[2] ?? "";
  const share = shareWritten(channel.share.commission, channel.share.total);
  const tiles: TileView[] = [
    {
      label: "Settled sales",
      figure: money === null ? null : money.sales.amount,
      unit: "USD",
      aside:
        money === null
          ? `Orders whose payment settled ${within}`
          : `${plural(money.sales.count, "order")} ${within}${
              money.undated.count === 0
                ? ""
                : period === "all"
                  ? `, ${money.undated.count} of them with no moment of payment recorded`
                  : `; ${plural(money.undated.count, "sale")} with no moment of payment recorded ${money.undated.count === 1 ? "is" : "are"} counted in all time only`
            }`,
    },
    {
      label: "Commission accrued",
      figure: money === null ? null : money.commission,
      unit: "USD",
      aside:
        money === null
          ? `${share} of what was paid into splits`
          : `${share} of ${usd(money.intoSplits.amount)} paid into splits${
              money.straightToWallet.count === 0
                ? ""
                : `; ${usd(money.straightToWallet.amount)} went straight to the wallet, with no commission`
            }; in the splits until paid out`,
    },
    {
      label: "Paid, no delivery recorded",
      figure: money === null ? null : money.noDelivery.amount,
      unit: "USD",
      aside:
        money === null
          ? "Orders whose payment settled with no delivery recorded"
          : money.noDelivery.count === 0
            ? "No such order"
            : `${plural(money.noDelivery.count, "order")}: ${money.noDeliveryByState
                .map((each) => `${each.count} ${stateWords(each.state)}`)
                .join(", ")}`,
    },
    {
      label: "Outcome unknown",
      figure: unknown === null ? null : unknown.amount,
      unit: "USD",
      aside:
        unknown === null
          ? "Payments counted apart, never as sales or failures"
          : `${plural(unknown.count, "payment")} now, counted apart, never as sales or failures`,
    },
  ];

  const sales = foundIn(reads.sales);
  const splits = foundIn(reads.splits);
  return {
    asOf: `${CHANNEL_NAMES[channel.surface]} · read ${momentWritten(at)} · USDC on ${chainOf(channel)}, in US dollars`,
    periods: PERIODS.map(([key, label]) => ({
      label,
      href: key === "30d" ? "/admin/money" : `/admin/money?period=${key}`,
      here: key === period,
    })),
    tiles,
    explained: `A settled sale is an order whose payment settled, whatever became of the goods, dated by the moment the order records it as paid, in UTC. The money of an unfulfilled or closed order is in the merchant's split like any other, so it counts, and the third figure shows how much of the total it is. Commission accrues only where a payment went into a split${channel.surface === "live" ? `; before ${SPLITS_SINCE} live payments went straight to the merchant's wallet, with no commission` : ""}. Amounts are summed from each order when the page is read.`,
    chart:
      sales === null
        ? UNREAD
        : {
            kind: "read",
            value: {
              chart: chartOf(sales, true),
              foot: (() => {
                const whole = sumOf(
                  ...sales.days.flatMap((day) => [day.delivered.amount, day.noDelivery.amount]),
                );
                const count = sales.days.reduce(
                  (n, day) => n + day.delivered.count + day.noDelivery.count,
                  0,
                );
                const nodel = sales.days.reduce((n, day) => n + day.noDelivery.count, 0);
                const nodelAmount = sumOf(...sales.days.map((day) => day.noDelivery.amount));
                const undated =
                  sales.undated.count === 0
                    ? ""
                    : ` ${plural(sales.undated.count, "sale")} with no moment of payment recorded ${sales.undated.count === 1 ? "is" : "are"} on no day.`;
                return `${usd(whole)} across ${plural(count, "order")}${nodel === 0 ? "" : `, of which ${usd(nodelAmount)} paid for ${plural(nodel, "order")} with no delivery recorded`}.${undated} A past day can still grow when a late outcome lands.`;
              })(),
            },
          },
    splits:
      splits === null
        ? UNREAD
        : {
            kind: "read",
            value: {
              count: splits.of,
              rows: splits.rows.map((row) => ({
                merchantId: row.merchantId,
                merchant: row.merchantName,
                split: row.address,
                splitPage:
                  channel.addressPage === null ? null : `${channel.addressPage}${row.address}`,
                wallet: row.merchantWallet,
                settled: usd(row.settled.amount),
                empty: row.settled.count === 0,
                since: row.inForce
                  ? `Since ${dayWritten(row.recordedAt)}`
                  : `${dayWritten(row.recordedAt)}, an earlier wallet`,
              })),
              cut: [
                `${splits.rows.length} of ${plural(splits.of, "split")} shown`,
                ...(splits.empty === 0 ? [] : [`${splits.empty} hold nothing settled`]),
                ...(splits.waiting === 0
                  ? []
                  : [
                      `${plural(splits.waiting, "split")} waiting behind a wallet change ${splits.waiting === 1 ? "is" : "are"} not listed`,
                    ]),
              ].join(" · "),
            },
          },
    payout:
      reads.payout.kind === "unread"
        ? UNREAD
        : { kind: "read", value: payoutViewOf(reads.payout.value) },
    note: `Settled into it is summed from the orders. What a split has already paid out, and so what Agentify's commission wallet has received, is read on the chain's explorer, and this screen does not claim it.`,
  };
}

// --- health -----------------------------------------------------------------

export interface HealthReads {
  readonly at: number;
  readonly channel: Channel;
  readonly facts: GatewayHealthFacts;
  readonly unknown: Readable<UnknownPayments>;
  readonly workers: Readable<Workers>;
  readonly analytics: Readable<AnalyticsOutbox>;
  readonly adReports: Readable<AdReportCounts>;
  readonly links: Readable<Readonly<Record<LinkPurpose, number>>>;
  /** Null where the deployment offers no connector. */
  readonly shops: Readable<{ connected: number; uncertain: number }> | null;
  readonly keyCheck: FacilitatorKeyCheck | null;
  readonly listingCheck: (ListingCheck & { readonly checkedAt: number }) | null;
}

const COULD_NOT: Badge = { tone: "unknown", word: "Could not be read" };

function keyRowOf(check: FacilitatorKeyCheck | null): HealthRowView {
  if (check === null) {
    return {
      part: "Facilitator key",
      badge: { tone: "quiet", word: "Not checked here yet" },
      fact: [
        "The release checks the key before it activates a revision. Check now asks Coinbase again; nothing is bought.",
      ],
      read: "—",
      check: "key",
    };
  }
  const badge: Badge =
    check.outcome === "taken"
      ? { tone: "pass", word: "Accepted" }
      : check.outcome === "refused"
        ? { tone: "fail", word: "Refused" }
        : check.outcome === "unconfirmed"
          ? { tone: "partial", word: "No answer" }
          : { tone: "quiet", word: "Not Coinbase's" };
  return {
    part: "Facilitator key",
    badge,
    fact: [`Asked ${momentWritten(check.checkedAt)}: ${check.said}.`],
    read: clockWritten(check.checkedAt),
    check: "key",
  };
}

export function listingRowOf(
  check: (ListingCheck & { readonly checkedAt: number }) | null,
): HealthRowView {
  const base = { part: "x402 validation", check: "listing" as const };
  if (check === null) {
    return {
      ...base,
      badge: { tone: "quiet", word: "Not checked here yet" },
      fact: [
        "Whether Coinbase's x402 validator would take the channel's paid resources. Check now asks it; nothing is bought.",
      ],
      read: "—",
    };
  }
  const asked = `Asked ${momentWritten(check.checkedAt)}`;
  const read = clockWritten(check.checkedAt);
  switch (check.kind) {
    case "catalog_unreadable":
      return {
        ...base,
        badge: { tone: "partial", word: "Catalog unread" },
        fact: [`${asked}: the catalog could not be read (${check.why}), so nothing was checked.`],
        read,
      };
    case "nothing_on_sale":
      return {
        ...base,
        badge: { tone: "quiet", word: "Nothing on sale" },
        fact: [`${asked}: nothing is on sale, so there was nothing to check.`],
        read,
      };
    case "checked": {
      const products = check.resources.length;
      if (check.passed) {
        return {
          ...base,
          badge: { tone: "pass", word: `Would take all ${products}` },
          fact: [
            `${asked}: Coinbase's x402 validator and the gateway's own door accepted all ${check.probes} probes over ${plural(products, "paid resource")}.`,
          ],
          read,
        };
      }
      const said = [
        ...(check.refused.length === 0
          ? []
          : [
              `${check.refused.length} of ${check.probes} probes were refused: ${check.refused.join("; ")}`,
            ]),
        ...(check.unanswered.length === 0
          ? []
          : [
              `${check.unanswered.length} of ${check.probes} got no verdict, so nothing is proven about them: ${check.unanswered.join("; ")}`,
            ]),
        ...(check.unchecked.length === 0
          ? []
          : [
              `the check ran out of time before ${plural(check.unchecked.length, "product")}, so nothing is said about ${check.unchecked.length === 1 ? "it" : "them"}: ${check.unchecked.slice(0, 10).join(", ")}${check.unchecked.length > 10 ? ` and ${check.unchecked.length - 10} more` : ""}`,
            ]),
      ].join(". ");
      return {
        ...base,
        badge:
          check.refused.length > 0
            ? { tone: "fail", word: `${check.refused.length} refused` }
            : check.unanswered.length > 0
              ? { tone: "partial", word: "No verdict" }
              : { tone: "partial", word: "Partly checked" },
        fact: [`${asked}: ${said || "some products had no address to check"}.`],
        read,
      };
    }
  }
}

export function healthViewOf(reads: HealthReads): HealthView {
  const { at, channel, facts } = reads;
  const now = clockWritten(at);
  const rows: HealthRowView[] = [];

  rows.push(
    facts.revision === null
      ? {
          part: "Release",
          badge: { tone: "quiet", word: "Unknown revision" },
          fact: [
            'The image carries no source revision, as one built on a laptop does, so it says "unknown" and links nowhere.',
          ],
          read: now,
        }
      : {
          part: "Release",
          badge: { tone: "pass", word: "Running" },
          fact: [
            "Source revision ",
            {
              text: facts.revision.slice(0, 7),
              href: `${REPOSITORY}/commit/${facts.revision}`,
              elsewhere: true,
            },
            ", written into the image by the build.",
          ],
          read: now,
        },
  );

  const unknown = foundIn(reads.unknown);
  const unknownSaid: Said =
    unknown === null
      ? ["The payments whose outcome is unknown could not be read."]
      : unknown.count === 0
        ? ["No payment's outcome is unknown now."]
        : [
            { text: `${plural(unknown.count, "payment")} unknown`, href: UNKNOWN_ORDERS },
            unknown.oldestSince === null
              ? "."
              : `, the oldest for ${durationWritten(at - unknown.oldestSince)}.`,
          ];
  rows.push(
    facts.recovery.configured
      ? {
          part: "Payment recovery",
          badge: { tone: "pass", word: "Configured" },
          fact: [
            `Reads ${chainOf(channel)} from ${facts.recovery.host}. `,
            ...unknownSaid,
            " Whether its recent attempts reached the chain is in the logs, in ",
            { text: "Grafana", href: GRAFANA, elsewhere: true },
            ".",
          ],
          read: now,
        }
      : {
          part: "Payment recovery",
          badge: { tone: channel.surface === "live" ? "fail" : "notice", word: "Not configured" },
          fact: [
            "No chain endpoint is set, so recovery is off and a payment whose answer was lost waits for the facilitator. ",
            ...unknownSaid,
          ],
          read: now,
        },
  );

  const workers = foundIn(reads.workers);
  const minutes = `${facts.workerWindowMs / 60_000}`.replace(".5", "½");
  rows.push(
    workers === null
      ? {
          part: "Merchants' workers",
          badge: COULD_NOT,
          fact: ["When the merchants' workers last polled could not be read."],
          read: now,
        }
      : workers.silentOf > 0
        ? {
            part: "Merchants' workers",
            badge: { tone: "fail", word: `${workers.silentOf} out of touch` },
            fact: [
              `${plural(workers.silentOf, "merchant")} with cards on sale paid before their goods ${workers.silentOf === 1 ? "has" : "have"} not polled within the last ${minutes} minutes, so their purchases are refused: `,
              ...workers.silent.flatMap((silent, index) => [
                ...(index === 0 ? [] : [", "]),
                { text: silent.name, href: `/admin/merchants/${silent.merchantId}` },
                silent.since === null ? " (never)" : ` (since ${momentWritten(silent.since)})`,
              ]),
              ...(workers.silentOf > workers.silent.length
                ? [`, and ${workers.silentOf - workers.silent.length} more`]
                : []),
              `. ${workers.connectedWithin} of ${workers.everConnected} ever connected polled within the window.`,
            ],
            read: now,
          }
        : workers.everConnected === 0
          ? {
              part: "Merchants' workers",
              badge: { tone: "quiet", word: "None yet" },
              fact: ["No merchant's worker has ever connected."],
              read: now,
            }
          : {
              part: "Merchants' workers",
              badge: { tone: "pass", word: "Connected" },
              fact: [
                `${workers.connectedWithin} of the ${plural(workers.everConnected, "merchant")} whose worker ever connected did so within the last ${minutes} minutes. No merchant with cards on sale is out of touch.`,
              ],
              read: now,
            },
  );

  if (reads.shops === null) {
    rows.push({
      part: "WooCommerce",
      badge: { tone: "quiet", word: "Not on this deployment" },
      fact: ["This deployment offers no connector, so no shop can be connected."],
      read: now,
    });
  } else {
    const shops = foundIn(reads.shops);
    rows.push(
      shops === null
        ? {
            part: "WooCommerce",
            badge: COULD_NOT,
            fact: ["The connected shops could not be read."],
            read: now,
          }
        : {
            part: "WooCommerce",
            badge:
              shops.uncertain > 0
                ? { tone: "partial", word: `${shops.uncertain} uncertain` }
                : shops.connected === 0
                  ? { tone: "quiet", word: "No shop" }
                  : { tone: "pass", word: "Connected" },
            fact: [
              `${plural(shops.connected, "shop")} connected. ${shops.uncertain === 0 ? "No order waits to learn whether its shop order exists." : `${plural(shops.uncertain, "order")} sent to ${shops.uncertain === 1 ? "its shop" : "their shops"} never heard back, so ${shops.uncertain === 1 ? "its" : "their"} shop order may or may not exist; the merchant recovers ${shops.uncertain === 1 ? "it" : "them"} from their Orders.`}`,
            ],
            read: now,
          },
    );
  }

  const links = foundIn(reads.links);
  if (links === null) {
    rows.push({
      part: "Sign-in and report links",
      badge: COULD_NOT,
      fact: ["The links sent this hour could not be read."],
      read: now,
    });
  } else {
    const most = Math.max(links.dashboard, links.report);
    rows.push({
      part: "Sign-in and report links",
      badge:
        most >= LINK_CHANNEL_LIMIT
          ? { tone: "fail", word: "At the ceiling" }
          : most >= NEAR_THE_CEILING
            ? { tone: "partial", word: "Near the ceiling" }
            : { tone: "pass", word: "Within the ceiling" },
      fact: [
        `Sign-in links ${links.dashboard} of ${LINK_CHANNEL_LIMIT} this hour; report links ${links.report} of ${LINK_CHANNEL_LIMIT}; links to sign in afresh ${links["step-up"]} of ${LINK_CHANNEL_LIMIT}.`,
      ],
      read: now,
    });
  }

  const analytics = foundIn(reads.analytics);
  rows.push(
    analytics === null
      ? {
          part: "Commerce analytics",
          badge: COULD_NOT,
          fact: ["The analytics outbox could not be read."],
          read: now,
        }
      : {
          part: "Commerce analytics",
          badge:
            analytics.givenUp + analytics.refused > 0
              ? { tone: "partial", word: `${analytics.givenUp + analytics.refused} not delivered` }
              : { tone: "pass", word: "Delivering" },
          fact: [
            `${plural(analytics.givenUp, "event")} given up after waiting too long${analytics.givenUpSince === null ? "" : `, since ${dayWritten(analytics.givenUpSince)}`}; ${analytics.refused} refused by Nuanu Analytics; ${analytics.waiting} waiting now. Rows leave thirty days after they settle. Sales are not affected.`,
          ],
          read: now,
        },
  );

  const ads = foundIn(reads.adReports);
  rows.push(
    ads === null
      ? {
          part: "Ad reports",
          badge: COULD_NOT,
          fact: ["The ad reports could not be read."],
          read: now,
        }
      : {
          part: "Ad reports",
          badge:
            ads.givenUp + ads.refused > 0
              ? { tone: "partial", word: `${ads.givenUp + ads.refused} not delivered` }
              : { tone: "pass", word: "Delivered" },
          fact: [
            `${plural(ads.delivered, "sign-up report")} delivered in 30 days; ${ads.refused} refused and ${ads.givenUp} given up; ${ads.waiting} waiting.`,
          ],
          read: now,
        },
  );

  rows.push(keyRowOf(reads.keyCheck), listingRowOf(reads.listingCheck));
  rows.push({
    part: "Scanner",
    badge: { tone: "quiet", word: "On its own page" },
    fact: [
      "The scanner reads its own worker, queue and budget; ",
      { text: "see the scanner's page", href: SCANNER_PAGE, elsewhere: true },
      ".",
    ],
    read: "—",
  });

  const notMeasured: Badge = { tone: "unknown", word: "Not measured" };
  const unseen: HealthRowView[] = [
    {
      part: "Release tag",
      badge: notMeasured,
      fact: ["In a file on the host the release ran on. No application container reads it."],
      read: "—",
    },
    channel.surface === "live"
      ? {
          part: "Last backup",
          badge: notMeasured,
          fact: [
            "In the backup status file on the production host, and in the backup job's log there.",
          ],
          read: "—",
        }
      : {
          part: "Last backup",
          badge: { tone: "quiet", word: "Not backed up" },
          fact: [
            channel.surface === "test"
              ? "The test channel is not backed up, by decision."
              : "A sandbox runs on one machine and is not backed up.",
          ],
          read: "—",
        },
    {
      part: "Facilitator",
      badge: notMeasured,
      fact: [
        "Recorded nowhere; its silence shows up as unknown payments above and as request errors in Grafana.",
      ],
      read: "—",
    },
    {
      part: "Mail provider",
      badge: notMeasured,
      fact: ["Bounces and complaints are recorded by the provider only."],
      read: "—",
    },
  ];

  return {
    asOf: `Read ${momentWritten(at)}`,
    lede: `Each moving part of the ${CHANNEL_NAMES[channel.surface].toLowerCase()}, as the application reads it now. Requests, errors, latency and the hosts are in Grafana, over time.`,
    grafana: GRAFANA,
    read: rows,
    unseen,
    stepUp: null,
    note: "Mounting the host's release and backup status files read-only into the application would turn the first two into facts. That is a change to the deployment, with its own review. The release keeps running the facilitator-key check before it activates a revision, and the validation stays among engineering's smoke checks; Check now runs the same checks on demand.",
  };
}

// --- the services -----------------------------------------------------------

export interface FiguresPages {
  overview(operator: Operator, query: URLSearchParams): Promise<Outcome<OverviewView>>;
  health(operator: Operator): Promise<Outcome<HealthView>>;
  money(operator: Operator, query: URLSearchParams): Promise<Outcome<MoneyView>>;
  /** Runs the check a Check now press names, then answers Health with its answer. */
  check(operator: Operator, form: FormData): Promise<Outcome<HealthView>>;
  /** Health's count in the sidebar: the parts that are not well. */
  counts(operator: Operator): Promise<SectionCounts>;
}

/** What Check now reaches out with; tests hand their own so nothing leaves the process. */
export interface CheckReach {
  readonly post: typeof fetch;
  readonly listing: Reach;
}

const NETWORK: CheckReach = { post: fetch, listing: overTheNetwork() };

export function figuresFor(
  parts: AdminParts,
  reach: CheckReach = NETWORK,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): FiguresPages {
  const { reader, gateway, identity, config } = parts;
  const gatewayConfig = gateway.runtime.config;
  const channel: Channel = {
    surface: config.surfaceMode,
    network: gatewayConfig.payment.network,
    addressPage: config.addressPage,
    share: {
      commission: gatewayConfig.payoutSplit.commissionAllocation,
      total: gatewayConfig.payoutSplit.totalAllocation,
    },
  };
  const facts = () => gatewayHealthFacts(gatewayConfig, environment);
  let keyCheck: FacilitatorKeyCheck | null = null;
  let listingCheck: (ListingCheck & { readonly checkedAt: number }) | null = null;

  const askedAt = (): FiguresAsked => ({ at: parts.now().getTime(), surface: config.surfaceMode });
  const links = () =>
    readable("the links sent this hour", () => identity.linksSentInTheHour(parts.now()));
  const adReports = (at: number) =>
    readable("the ad reports", () => identity.adReportsSince(new Date(at - 30 * 86_400_000)));

  const healthReads = async (): Promise<HealthReads> => {
    const asked = askedAt();
    const [unknown, workers, analytics, ads, sent, shops] = await Promise.all([
      readable("the unknown payments", () => reader.figures.unknownPayments(asked)),
      readable("the workers", () => reader.figures.workers(asked)),
      readable("the analytics outbox", () => reader.figures.analyticsOutbox(asked)),
      adReports(asked.at),
      links(),
      parts.shops === null
        ? Promise.resolve(null)
        : readable("the connected shops", async () => {
            const shops = parts.shops;
            if (shops === null) return { connected: 0, uncertain: 0 };
            const [connected, uncertain] = await Promise.all([
              shops.connections(),
              shops.uncertainOrders(),
            ]);
            return { connected: connected.length, uncertain };
          }),
    ]);
    return {
      at: asked.at,
      channel,
      facts: facts(),
      unknown,
      workers,
      analytics,
      adReports: ads,
      links: sent,
      shops,
      keyCheck,
      listingCheck,
    };
  };

  return {
    async overview() {
      const asked = askedAt();
      const shopsConnected = async (): Promise<readonly string[]> => {
        if (parts.shops === null) return [];
        const accountIds = (await parts.shops.connections()).map((shop) => shop.accountId);
        return (await identity.accountsNamed({ accountIds }))
          .map((account) => account.merchantId)
          .filter((merchantId): merchantId is string => merchantId !== null);
      };
      const [
        waiting,
        unknown,
        workers,
        analytics,
        ads,
        sent,
        uncertain,
        merchants,
        orders,
        week,
        sales,
        funnel,
        journal,
      ] = await Promise.all([
        readable("the merchants waiting", () => reader.figures.waitingForAdmission(asked)),
        readable("the unknown payments", () => reader.figures.unknownPayments(asked)),
        readable("the workers", () => reader.figures.workers(asked)),
        readable("the analytics outbox", () => reader.figures.analyticsOutbox(asked)),
        adReports(asked.at),
        links(),
        parts.shops === null
          ? Promise.resolve(null)
          : readable("the uncertain shop orders", () =>
              (parts.shops as NonNullable<typeof parts.shops>).uncertainOrders(),
            ),
        readable("the merchant counts", () => reader.figures.merchantCounts(asked)),
        readable("the week's orders", () => reader.figures.recentOrders(asked)),
        readable("the week's money", () => reader.figures.money(asked, "7d")),
        readable("the sales by day", () => reader.figures.salesByDay(asked)),
        readable("the funnel", async () =>
          reader.figures.funnel(asked, { merchantIds: await shopsConnected() }),
        ),
        readable("the journal", async () => {
          const page = await gateway.runtime.store.journal({ limit: 5 });
          return { lines: await journalLinesOf(parts, page.rows), total: page.total };
        }),
      ]);
      const owners = await readable("the owners", async () => {
        const ids = waiting.kind === "read" ? waiting.value.merchants.map((m) => m.merchantId) : [];
        const accounts = await identity.accountsNamed({ merchantIds: ids });
        return new Map(
          accounts.flatMap((account) =>
            account.merchantId === null ? [] : [[account.merchantId, account.email] as const],
          ),
        );
      });
      return {
        kind: "view",
        view: overviewViewOf({
          at: asked.at,
          channel,
          waiting,
          owners,
          unknown,
          workers,
          analytics,
          adReports: ads,
          links: sent,
          uncertainShopOrders: uncertain,
          recovery: facts().recovery,
          merchants,
          orders,
          week,
          sales,
          funnel,
          journal,
        }),
      };
    },

    async money(_operator, query) {
      const asked = askedAt();
      const period = periodIn(query);
      const [money, unknown, sales, splits, payout] = await Promise.all([
        readable("the money", () => reader.figures.money(asked, period)),
        readable("the unknown payments", () => reader.figures.unknownPayments(asked)),
        readable("the sales by day", () => reader.figures.salesByDay(asked)),
        readable("the splits", () => reader.splits.splits(asked)),
        readable("the payout", () => payoutListing(gateway)),
      ]);
      return {
        kind: "view",
        view: moneyViewOf({ at: asked.at, channel, period, money, unknown, sales, splits, payout }),
      };
    },

    async health() {
      return { kind: "view", view: healthViewOf(await healthReads()) };
    },

    async check(operator, form) {
      // A check changes nothing, but it reaches out to Coinbase from the
      // channel's own credentials, so it is held to the fresh sign-in every
      // press of the workspace is.
      if (!signedInFreshly(operator, parts.now())) {
        return {
          kind: "view",
          view: {
            ...healthViewOf(await healthReads()),
            stepUp: stepUpViewOf(operator, "admin/health", parts.pressing.googleEnabled),
          },
        };
      }
      const which = form.get(CHECK_FIELD);
      const clock = () => parts.now().getTime();
      if (which === "key") {
        keyCheck = await checkFacilitatorKey(gatewayConfig.payment, reach.post, clock);
      } else if (which === "listing") {
        listingCheck = await checkListingNow(
          new URL(config.publicBaseUrl).origin,
          reach.listing,
          clock,
        );
      }
      return { kind: "view", view: healthViewOf(await healthReads()) };
    },

    async counts() {
      const asked = askedAt();
      const [workers, analytics, sent] = await Promise.all([
        reader.figures.workers(asked),
        reader.figures.analyticsOutbox(asked),
        identity.linksSentInTheHour(parts.now()),
      ]);
      const unwell =
        (workers.silentOf > 0 ? 1 : 0) +
        (analytics.givenUp + analytics.refused > 0 ? 1 : 0) +
        (Math.max(sent.dashboard, sent.report) >= NEAR_THE_CEILING ? 1 : 0) +
        (!facts().recovery.configured && config.surfaceMode === "live" ? 1 : 0);
      return unwell === 0 ? {} : { health: { count: unwell, needsYou: false } };
    },
  };
}
