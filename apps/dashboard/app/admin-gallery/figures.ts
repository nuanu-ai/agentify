/**
 * The figures area's gallery states: Overview, Money and Health on the live
 * and the test channel, with the states a read that failed, an empty channel
 * and a Check now press draw. Every view is built by the area's own view
 * functions from example reads; the merchants in them are examples.
 */

import type { JournalLineView } from "../../src/admin/accounts.js";
import {
  type AnalyticsOutbox,
  type Channel,
  type Funnel,
  type HealthReads,
  healthViewOf,
  type MerchantCounts,
  type Money,
  type MoneyReads,
  moneyViewOf,
  type OverviewReads,
  overviewViewOf,
  type PayoutListing,
  type Readable,
  type RecentOrders,
  type SalesByDay,
  type Splits,
  startRefusedOf,
  type UnknownPayments,
  type WaitingForAdmission,
  type Workers,
} from "../../src/admin/figures.js";
import type { AdReportCounts } from "../../src/dashboard-entry.js";
import { line } from "./accounts.js";
import { AT, DAY, GIFT_CARDS, MERCHANTS_IN_ALL, SALES, TOURS } from "./examples.js";
import { type AdminGalleryState, frameIn } from "./state.js";

const MINUTE = 60_000;

const read = <T>(value: T): Readable<T> => ({ kind: "read", value });
const UNREAD = { kind: "unread" } as const;

const LIVE: Channel = {
  surface: "live",
  network: "eip155:8453",
  addressPage: "https://basescan.org/address/",
  share: { commission: 1, total: 1000 },
};
const TEST: Channel = {
  ...LIVE,
  surface: "test",
  network: "eip155:84532",
  addressPage: "https://sepolia.basescan.org/address/",
};

const COMMISSION = "0xf44A0b1c2d3e4f5061728394a5b6c7d8e9f06541";

const EMPTY_SALES: SalesByDay = {
  readAt: AT,
  undated: { amount: "0.00", count: 0 },
  days: SALES.days.map((day) => ({
    day: day.day,
    delivered: { amount: "0.00", count: 0 },
    noDelivery: { amount: "0.00", count: 0 },
  })),
};

const WAITING: WaitingForAdmission = {
  readAt: AT,
  of: 1,
  merchants: [
    {
      merchantId: GIFT_CARDS.id,
      name: GIFT_CARDS.name,
      serviceName: GIFT_CARDS.name,
      sellerSite: GIFT_CARDS.site,
      createdAt: GIFT_CARDS.createdAt,
      integration: "api",
      lastContact: AT - 3 * MINUTE,
      cardsPublished: 4,
    },
  ],
};

const UNKNOWN: UnknownPayments = {
  readAt: AT,
  amount: "10.00",
  count: 2,
  oldestSince: AT - (3 * 60 + 12) * MINUTE,
  merchants: [{ merchantId: TOURS.id, name: TOURS.name, count: 2 }],
  merchantsOf: 1,
};

const NO_UNKNOWN: UnknownPayments = {
  ...UNKNOWN,
  amount: "0.00",
  count: 0,
  oldestSince: null,
  merchants: [],
  merchantsOf: 0,
};

const WORKERS: Workers = {
  readAt: AT,
  connectedWithin: 2,
  everConnected: 2,
  silent: [],
  silentOf: 0,
};
const SILENT: Workers = {
  readAt: AT,
  connectedWithin: 1,
  everConnected: 2,
  silent: [{ merchantId: TOURS.id, name: TOURS.name, since: AT - 47 * MINUTE }],
  silentOf: 1,
};

const OUTBOX: AnalyticsOutbox = {
  readAt: AT,
  waiting: 0,
  givenUp: 3,
  givenUpSince: AT - 7 * DAY,
  refused: 0,
};
const CLEAR_OUTBOX: AnalyticsOutbox = {
  readAt: AT,
  waiting: 2,
  givenUp: 0,
  givenUpSince: null,
  refused: 0,
};
const ADS: AdReportCounts = { delivered: 2, refused: 0, givenUp: 0, waiting: 1 };
const LINKS = { dashboard: 14, report: 6, "step-up": 1 } as const;

const COUNTS: MerchantCounts = {
  readAt: AT,
  total: MERCHANTS_IN_ALL,
  selling: 1,
  admitted: 1,
  waitingForAdmission: 1,
};
const ORDERS: RecentOrders = { readAt: AT, count: 17, delivered: 13, paymentUnknown: 2, lapsed: 5 };

const cents = (amount: string): number => Math.round(Number(amount) * 100);
const dollarsOf = (sum: number): string => (sum / 100).toFixed(2);

/** The settled sales of these days, summed as the gateway sums them. */
const tallyOf = (days: readonly SalesByDay["days"][number][]): Money["sales"] => ({
  amount: dollarsOf(
    days.reduce((sum, day) => sum + cents(day.delivered.amount) + cents(day.noDelivery.amount), 0),
  ),
  count: days.reduce((n, day) => n + day.delivered.count + day.noDelivery.count, 0),
});

/** The first day payments went into splits on the live channel. */
const SPLITS_FROM = "2026-10-15";
/** The first day of the wallet in force now, whose split replaced the one before. */
const NEW_WALLET_FROM = "2026-10-17";

/** Sales settled before the thirty days the chart draws, all of them straight to a wallet. */
const EARLIER: Money["sales"] = { amount: "99.50", count: 8 };
const UNDATED: Money["sales"] = { amount: "5.00", count: 1 };

/**
 * The money of a period, summed from the same days the chart draws, so every
 * figure of a state agrees with the others: what settled from the day
 * payments went into splits went into them, everything before straight to a
 * wallet with no commission.
 */
const money = (
  period: Money["period"],
  sales: SalesByDay = SALES,
  before: Money["sales"] | null = null,
): Money => {
  const days = period === "all" ? sales.days : sales.days.slice(period === "7d" ? -7 : -30);
  const extra = period === "all" ? [before, sales.undated].filter((one) => one !== null) : [];
  const whole = tallyOf(days);
  const total = {
    amount: dollarsOf(extra.reduce((sum, one) => sum + cents(one.amount), cents(whole.amount))),
    count: extra.reduce((n, one) => n + one.count, whole.count),
  };
  const intoSplits = tallyOf(days.filter((day) => day.day >= SPLITS_FROM));
  const noDelivery = {
    amount: dollarsOf(days.reduce((sum, day) => sum + cents(day.noDelivery.amount), 0)),
    count: days.reduce((n, day) => n + day.noDelivery.count, 0),
  };
  return {
    readAt: AT,
    period,
    from: period === "all" ? null : AT - (period === "7d" ? 6 : 29) * DAY,
    sales: total,
    undated: period === "all" ? sales.undated : { amount: "0.00", count: 0 },
    commission: (cents(intoSplits.amount) / 100_000).toFixed(4),
    intoSplits,
    straightToWallet: {
      amount: dollarsOf(cents(total.amount) - cents(intoSplits.amount)),
      count: total.count - intoSplits.count,
    },
    noDelivery,
    noDeliveryByState:
      noDelivery.count === 0
        ? []
        : [
            { state: "fulfillment_closed", count: 1 },
            { state: "unfulfilled", count: 1 },
          ],
  };
};

const FUNNEL: Funnel = {
  readAt: AT,
  steps: [
    { step: "created", merchants: MERCHANTS_IN_ALL },
    { step: "seller_name", merchants: 15 },
    { step: "payout_wallet", merchants: 7 },
    { step: "key_or_shop", merchants: 4 },
    { step: "connected", merchants: 2 },
    { step: "admitted", merchants: 1 },
    { step: "card_on_sale", merchants: 1 },
    { step: "first_sale", merchants: 1 },
  ],
};

const iso = (at: number) => new Date(at).toISOString();

const KEY_DISABLED = line(3, iso(Date.UTC(2026, 9, 20, 16, 21)), {
  actor: { kind: "account", id: "acc_operator_two", email: "ops@example.com" },
  action: "disable_key",
  subject: { kind: "key", id: "mk_3b7e05a1c94d", merchantId: TOURS.id, label: TOURS.name },
  reason: "Shared outside the team, by the merchant's own report.",
  outcome: { kind: "done" },
});

const JOURNAL_LINES: readonly JournalLineView[] = [
  KEY_DISABLED,
  line(2, iso(TOURS.admittedAt), {
    actor: { kind: "account", id: "acc_operator_two", email: "ops@example.com" },
    action: "admit",
    subject: { kind: "merchant", id: TOURS.id, merchantId: TOURS.id, label: TOURS.name },
    reason: null,
    outcome: { kind: "done" },
  }),
  line(1, iso(AT - 41 * DAY), {
    actor: { kind: "configuration" },
    action: "first_operator",
    subject: {
      kind: "account",
      id: "acc_operator",
      merchantId: null,
      label: "operator@example.com",
    },
    reason: null,
    outcome: { kind: "done" },
  }),
];

const overviewReads = (over: Partial<OverviewReads> = {}): OverviewReads => ({
  at: AT,
  channel: LIVE,
  waiting: read(WAITING),
  owners: read(new Map([[GIFT_CARDS.id, GIFT_CARDS.owner]])),
  unknown: read(UNKNOWN),
  workers: read(WORKERS),
  analytics: read(OUTBOX),
  adReports: read(ADS),
  links: read(LINKS),
  uncertainShopOrders: null,
  startRefused: read(null),
  recovery: { configured: true, host: "mainnet.base.org" },
  merchants: read(COUNTS),
  orders: read(ORDERS),
  week: read(money("7d")),
  sales: read(SALES),
  funnel: read(FUNNEL),
  journal: read({ lines: JOURNAL_LINES, total: 3 }),
  ...over,
});

const recordedSplit = (address: string, merchantId: string, wallet: string) => ({
  address,
  network: "eip155:8453",
  merchantId,
  merchantWallet: wallet,
  commissionWallet: COMMISSION,
  merchantAllocation: 999,
  commissionAllocation: 1,
  totalAllocation: 1000,
  distributionIncentive: 0,
  owner: "0x0000000000000000000000000000000000000000",
  salt: `0x${"0".repeat(64)}`,
  factory: "0x6B9118074aB15142d7524E8c4ea8f62A3Bdb98f1",
});

const PAYOUT: PayoutListing = {
  kind: "listed",
  chain: { id: "eip155:8453", name: "Base" },
  splits: 3,
  waiting: 1,
  parts: [
    {
      to: "0xcA11bde05977b3631167028862bE2a173976CA11",
      value: 0n,
      data: `0x82ad56cb${"0".repeat(56)}20${"0a1b2c3d4e5f".repeat(40)}`,
      splits: [
        recordedSplit(TOURS.earlierSplit, TOURS.id, TOURS.earlierWallet),
        recordedSplit(TOURS.split, TOURS.id, TOURS.wallet),
        recordedSplit(GIFT_CARDS.split, GIFT_CARDS.id, GIFT_CARDS.wallet),
      ],
      commissionWallets: [COMMISSION],
    },
  ] as unknown as Extract<PayoutListing, { kind: "listed" }>["parts"],
};

const SPLITS: Splits = {
  readAt: AT,
  of: 3,
  empty: 1,
  waiting: 1,
  rows: [
    {
      address: TOURS.split,
      merchantId: TOURS.id,
      merchantName: TOURS.name,
      merchantWallet: TOURS.wallet,
      commissionWallet: COMMISSION,
      recordedAt: Date.parse(`${NEW_WALLET_FROM}T09:30:00Z`),
      inForce: true,
      settled: tallyOf(SALES.days.filter((day) => day.day >= NEW_WALLET_FROM)),
    },
    {
      address: TOURS.earlierSplit,
      merchantId: TOURS.id,
      merchantName: TOURS.name,
      merchantWallet: TOURS.earlierWallet,
      commissionWallet: COMMISSION,
      recordedAt: Date.parse(`${SPLITS_FROM}T00:00:00Z`),
      inForce: false,
      settled: tallyOf(
        SALES.days.filter((day) => day.day >= SPLITS_FROM && day.day < NEW_WALLET_FROM),
      ),
    },
    {
      address: GIFT_CARDS.split,
      merchantId: GIFT_CARDS.id,
      merchantName: GIFT_CARDS.name,
      merchantWallet: GIFT_CARDS.wallet,
      commissionWallet: COMMISSION,
      recordedAt: GIFT_CARDS.createdAt + DAY,
      inForce: true,
      settled: { amount: "0.00", count: 0 },
    },
  ],
};

const moneyReads = (over: Partial<MoneyReads> = {}): MoneyReads => ({
  at: AT,
  channel: LIVE,
  period: "30d",
  money: read(money("30d")),
  unknown: read(UNKNOWN),
  sales: read(SALES),
  splits: read(SPLITS),
  payout: read(PAYOUT),
  ...over,
});

const healthReads = (over: Partial<HealthReads> = {}): HealthReads => ({
  at: AT,
  channel: LIVE,
  facts: {
    surface: "live",
    network: "eip155:8453",
    revision: "ea229fdd5c1f0e3b2a4d6c8e0f1a2b3c4d5e6f70",
    recovery: { configured: true, host: "mainnet.base.org" },
    workerWindowMs: 630_000,
  },
  unknown: read(UNKNOWN),
  workers: read(WORKERS),
  analytics: read(OUTBOX),
  adReports: read(ADS),
  links: read(LINKS),
  shops: null,
  startRefused: read(null),
  keyCheck: null,
  listingCheck: null,
  ...over,
});

/** The gateway's refusal of a registry whose split for the tours' wallet is no longer the code's. */
const REFUSED = {
  kind: "refused",
  why: `1 recorded split of a wallet in force or waiting on eip155:8453, beginning with ${TOURS.split}, is no longer what this code makes for that merchant and wallet: the commission wallet or the rate, the factory, or the way a salt and an address are derived changed since, and there is no way yet to move merchants onto new splits, so the gateway does not start`,
} as const satisfies PayoutListing;

const START_REFUSED = read(startRefusedOf(REFUSED.why, SPLITS));

/** On the test channel nobody is admitted, so the journal holds no admission. */
const TEST_JOURNAL = read({
  lines: JOURNAL_LINES.filter((one) => one.action !== "admit"),
  total: 2,
});

/** The overview with something waiting, for a state of another area drawn over it. */
export const OVERVIEW_EXAMPLE = overviewViewOf(overviewReads());

export const FIGURES_STATES: readonly AdminGalleryState[] = [
  {
    id: "dashboard-admin-overview",
    screen: "Overview",
    when: "An operator opens the workspace on the live channel while a merchant waits for admission.",
    cause:
      "A merchant with a seller name and a payout wallet is not admitted, two payments are unknown and three analytics events were given up.",
    path: "/admin",
    mode: "live",
    loaded: { "routes/admin/index": OVERVIEW_EXAMPLE },
  },
  {
    id: "dashboard-admin-overview-quiet",
    screen: "Overview",
    when: "An operator opens the workspace and nothing waits.",
    cause: "Nobody waits for admission and every fact worth a look is clear.",
    path: "/admin",
    mode: "live",
    frame: frameIn("live", {}),
    loaded: {
      "routes/admin/index": overviewViewOf(
        overviewReads({
          waiting: read({ readAt: AT, of: 0, merchants: [] }),
          unknown: read(NO_UNKNOWN),
          analytics: read(CLEAR_OUTBOX),
        }),
      ),
    },
  },
  {
    id: "dashboard-admin-overview-test",
    screen: "Overview",
    when: "An operator opens the test channel's workspace while a WooCommerce order is uncertain.",
    cause: "The test channel admits nobody, and one shop order was never confirmed.",
    path: "/admin",
    mode: "test",
    frame: frameIn("test", { health: { count: 1, needsYou: false } }),
    loaded: {
      "routes/admin/index": overviewViewOf(
        overviewReads({
          channel: TEST,
          unknown: read(NO_UNKNOWN),
          analytics: read(CLEAR_OUTBOX),
          uncertainShopOrders: read(1),
          workers: read(SILENT),
          journal: TEST_JOURNAL,
        }),
      ),
    },
  },
  {
    id: "dashboard-admin-overview-start-refused",
    screen: "Overview",
    when: "An operator opens the workspace while a recorded payout split is no longer what the code makes.",
    cause:
      "The running gateway sells on, but its next start or release would refuse the registry, so it waits for the operator first.",
    path: "/admin",
    mode: "live",
    loaded: {
      "routes/admin/index": overviewViewOf(overviewReads({ startRefused: START_REFUSED })),
    },
  },
  {
    id: "dashboard-admin-overview-empty",
    screen: "Overview",
    when: "An operator opens the workspace of a channel nobody has used yet.",
    cause: "Every read succeeded and found nothing, so the figures are zeros.",
    path: "/admin",
    mode: "live",
    frame: frameIn("live", {}),
    loaded: {
      "routes/admin/index": overviewViewOf(
        overviewReads({
          waiting: read({ readAt: AT, of: 0, merchants: [] }),
          unknown: read(NO_UNKNOWN),
          workers: read({
            readAt: AT,
            connectedWithin: 0,
            everConnected: 0,
            silent: [],
            silentOf: 0,
          }),
          analytics: read({ ...CLEAR_OUTBOX, waiting: 0 }),
          adReports: read({ delivered: 0, refused: 0, givenUp: 0, waiting: 0 }),
          links: read({ dashboard: 0, report: 0, "step-up": 0 }),
          merchants: read({
            readAt: AT,
            total: 0,
            selling: 0,
            admitted: 0,
            waitingForAdmission: 0,
          }),
          orders: read({ readAt: AT, count: 0, delivered: 0, paymentUnknown: 0, lapsed: 0 }),
          week: read(money("7d", EMPTY_SALES)),
          sales: read(EMPTY_SALES),
          funnel: read({
            readAt: AT,
            steps: FUNNEL.steps.map((step) => ({ ...step, merchants: 0 })),
          }),
          journal: read({ lines: [], total: 0 }),
        }),
      ),
    },
  },
  {
    id: "dashboard-admin-overview-unread",
    screen: "Overview",
    when: "An operator opens the workspace while the database does not answer its reads.",
    cause:
      "Every read failed, so each figure says it could not be read and none is drawn as a zero.",
    path: "/admin",
    mode: "live",
    frame: frameIn("live", {}),
    loaded: {
      "routes/admin/index": overviewViewOf(
        overviewReads({
          waiting: UNREAD,
          owners: UNREAD,
          unknown: UNREAD,
          workers: UNREAD,
          analytics: UNREAD,
          adReports: UNREAD,
          links: UNREAD,
          merchants: UNREAD,
          orders: UNREAD,
          week: UNREAD,
          sales: UNREAD,
          funnel: UNREAD,
          journal: UNREAD,
        }),
      ),
    },
  },
  {
    id: "dashboard-admin-money",
    screen: "Money",
    when: "An operator reads the last thirty days' money on the live channel.",
    cause:
      "Settled sales went into splits and, before splits, straight to a wallet; two orders were paid with no delivery recorded.",
    path: "/admin/money",
    mode: "live",
    loaded: { "routes/admin/money": moneyViewOf(moneyReads()) },
  },
  {
    id: "dashboard-admin-money-all",
    screen: "Money",
    when: "An operator reads all time's money, with a sale whose order records no moment it was paid.",
    cause: "A settled sale with no moment of payment recorded counts in all time and on no day.",
    path: "/admin/money?period=all",
    mode: "live",
    loaded: {
      "routes/admin/money": moneyViewOf(
        moneyReads({
          period: "all",
          money: read(money("all", { ...SALES, undated: UNDATED }, EARLIER)),
          sales: read({ ...SALES, undated: UNDATED }),
        }),
      ),
    },
  },
  {
    id: "dashboard-admin-money-refused",
    screen: "Money",
    when: "An operator reads Money while the registry of splits disagrees with the code.",
    cause: "The gateway would refuse to start on these splits, so no payout transaction is shown.",
    path: "/admin/money?period=7d",
    mode: "live",
    loaded: {
      "routes/admin/money": moneyViewOf(
        moneyReads({
          period: "7d",
          money: read(money("7d")),
          payout: read(REFUSED),
        }),
      ),
    },
  },
  {
    id: "dashboard-admin-money-empty",
    screen: "Money",
    when: "An operator reads Money on a test channel where nothing has sold.",
    cause: "Every read succeeded and found nothing: no sale, no split, nothing to pay out.",
    path: "/admin/money",
    mode: "test",
    loaded: {
      "routes/admin/money": moneyViewOf(
        moneyReads({
          channel: TEST,
          money: read(money("30d", EMPTY_SALES)),
          unknown: read(NO_UNKNOWN),
          sales: read(EMPTY_SALES),
          splits: read({ readAt: AT, rows: [], of: 0, empty: 0, waiting: 0 }),
          payout: read({
            kind: "nothing_recorded",
            chain: { id: "eip155:84532", name: "Base Sepolia" },
            waiting: 0,
          }),
        }),
      ),
    },
  },
  {
    id: "dashboard-admin-money-unread",
    screen: "Money",
    when: "An operator reads Money while the database does not answer.",
    cause: "Every read failed, so each figure says it could not be read.",
    path: "/admin/money",
    mode: "live",
    frame: frameIn("live", {}),
    loaded: {
      "routes/admin/money": moneyViewOf(
        moneyReads({
          money: UNREAD,
          unknown: UNREAD,
          sales: UNREAD,
          splits: UNREAD,
          payout: UNREAD,
        }),
      ),
    },
  },
  {
    id: "dashboard-admin-health",
    screen: "Health",
    when: "An operator reads the live channel's health.",
    cause:
      "Recovery is configured, the workers are in touch and three analytics events were given up.",
    path: "/admin/health",
    mode: "live",
    loaded: { "routes/admin/health": healthViewOf(healthReads()) },
  },
  {
    id: "dashboard-admin-health-test",
    screen: "Health",
    when: "An operator reads the test channel's health while a merchant's worker is out of touch.",
    cause:
      "The test channel is not backed up by decision, offers the connector, and one worker stopped polling.",
    path: "/admin/health",
    mode: "test",
    // A worker out of touch, the outbox's given-up events and the links near their ceiling.
    frame: frameIn("test", { health: { count: 3, needsYou: false } }),
    loaded: {
      "routes/admin/health": healthViewOf(
        healthReads({
          channel: TEST,
          facts: {
            surface: "test",
            network: "eip155:84532",
            revision: null,
            recovery: { configured: false },
            workerWindowMs: 630_000,
          },
          workers: read(SILENT),
          shops: read({ connected: 2, uncertain: 1 }),
          links: read({ dashboard: 171, report: 6, "step-up": 0 }),
        }),
      ),
    },
  },
  {
    id: "dashboard-admin-health-start-refused",
    screen: "Health",
    when: "An operator reads Health while a recorded payout split is no longer what the code makes.",
    cause: "The gateway runs, but would refuse to start on the registry; Health names the split.",
    path: "/admin/health",
    mode: "live",
    loaded: {
      "routes/admin/health": healthViewOf(healthReads({ startRefused: START_REFUSED })),
    },
  },
  {
    id: "dashboard-admin-health-checked",
    screen: "Health",
    when: "An operator pressed Check now on both checks.",
    cause: "Coinbase took the key, and the validator refused one of the channel's paid resources.",
    path: "/admin/health",
    mode: "live",
    loaded: { "routes/admin/health": healthViewOf(healthReads()) },
    pressed: {
      "routes/admin/health": healthViewOf(
        healthReads({
          keyCheck: {
            checkedAt: AT + 2 * MINUTE,
            outcome: "taken",
            said: "Coinbase let the key in CDP_API_KEY_ID and CDP_API_KEY_SECRET through: it judged the empty payment instead of refusing the key",
          },
          listingCheck: {
            kind: "checked",
            base: "https://agentify.ad",
            checkedAt: AT + 2 * MINUTE,
            resources: [],
            probes: 4,
            refused: ["POST https://agentify.ad/x402/itm_2/purchase"],
            unanswered: [],
            unchecked: [],
            passed: false,
          },
        }),
      ),
    },
  },
  {
    id: "dashboard-admin-health-unread",
    screen: "Health",
    when: "An operator reads Health while the database does not answer.",
    cause:
      "The reads failed, so each row says it could not be read; the process's own facts still stand.",
    path: "/admin/health",
    mode: "live",
    frame: frameIn("live", {}),
    loaded: {
      "routes/admin/health": healthViewOf(
        healthReads({
          unknown: UNREAD,
          workers: UNREAD,
          analytics: UNREAD,
          adReports: UNREAD,
          links: UNREAD,
        }),
      ),
    },
  },
];
