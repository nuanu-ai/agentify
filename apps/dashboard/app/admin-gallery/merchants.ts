/**
 * The merchants area's gallery states: the Merchants list and a merchant's
 * page in every state an operator meets, each drawn by the area's own view
 * functions from facts as the operator's reader hands them. The example
 * merchants are this file's own and nobody's.
 */

import { SURFACE_MARKER_ATTRIBUTE, SURFACE_WORDS, type SurfaceMode } from "@agentify/core";
import type { JournalRow } from "@agentify/gateway/journal";
import type { Card } from "@nuanu-ai/agentify-contracts";
import { UNSAFE_ErrorResponseImpl as ErrorResponseImpl } from "react-router";
import type { Operator } from "../../src/admin/access.js";
import type { ActionAnswer } from "../../src/admin/action.js";
import {
  type Answers,
  type MerchantList,
  type MerchantRead,
  type MerchantRecord,
  type MerchantRow,
  merchantsViewOf,
  merchantViewOf,
} from "../../src/admin/merchants.js";
import { stepUpViewOf } from "../../src/admin/step-up.js";
import type { NamedAccount } from "../../src/dashboard-entry.js";
import type { Trouble } from "../answer.js";
import { line } from "./accounts.js";
import type { AdminGalleryState } from "./state.js";

const DAY = 86_400_000;
/** The moment every state is read at: 23 Oct 2026, 14:05 UTC. */
const NOW = Date.UTC(2026, 9, 23, 14, 5);
const FROM = Date.UTC(2026, 8, 24);

const OPERATOR_ID = "acc_operator_one";
const ANOTHER_OPERATOR = "acc_operator_two";

const GIFT_CARDS = "mch_4c1da2e95b7f0c3816de42a90e5b71c3";
const TOURS = "mch_91b0e7d4c25a8f6013e9b2d7c4a50f18";
const WOOL = "mch_2e7f4a91c0d8b35e6a14f9c2d07b8e55";
const UNNAMED = "mch_7d03b8e1f4a92c6d5e0b13a8f7c29d40";

const WALLET = "0xC41e079Ab233f8D51c0e9A6b47F2d388c1a05E7d";
const SPLIT = "0x91fa3c27E0b84d65aF19c03e7B2d58c4A6e10c3d";

const empty = (): MerchantRow["thirtyDays"] => ({
  from: FROM,
  orders: 0,
  settled: { amount: "0.00", count: 0 },
});

const selling = (perDay: (day: number) => string): MerchantRecord["thirtyDays"]["days"] =>
  Array.from({ length: 30 }, (_, at) => {
    const amount = perDay(at);
    return {
      day: new Date(FROM + at * DAY).toISOString().slice(0, 10),
      amount,
      count: amount === "0.00" ? 0 : Math.max(1, Math.round(Number(amount) / 8)),
    };
  });

const TOURS_DAYS = selling((day) => (day % 7 === 3 ? "0.00" : `${8 + ((day * 5) % 23)}.00`));

/** The tours' thirty days, the same on the list and on its page: the sales the sparkline draws. */
const TOURS_THIRTY = {
  from: FROM,
  orders: 56,
  settled: {
    amount: TOURS_DAYS.reduce((sum, day) => sum + Number(day.amount), 0).toFixed(2),
    count: TOURS_DAYS.reduce((n, day) => n + day.count, 0),
  },
};

const ROWS: readonly MerchantRow[] = [
  {
    id: GIFT_CARDS,
    serviceName: "Gift Card Shop",
    sellerSite: "https://giftcards.example",
    createdAt: Date.UTC(2026, 9, 19),
    integration: "api",
    segment: "waiting",
    missing: ["no_operator_approval"],
    keys: { issued: 1, working: 1 },
    lastContactAt: NOW - 3 * 60_000,
    cards: { onSale: 0, published: 4 },
    thirtyDays: empty(),
    lastSaleAt: null,
  },
  {
    id: TOURS,
    serviceName: "City Walking Tours",
    sellerSite: "https://tours.example",
    createdAt: Date.UTC(2026, 8, 2),
    integration: "api",
    segment: "selling",
    missing: [],
    keys: { issued: 3, working: 2 },
    lastContactAt: NOW - 20_000,
    cards: { onSale: 7, published: 8 },
    thirtyDays: TOURS_THIRTY,
    lastSaleAt: NOW - 34 * 60_000,
  },
  {
    id: WOOL,
    serviceName: "Wool Socks",
    sellerSite: null,
    createdAt: Date.UTC(2026, 9, 12),
    integration: "api",
    segment: "setting_up",
    missing: ["no_payout_wallet", "no_operator_approval"],
    keys: { issued: 1, working: 1 },
    lastContactAt: null,
    cards: { onSale: 0, published: 0 },
    thirtyDays: empty(),
    lastSaleAt: null,
  },
  {
    id: UNNAMED,
    serviceName: null,
    sellerSite: null,
    createdAt: Date.UTC(2026, 9, 21),
    integration: "api",
    segment: "setting_up",
    missing: ["no_seller_name", "no_payout_wallet", "no_operator_approval"],
    keys: { issued: 0, working: 0 },
    lastContactAt: null,
    cards: { onSale: 0, published: 0 },
    thirtyDays: empty(),
    lastSaleAt: null,
  },
];

const ACCOUNTS: ReadonlyMap<string, readonly NamedAccount[]> = new Map(
  [
    [GIFT_CARDS, "owner@giftcards.example"],
    [TOURS, "owner@tours.example"],
    [WOOL, "hello@socks.example"],
    [UNNAMED, "dev@elsewhere.example"],
  ].map(([merchantId = "", email = ""]) => [
    merchantId,
    [{ id: `acc_of_${merchantId}`, email, merchantId }],
  ]),
);

const listed = (rows: readonly MerchantRow[], total = rows.length): MerchantList => ({
  rows,
  total,
  segments: {
    all: 23,
    waiting: 1,
    selling: 1,
    setting_up: 21,
    paused: 0,
  },
});

const listState = (
  told: Pick<AdminGalleryState, "id" | "when" | "cause">,
  read: { mode?: SurfaceMode; query?: string; found?: MerchantList; unread?: boolean },
): AdminGalleryState => {
  const query = read.query ?? "";
  return {
    ...told,
    screen: "Merchants",
    path: `/admin/merchants${query === "" ? "" : `?${query}`}`,
    mode: read.mode ?? "live",
    loaded: {
      "routes/admin/merchants": merchantsViewOf({
        mode: read.mode ?? "live",
        readAt: NOW,
        query: new URLSearchParams(query),
        found: read.found ?? listed(ROWS, 23),
        accounts: read.unread === true ? null : ACCOUNTS,
        accountsUnread: read.unread === true,
        accountsCut: false,
      }),
    },
  };
};

// --- one merchant ---------------------------------------------------------------

const card = (code: string, title: string, amount: string): Card => ({
  merchant_item_id: code,
  title,
  description: `${title}, delivered as a code by email`,
  price: { amount, currency: "USD" },
  result: { code: { type: "string" } },
  fulfillment: "sync",
});

const ADMITTED: MerchantRecord = {
  id: TOURS,
  serviceName: "City Walking Tours",
  sellerSite: "https://tours.example",
  createdAt: Date.UTC(2026, 8, 2),
  integration: "api",
  segment: "selling",
  missing: [],
  lastContactAt: NOW - 20_000,
  lastSaleAt: NOW - 34 * 60_000,
  selling: "open",
  liveApprovedAt: Date.UTC(2026, 8, 14, 10, 2),
  wallet: { address: WALLET, split: SPLIT, pending: null },
  keys: {
    rows: [
      {
        id: "mk_9f2c41d8e07b",
        label: "ci",
        createdAt: Date.UTC(2026, 8, 30),
        lastUsedAt: Date.UTC(2026, 9, 21),
        disabledAt: null,
      },
      {
        id: "mk_3b7e05a1c94d",
        label: "staging",
        createdAt: Date.UTC(2026, 8, 10),
        lastUsedAt: Date.UTC(2026, 9, 19),
        disabledAt: Date.UTC(2026, 9, 20, 16, 21),
      },
      {
        id: "mk_a04d6c2e81f5",
        label: "production",
        createdAt: Date.UTC(2026, 8, 2),
        lastUsedAt: NOW - 20_000,
        disabledAt: null,
      },
    ],
    total: 3,
    working: 2,
  },
  cards: {
    rows: [
      {
        id: "itm_old_town",
        card: card("old-town", "Old town walk, two hours", "24.00"),
        publishedAt: Date.UTC(2026, 8, 3),
        paused: false,
        integration: "api",
        onSale: true,
      },
      {
        id: "itm_harbour",
        card: card("harbour", "Harbour walk at dusk", "18.00"),
        publishedAt: Date.UTC(2026, 8, 3),
        paused: true,
        integration: "api",
        onSale: false,
      },
    ],
    total: 8,
    onSale: 7,
  },
  thirtyDays: { ...TOURS_THIRTY, days: TOURS_DAYS },
  worthALook: {
    rows: [
      {
        id: "ord_8c2e5d07a3f141a9",
        status: "payment_unresolved",
        price: { amount: "24.00", currency: "USD" },
        createdAt: NOW - 13 * 60_000,
        itemId: "itm_old_town",
        title: "Old town walk, two hours",
      },
      {
        id: "ord_17ff09b24ce67de3",
        status: "unfulfilled",
        price: { amount: "18.00", currency: "USD" },
        createdAt: NOW - 21 * 3_600_000,
        itemId: "itm_harbour",
        title: "Harbour walk at dusk",
      },
      {
        id: "ord_4727e1c08b5da18b",
        status: "delivered_unpaid",
        price: { amount: "24.00", currency: "USD" },
        createdAt: NOW - 22 * 3_600_000,
        itemId: "itm_gone",
        title: null,
      },
    ],
    total: 3,
  },
};

const row = (
  sequence: number,
  at: number,
  action: JournalRow["action"],
  subject: JournalRow["subject"],
  reason: string | null,
  outcome: JournalRow["outcome"],
  actor: JournalRow["actor"] = { kind: "account", id: ANOTHER_OPERATOR },
): JournalRow => ({ sequence, at, actor, action, subject, reason, outcome });

const HISTORY: readonly JournalRow[] = [
  row(
    2,
    Date.UTC(2026, 9, 20, 16, 21),
    "disable_key",
    { kind: "key", id: "mk_3b7e05a1c94d", merchantId: TOURS },
    "shared outside the team, by the merchant's own report",
    { kind: "done" },
  ),
  row(1, Date.UTC(2026, 8, 14, 10, 2), "admit", { kind: "merchant", id: TOURS }, null, {
    kind: "done",
  }),
];

const ADDRESSES: ReadonlyMap<string, string> = new Map([
  [OPERATOR_ID, "operator@example.com"],
  [ANOTHER_OPERATOR, "ops@example.com"],
]);

/**
 * A merchant's history as its page reads it: the journal's rows, and the same
 * rows as the Journal draws them, the accounts in them named by address.
 */
const historyOf = (rows: readonly JournalRow[], total: number): MerchantRead["history"] => ({
  rows,
  total,
  lines: rows.map((one) =>
    line(one.sequence, new Date(one.at).toISOString(), {
      actor:
        one.actor.kind === "account"
          ? { kind: "account", id: one.actor.id, email: ADDRESSES.get(one.actor.id) ?? null }
          : one.actor,
      action: one.action,
      subject: {
        kind: one.subject.kind,
        id: one.subject.id,
        merchantId: one.subject.kind === "key" ? one.subject.merchantId : one.subject.id,
        label: "City Walking Tours",
      },
      reason: one.reason,
      outcome: one.outcome,
    }),
  ),
});

const pageRead = (record: MerchantRecord, more: Partial<MerchantRead> = {}): MerchantRead => ({
  mode: "live",
  addressPage: "https://basescan.org/address/",
  actors: ADDRESSES,
  readAt: NOW,
  record,
  emails: ["owner@tours.example"],
  shop: null,
  history: historyOf(HISTORY, 34),
  withdrawal: null,
  uncertainIds: [],
  answers: {},
  ...more,
});

/** The press routes, by what each adds to the merchant page's address. */
type Pressed = "admit" | "withdraw" | Readonly<{ key: string }>;

const pageState = (
  told: Pick<AdminGalleryState, "id" | "when" | "cause">,
  read: MerchantRead,
  pressed?: Pressed,
): AdminGalleryState => {
  const view = merchantViewOf(read);
  const page = `/admin/merchants/${read.record.id}`;
  if (pressed === undefined) {
    return {
      ...told,
      screen: "Merchant",
      path: page,
      mode: read.mode,
      loaded: { "routes/admin/merchant": view },
    };
  }
  const [suffix, route] =
    typeof pressed === "string"
      ? [`/${pressed}`, `routes/admin/merchant-${pressed}`]
      : [`/keys/${pressed.key}/disable`, "routes/admin/merchant-key-disable"];
  return {
    ...told,
    screen: "Merchant",
    path: `${page}${suffix}`,
    mode: read.mode,
    pressed: { [route]: view },
  };
};

const WAITING: MerchantRecord = {
  ...ADMITTED,
  id: GIFT_CARDS,
  serviceName: "Gift Card Shop",
  sellerSite: "https://giftcards.example",
  createdAt: Date.UTC(2026, 9, 19),
  segment: "waiting",
  missing: ["no_operator_approval"],
  lastContactAt: NOW - 3 * 60_000,
  lastSaleAt: null,
  liveApprovedAt: null,
  wallet: {
    address: WALLET,
    split: SPLIT,
    pending: { landsAt: Date.UTC(2026, 9, 25, 9, 0) },
  },
  keys: {
    rows: [
      {
        id: "mk_5c1e8a3f02d7",
        label: "shop",
        createdAt: Date.UTC(2026, 9, 21),
        lastUsedAt: NOW - 3 * 60_000,
        disabledAt: null,
      },
    ],
    total: 1,
    working: 1,
  },
  cards: {
    rows: ["10", "25", "50", "100"].map((amount) => ({
      id: `itm_gift_${amount}`,
      card: card(`gift-card-${amount}`, `Gift card, ${amount} USD`, `${amount}.00`),
      publishedAt: Date.UTC(2026, 9, 21),
      paused: false,
      integration: "api" as const,
      onSale: false,
    })),
    total: 4,
    onSale: 0,
  },
  thirtyDays: {
    from: FROM,
    orders: 0,
    settled: { amount: "0.00", count: 0 },
    days: selling(() => "0.00"),
  },
  worthALook: { rows: [], total: 0 },
};

const WITHDRAWAL = row(
  3,
  NOW - 4 * 60_000,
  "withdraw",
  { kind: "merchant", id: TOURS },
  "Your seller name copies another shop's. Choose a name of your own in Settings and write to us; we admit you again once it is changed.",
  { kind: "done" },
  { kind: "account", id: OPERATOR_ID },
);

const WITHDRAWN: MerchantRecord = {
  ...ADMITTED,
  segment: "waiting",
  missing: ["no_operator_approval"],
  liveApprovedAt: null,
  cards: {
    ...ADMITTED.cards,
    rows: ADMITTED.cards.rows.map((one) => ({ ...one, onSale: false })),
    onSale: 0,
  },
};

const answered = (answers: Answers): Partial<MerchantRead> => ({ answers });

const STEP_UP: ActionAnswer = {
  kind: "step-up",
  stepUp: stepUpViewOf(
    {
      person: { id: OPERATOR_ID, email: "operator@example.com" },
      signedInAt: new Date(NOW - 2 * 3_600_000),
    } as unknown as Operator,
    `admin/merchants/${GIFT_CARDS}`,
    true,
  ),
};

const chromeIn = (mode: SurfaceMode) => ({
  base: "",
  surface: { attribute: SURFACE_MARKER_ATTRIBUTE, mode, words: SURFACE_WORDS[mode] },
});

export const MERCHANTS_STATES: readonly AdminGalleryState[] = [
  listState(
    {
      id: "dashboard-admin-merchants",
      when: "An operator opens Merchants on the live channel.",
      cause:
        "Every merchant is read with its setup, cards and thirty days; one waits for admission and is listed first.",
    },
    {},
  ),
  listState(
    {
      id: "dashboard-admin-merchants-test",
      when: "An operator opens Merchants on the test channel.",
      cause: "The test channel asks no admission, so each row draws two dots and nobody waits.",
    },
    {
      mode: "test",
      found: {
        rows: ROWS.map((one) => ({
          ...one,
          missing: one.missing.filter((finding) => finding !== "no_operator_approval"),
          segment: one.segment === "waiting" ? "selling" : one.segment,
        })),
        total: 4,
        segments: { all: 4, waiting: 0, selling: 2, setting_up: 2, paused: 0 },
      },
    },
  ),
  listState(
    {
      id: "dashboard-admin-merchants-search-nothing",
      when: "An operator searches Merchants for text no merchant's name, site or account holds.",
      cause:
        "The search read every merchant and found none; the zeros are from a read that succeeded.",
    },
    {
      query: "q=nobody",
      found: {
        rows: [],
        total: 0,
        segments: { all: 0, waiting: 0, selling: 0, setting_up: 0, paused: 0 },
      },
    },
  ),
  listState(
    {
      id: "dashboard-admin-merchants-accounts-unread",
      when: "An operator opens Merchants while the accounts cannot be read.",
      cause:
        "The merchants were read but the identity did not answer, so no address is shown and the page says the search did not look at them.",
    },
    { unread: true },
  ),
  {
    id: "dashboard-admin-merchants-unread",
    screen: "Merchants",
    when: "An operator opens Merchants while the database does not answer.",
    cause:
      "The read failed, so the page says it could not be read rather than drawing no merchants.",
    path: "/admin/merchants",
    mode: "live",
    failed: {
      "routes/gate": new ErrorResponseImpl(500, "", {
        kind: "unread",
        chrome: chromeIn("live"),
        again: "/admin/merchants",
      } satisfies Trouble),
    },
  },
  pageState(
    {
      id: "dashboard-admin-merchant",
      when: "An operator opens an admitted merchant that sells.",
      cause:
        "Every check holds; the page lists its keys with Disable, its selling, the orders worth a look and its history.",
    },
    pageRead(ADMITTED),
  ),
  pageState(
    {
      id: "dashboard-admin-merchant-waiting",
      when: "An operator opens a merchant that has a seller name and a payout wallet and is not admitted.",
      cause:
        "Admission is the one check missing; its four cards are published and off sale, and a wallet change waits.",
    },
    pageRead(WAITING, { emails: ["owner@giftcards.example"], history: historyOf([], 0) }),
  ),
  pageState(
    {
      id: "dashboard-admin-merchant-withdrawn",
      when: "An operator reads a merchant whose admission was withdrawn.",
      cause:
        "The withdrawal stands, so the admission line says when, by whom and the note the merchant reads, beside Admit.",
    },
    pageRead(WITHDRAWN, {
      withdrawal: WITHDRAWAL,
      history: historyOf([WITHDRAWAL, ...HISTORY], 35),
    }),
    "withdraw",
  ),
  pageState(
    {
      id: "dashboard-admin-merchant-step-up",
      when: "An operator whose sign-in is two hours old presses Admit.",
      cause:
        "Actions ask for a sign-in from the last fifteen minutes, so nothing changed and the step asking for one stands in the form's place.",
    },
    pageRead(WAITING, {
      emails: ["owner@giftcards.example"],
      history: historyOf([], 0),
      ...answered({ admit: STEP_UP }),
    }),
    "admit",
  ),
  pageState(
    {
      id: "dashboard-admin-merchant-refused",
      when: "An operator presses Withdraw admission without writing the note.",
      cause:
        "A withdrawal asks for the note the merchant reads, so nothing changed and the form says why.",
    },
    pageRead(ADMITTED, {
      ...answered({
        withdraw: {
          kind: "refused",
          said: "Write the reason; it is kept in the journal. Nothing was changed.",
        },
      }),
    }),
    "withdraw",
  ),
  pageState(
    {
      id: "dashboard-admin-merchant-unknown",
      when: "An operator pressed Admit and the answer was lost on the way.",
      cause:
        "The change may or may not have been made, so the form says the outcome is unknown and that pressing again is safe.",
    },
    pageRead(WAITING, {
      emails: ["owner@giftcards.example"],
      history: historyOf([], 0),
      ...answered({ admit: { kind: "unknown" } }),
    }),
    "admit",
  ),
  pageState(
    {
      id: "dashboard-admin-merchant-key-disabled",
      when: "An operator disabled a merchant's key with a reason.",
      cause:
        "The key was stopped and the row recorded with it; the page is read again and shows the key disabled just now.",
    },
    pageRead(
      {
        ...ADMITTED,
        keys: {
          ...ADMITTED.keys,
          working: 1,
          rows: ADMITTED.keys.rows.map((key) =>
            key.label === "ci" ? { ...key, disabledAt: NOW } : key,
          ),
        },
      },
      {
        history: historyOf(
          [
            row(
              3,
              NOW,
              "disable_key",
              { kind: "key", id: "mk_9f2c41d8e07b", merchantId: TOURS },
              "the merchant reported the key leaked",
              { kind: "done" },
              { kind: "account", id: OPERATOR_ID },
            ),
            ...HISTORY,
          ],
          35,
        ),
        ...answered({ key: { id: "mk_9f2c41d8e07b", answer: { kind: "done" } } }),
      },
    ),
    { key: "mk_9f2c41d8e07b" },
  ),
  pageState(
    {
      id: "dashboard-admin-merchant-shop",
      when: "An operator opens a merchant on the test channel that sells through a connected WooCommerce shop.",
      cause:
        "The test channel asks no admission; the shop's address, its connection and an order whose shop order is uncertain are read from the dashboard's own records.",
    },
    pageRead(
      {
        ...ADMITTED,
        integration: "woocommerce",
        lastContactAt: null,
        keys: { rows: [], total: 0, working: 0 },
      },
      {
        mode: "test",
        addressPage: "https://sepolia.basescan.org/address/",
        shop: {
          url: "https://shop.tours.example",
          connected: { date: "2026-10-02", time: "08:41:00 UTC" },
          permissions: "read_write",
        },
        uncertainIds: ["ord_17ff09b24ce67de3"],
        history: historyOf([], 0),
      },
    ),
  ),
  pageState(
    {
      id: "dashboard-admin-merchant-partly-unread",
      when: "An operator opens a merchant while the accounts and the journal cannot be read.",
      cause:
        "The merchant's own records were read; the account and the history say they could not be read rather than none.",
    },
    pageRead(
      { ...ADMITTED, integration: "woocommerce" },
      { emails: null, history: null, shop: "unread", uncertainIds: "unread" },
    ),
  ),
];
