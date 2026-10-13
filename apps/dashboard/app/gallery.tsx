/**
 * The dashboard's screens in the states a person can meet them in, for the
 * gallery (`pnpm gallery`). Each state is drawn through the dashboard's own
 * route tree, the one `routes.ts` declares, at the state's address, with the
 * data its loaders or presses would have answered: views built by the real
 * view functions from example data, the way the screen tests draw them.
 * Nothing here runs on the site; `gallery.test.tsx` holds that every page the
 * route table declares has a state here.
 */

import "./styles.css";
import { createHash } from "node:crypto";
import {
  keyPrefixFor,
  SURFACE_MARKER_ATTRIBUTE,
  SURFACE_WORDS,
  type SurfaceMode,
} from "@agentify/core";
import type { GalleryState, GallerySurface } from "@agentify/gallery";
import {
  MerchantCardListSchema,
  type MerchantKey,
  OrderListSchema,
  PayoutWalletSchema,
  ReceiptListSchema,
} from "@nuanu-ai/agentify-contracts";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import type { ComponentType } from "react";
import {
  createRoutesStub,
  UNSAFE_ErrorResponseImpl as ErrorResponseImpl,
  type HydrationState,
} from "react-router";
import config from "../react-router.config.js";
import { NOT_FROM_HERE } from "../src/form-post.js";
import { ANSWER_WITHIN_MS, type Answer, lateAnswer, switchRefused } from "../src/gateway.js";
import { integrationsView } from "../src/integrations-view.js";
import { keysView, newKeyView } from "../src/keys.js";
import {
  askViewOf,
  cancelledByTyping,
  type LinkAnswer,
  landedBeforePress,
  NOT_AN_ADDRESS,
  problemOf,
  type SignInView,
  signedOutOthers,
  whatIsWrongWithTheLabel,
} from "../src/page-services.js";
import { WALLET_NEEDED, whatIsWrongWithTheWallet } from "../src/payout-wallet.js";
import {
  NAME_CANNOT_BE_TAKEN_AWAY,
  NAME_NEEDED,
  NAME_RULE,
  SITE_CANNOT_BE_TAKEN_AWAY,
  whatIsWrongWithTheName,
  whatIsWrongWithTheSite,
} from "../src/seller-name.js";
import { type Settings, settingsView } from "../src/settings-view.js";
import type { Viewer } from "../src/viewer.js";
import { cardsView, ordersView, receiptsView } from "../src/views.js";
import { cardsFromTheShop, type StoreProduct } from "../src/woo-catalog.js";
import { whatIsWrongWithTheShopUrl } from "../src/woo-connect.js";
import {
  type ShopAnswer,
  type ShopRead,
  type ShopState,
  wooImportView,
  wooShopView,
} from "../src/woo-views.js";
import { SITE_IN_SETTINGS } from "../src/words.js";
import type { Chrome, Trouble } from "./answer.js";
import routes from "./routes.js";

// --- the route tree, drawn ---------------------------------------------------

interface RouteModule {
  readonly default?: ComponentType;
  readonly ErrorBoundary?: ComponentType;
}

const MODULES = import.meta.glob<RouteModule>(
  ["./root.tsx", "./routes/*.{ts,tsx}", "!./routes/*.test.{ts,tsx}"],
  { eager: true },
);

type StubRoute = Parameters<typeof createRoutesStub>[0][number];

/** A route as the build makes it: its id is its file's path without the extension. */
const stubOf = (entry: RouteConfigEntry): StubRoute => {
  const module = MODULES[`./${entry.file}`];
  if (module === undefined) throw new Error(`routes.ts names ${entry.file}, which is not here`);
  const route = {
    id: entry.id ?? entry.file.replace(/\.tsx?$/, ""),
    path: entry.path,
    Component: module.default,
    ErrorBoundary: module.ErrorBoundary,
  };
  return entry.index === true
    ? { ...route, index: true }
    : { ...route, children: entry.children?.map(stubOf) };
};

const root = MODULES["./root.tsx"];

/**
 * Mounted at the root of its origin, as a dashboard can be, so a state's path
 * is its address with the deployed prefix taken off.
 */
const TREE: StubRoute[] = [
  {
    id: "root",
    path: "/",
    Component: root?.default,
    ErrorBoundary: root?.ErrorBoundary,
    children: routes.map(stubOf),
  },
];

const BASE = config.basename;
const WHO = "owner@example.com";

const chromeIn = (mode: SurfaceMode): Chrome => ({
  base: "",
  surface: { attribute: SURFACE_MARKER_ATTRIBUTE, mode, words: SURFACE_WORDS[mode] },
});

interface Drawn {
  /** Under the dashboard's prefix, query and all. */
  readonly path: string;
  readonly mode: SurfaceMode;
  readonly loaded?: HydrationState["loaderData"];
  readonly pressed?: HydrationState["actionData"];
  readonly failed?: HydrationState["errors"];
}

type Told = Omit<GalleryState, "address" | "draw">;

/** A state at its address, drawn by the route tree as the server answers that address. */
const at = (told: Told, { path, mode, loaded, pressed, failed }: Drawn): GalleryState => ({
  ...told,
  address: `${BASE}${path}`,
  draw: () => {
    const Stub = createRoutesStub(TREE);
    return (
      <Stub
        initialEntries={[path]}
        hydrationData={{
          loaderData: { root: chromeIn(mode), "routes/gate": { who: WHO }, ...loaded },
          ...(pressed === undefined ? {} : { actionData: pressed }),
          ...(failed === undefined ? {} : { errors: failed }),
        }}
      />
    );
  },
});

/**
 * A page's trouble as React Router hands it to the error page after a loader,
 * an action or a middleware throws it with `data`.
 */
const thrown = (status: number, trouble: Trouble) => new ErrorResponseImpl(status, "", trouble);

// --- example data --------------------------------------------------------------

/** An identifier of the length and shape the gateway gives, the same every time it is drawn. */
const idOf = (kind: string, seed: string): string =>
  `${kind}_${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;

const transactionOf = (seed: string): string =>
  `0x${createHash("sha256").update(`transfer ${seed}`).digest("hex")}`;

const ORIGIN: Readonly<Record<SurfaceMode, string>> = {
  live: "https://agentify.ad",
  test: "https://test.agentify.ad",
  sandbox: "http://localhost:8080",
};

const TRANSACTIONS: Readonly<Record<SurfaceMode, string | null>> = {
  live: "https://basescan.org/tx/",
  test: "https://sepolia.basescan.org/tx/",
  sandbox: null,
};

/** The example addresses from the checksum's own specification. */
const PAID_INTO = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const ASKED_FOR = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
/** The first with its last letter's case flipped, which the checksum catches. */
const MISTYPED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD";

const SHOP = "https://shop.example.com";

/** A merchant selling connectivity: eSIM data plans, virtual numbers and a VPN. */
const PRODUCTS = {
  esimEurope: {
    merchant_item_id: "esim-eu-5gb-30d",
    title: "eSIM Europe, 5 GB for 30 days",
    description: "A data plan delivered as a profile after the purchase",
    price: { amount: "8.00", currency: "USD" },
    result: { iccid: { type: "string" } },
    fulfillment: "async",
    fulfill_deadline_seconds: 14_400,
  },
  esimWeek: {
    merchant_item_id: "esim-7d",
    title: "A seven day eSIM",
    description: "Seven days of data",
    price: { amount: "12.00", currency: "USD" },
    result: { activation_code: { type: "string" } },
    fulfillment: "async",
    fulfill_deadline_seconds: 3_600,
  },
  vpn: {
    merchant_item_id: "vpn-1m",
    title: "VPN, one month",
    description: "Thirty days from the moment it is delivered",
    price: { amount: "5.00", currency: "USD" },
    result: { access_url: { type: "string" } },
    fulfillment: "sync",
  },
  number: {
    merchant_item_id: "number-sms",
    title: "A virtual number",
    description: "Rent a virtual phone number for inbound SMS in the given country.",
    price: { amount: "2.00", currency: "USD" },
    params: { country: { type: "string", required: true } },
    result: { number: { type: "string" } },
    fulfillment: "sync",
    price_check: "handler",
  },
  esimAsia: {
    merchant_item_id: "esim-asia-3gb-15d",
    title: "eSIM Asia, 3 GB for 15 days",
    description: "A data plan delivered as a profile after the purchase",
    price: { amount: "6.50", currency: "USD" },
    result: { iccid: { type: "string" } },
    fulfillment: "async",
    fulfill_deadline_seconds: 14_400,
  },
  esimUnitedStates: {
    merchant_item_id: "esim-us-10gb-30d",
    title: "eSIM United States, 10 GB for 30 days",
    description: "A data plan delivered as a profile after the purchase",
    price: { amount: "18.00", currency: "USD" },
    result: { iccid: { type: "string" } },
    fulfillment: "async",
    fulfill_deadline_seconds: 14_400,
  },
  esimGlobal: {
    merchant_item_id: "esim-global-1gb-7d",
    title: "eSIM Global, 1 GB for 7 days",
    description: "A data plan delivered as a profile after the purchase",
    price: { amount: "9.00", currency: "USD" },
    result: { iccid: { type: "string" } },
    fulfillment: "async",
    fulfill_deadline_seconds: 900,
  },
  vpnYear: {
    merchant_item_id: "vpn-12m",
    title: "VPN, one year",
    description: "Twelve months from the moment it is delivered",
    price: { amount: "45.00", currency: "USD" },
    result: { access_url: { type: "string" } },
    fulfillment: "sync",
  },
} as const;

type Product = keyof typeof PRODUCTS;

const ON_SALE: readonly Product[] = ["esimEurope", "vpn", "number"];

interface Listed {
  readonly product: Product;
  readonly selling?: "open" | "paused" | "departed";
  readonly paused?: boolean;
}

const cardsOf = (selling: "open" | "paused" | "departed", listed: readonly (Product | Listed)[]) =>
  MerchantCardListSchema.parse({
    selling,
    cards: listed.map((one) => {
      const {
        product,
        selling: cardSelling = selling,
        paused = false,
      } = typeof one === "string" ? { product: one } : one;
      return {
        id: idOf("itm", product),
        as_of: "2026-10-01T09:00:00Z",
        card: PRODUCTS[product],
        selling: paused ? "paused" : cardSelling,
        paused,
      };
    }),
  });

const CATALOGUE = cardsOf("open", ON_SALE);

const seenBy = (mode: SurfaceMode, more: Partial<Viewer> = {}): Viewer => ({
  base: "",
  mode,
  who: WHO,
  confirmed: true,
  sellerName: "Freeland",
  payout: { wallet: PAID_INTO },
  ...(mode === "live" ? { liveApproval: true } : {}),
  ...more,
});

type Status =
  | "in_progress"
  | "delivered"
  | "rejected"
  | "payment_unresolved"
  | "declined"
  | "expired"
  | "refund_due"
  | "refunded"
  | "delivered_unpaid";

const minutesInto = (day: string, minutes: number): string =>
  new Date(Date.parse(day) + minutes * 60_000).toISOString();

const ordersOf = (rows: readonly (readonly [Product, Status])[], test = false) =>
  OrderListSchema.parse({
    orders: rows.map(([product, status], at) => ({
      id: idOf("ord", `${product} ${at}`),
      merchant_item_id: PRODUCTS[product].merchant_item_id,
      params: {},
      price: {
        ...PRODUCTS[product].price,
        at: minutesInto("2026-10-12T16:40:00Z", -37 * at),
        as_of: minutesInto("2026-10-12T16:39:00Z", -37 * at),
      },
      test,
      status,
    })),
  });

type Outcome = "delivered" | "refund_due" | "in_progress";

const receiptsOf = (rows: readonly (readonly [Product, Outcome, boolean?])[], test = false) =>
  ReceiptListSchema.parse({
    receipts: rows.map(([product, outcome, transfer = true], at) => ({
      id: idOf("rcp", `${product} ${at}`),
      order_id: idOf("ord", `${product} ${at}`),
      item_id: idOf("itm", product),
      price: {
        ...PRODUCTS[product].price,
        at: minutesInto("2026-10-12T16:40:00Z", -53 * at),
        as_of: minutesInto("2026-10-12T16:39:30Z", -53 * at),
      },
      paid_at: minutesInto("2026-10-12T16:40:04Z", -53 * at),
      outcome,
      ...(transfer ? { transaction: transactionOf(`${product} ${at}`) } : {}),
      test,
    })),
  });

const keyOf = (label: string, made: string, used: string | null, revoked: string | null = null) =>
  ({
    id: idOf("key", label),
    label,
    created_at: made,
    last_used_at: used,
    disabled_at: revoked,
  }) satisfies MerchantKey;

const WORKER = keyOf(
  "The order worker on our server",
  "2026-09-02T08:14:00Z",
  "2026-10-12T16:38:12Z",
);
const OLD_WORKER = keyOf(
  "The order worker before the move",
  "2026-08-20T09:00:00Z",
  "2026-09-01T23:59:41Z",
  "2026-09-02T08:20:00Z",
);

/** Shown in place of a key: a key's length, its prefix, and words no key would carry. */
const SECRET = `${keyPrefixFor("live")}shown-once-in-this-gallery-never-a-real-key`;

const settingsOf = (more: Partial<Settings> = {}): Settings => ({
  sellerName: "Freeland",
  sellerSite: "https://freeland.example",
  payoutWallet: PayoutWalletSchema.parse({ payout_wallet: PAID_INTO, pending: null }),
  ...more,
});

const WAITING = PayoutWalletSchema.parse({
  payout_wallet: PAID_INTO,
  pending: { payout_wallet: ASKED_FOR, takes_effect_at: "2026-10-14T16:05:00Z" },
});

const shopRead = (state: ShopState, more: Partial<ShopRead> = {}): ShopRead => ({
  state,
  unset: [],
  through: "woocommerce",
  stopped: false,
  ...more,
});

const shopOn = (read: ShopRead, answer: ShopAnswer = {}) =>
  wooShopView(seenBy("test"), read, answer);

const CONNECTED: ShopState = {
  kind: "connected",
  shop: { shopUrl: SHOP, permissions: "read_write", connectedAt: new Date("2026-10-12T09:12:00Z") },
};

const WAITING_FOR_KEYS: ShopState = { kind: "waiting", shopUrl: SHOP, startedMinutesAgo: 3 };
const NO_KEYS: ShopState = { kind: "unanswered", shopUrl: SHOP };

/** The shop's products as its Store API lists them, read by the connector's own rules. */
const storeProduct = (id: number, more: Partial<StoreProduct>): StoreProduct => ({
  id,
  name: "",
  sku: "",
  type: "simple",
  description: "",
  short_description: "",
  is_purchasable: true,
  is_in_stock: true,
  status: "publish",
  virtual: true,
  downloadable: true,
  manage_stock: false,
  download_limit: -1,
  download_expiry: -1,
  downloads: [],
  qualification_problem: null,
  prices: { price: "2500", currency_code: "USD", currency_minor_unit: 2 },
  ...more,
});

const IMPORTED = cardsFromTheShop(
  [
    storeProduct(11, {
      name: "Coffee &amp; Brunch Gift Card",
      description: "<p>A gift card for coffee, pastries or brunch from the seasonal menu.</p>",
      downloads: [{ id: "dl_card", name: "Gift card.pdf", file: `${SHOP}/gift-card.pdf` }],
    }),
    storeProduct(12, {
      name: "Coffee beans, one kilogram",
      description: "<p>Roasted in Bali this week and sent by courier.</p>",
      virtual: false,
      downloadable: false,
      prices: { price: "1800", currency_code: "USD", currency_minor_unit: 2 },
    }),
    storeProduct(13, { name: "Monthly membership", type: "variable" }),
    storeProduct(14, {
      name: "Canvas tote bag",
      description: "<p>Heavy cotton, printed in Ubud.</p>",
      virtual: false,
      downloadable: false,
      manage_stock: true,
    }),
  ],
  SHOP,
);

const imported = (title: string) => {
  const found = IMPORTED.cards.find((one) => one.title === title);
  if (found === undefined) throw new Error(`the example shop's ${title} did not become a card`);
  return found;
};

/** A gateway answer the example needs as a refusal, its words included. */
const refusalIn = (answer: Answer<never>): Answer<never> & { ok: false } => {
  if (answer.ok) throw new Error("an example refusal came back as an answer");
  return answer;
};

/** What the dashboard says when the gateway does not answer a call in time. */
const LATE = refusalIn(lateAnswer(ANSWER_WITHIN_MS));

const LATE_PROBLEM = (() => {
  const outcome = problemOf(LATE);
  if (outcome.kind !== "problem") throw new Error("an unanswered call was not drawn as a problem");
  return outcome.problem;
})();

/** Orders the gateway names when it refuses to move a merchant between integrations. */
const ORDERS_WAITING = [idOf("ord", "waiting one"), idOf("ord", "waiting two")];
const TO_THE_SHOP = refusalIn(switchRefused("woocommerce", ORDERS_WAITING)).why;
const TO_THE_CODE = refusalIn(switchRefused("api", ORDERS_WAITING)).why;

// --- the states ----------------------------------------------------------------

/** The sign-in page at its address, or, given the answer to a press, as that answer draws it. */
const signIn = (told: Told, path: string, answered?: SignInView): GalleryState =>
  at(told, {
    path,
    mode: "live",
    loaded: { "routes/sign-in": askViewOf(new URL(path, ORIGIN.live).searchParams) },
    ...(answered === undefined ? {} : { pressed: { "routes/sign-in": answered } }),
  });

const asked = (answer: LinkAnswer): SignInView => ({
  screen: "requested",
  email: WHO,
  destination: "default",
  answer,
});

const SIGNING_IN: GalleryState[] = [
  signIn(
    {
      id: "dashboard-sign-in",
      screen: "Sign in",
      when: "Somebody opens the dashboard without being signed in, or presses Sign in on the site.",
      cause: "The browser carries no session, so the gate sends it here.",
    },
    "/sign-in",
  ),
  signIn(
    {
      id: "dashboard-sign-in-session-ended",
      screen: "Sign in",
      when: "A merchant comes back to a dashboard page after their session ended.",
      cause:
        "The browser's session cookie names a session that expired or was ended from another device.",
    },
    "/sign-in?reason=session-ended&destination=orders",
  ),
  signIn(
    {
      id: "dashboard-sign-in-change-lost",
      screen: "Sign in",
      when: "A merchant presses a button on a page left open after their session ended.",
      cause:
        "A form arrived with a session cookie that no longer names a session, so nothing was saved.",
    },
    "/sign-in?reason=session-ended-unsaved&destination=settings",
  ),
  signIn(
    {
      id: "dashboard-sign-in-signed-out-elsewhere",
      screen: "Sign in",
      when: "A merchant presses a button in a tab after signing out in another tab.",
      cause: "A form arrived with no session cookie at all, so nothing was saved.",
    },
    "/sign-in?reason=unsaved",
  ),
  signIn(
    {
      id: "dashboard-sign-in-address-refused",
      screen: "Sign in",
      when: "Somebody asks for a link with an address that is not one, such as a name without the @.",
      cause: "The typed address does not have the shape of an email address, so no link was sent.",
    },
    "/sign-in",
    { screen: "ask", destination: "default", problem: NOT_AN_ADDRESS },
  ),
  signIn(
    {
      id: "dashboard-sign-in-link-sent",
      screen: "Sign in",
      when: "Somebody asks for a sign-in link.",
      cause:
        "The mail provider accepted the message; the button counts down the minute before another link.",
    },
    "/sign-in",
    asked({ sent: true, seconds: 60 }),
  ),
  signIn(
    {
      id: "dashboard-sign-in-last-link-this-hour",
      screen: "Sign in",
      when: "Somebody asks for their third link within an hour.",
      cause: "The link went out, and it was the last of the three an address gets in an hour.",
    },
    "/sign-in",
    asked({ sent: true, seconds: 2_820 }),
  ),
  signIn(
    {
      id: "dashboard-sign-in-wait-a-minute",
      screen: "Sign in",
      when: "Somebody asks for another link less than a minute after the last one.",
      cause: "One address gets one link a minute, so no new link was sent.",
    },
    "/sign-in",
    asked({ wall: "interval", seconds: 43 }),
  ),
  signIn(
    {
      id: "dashboard-sign-in-hour-spent",
      screen: "Sign in",
      when: "Somebody asks for a fourth link within an hour.",
      cause: "One address gets three links an hour, so no new link was sent.",
    },
    "/sign-in",
    asked({ wall: "hourly", seconds: 2_820 }),
  ),
  signIn(
    {
      id: "dashboard-sign-in-mail-down",
      screen: "Sign in",
      when: "Somebody asks for a link while the mail provider is failing.",
      cause:
        "The mail provider refused the message or did not answer in time, so the send is not confirmed.",
    },
    "/sign-in",
    { screen: "unavailable" },
  ),
  at(
    {
      id: "dashboard-sign-in-on-test",
      screen: "Sign in",
      when: "Somebody opens the dashboard on the test site.",
      cause:
        "Every page of the test site carries the band that says payments there settle with test funds.",
    },
    {
      path: "/sign-in",
      mode: "test",
      loaded: { "routes/sign-in": askViewOf(new URLSearchParams()) },
    },
  ),
  at(
    {
      id: "dashboard-link-open",
      screen: "The emailed sign-in link",
      when: "Somebody opens the sign-in link from their email.",
      cause:
        "The link's token is one we issued, unspent and less than an hour old; only the press spends it.",
    },
    {
      path: "/sign-in/open?token=…",
      mode: "live",
      loaded: {
        "routes/sign-in-open": { screen: "open", token: "the token from the email", email: WHO },
      },
    },
  ),
  at(
    {
      id: "dashboard-link-refused",
      screen: "The emailed sign-in link",
      when: "Somebody opens a sign-in link that was already used, is over an hour old, or was replaced.",
      cause: "The token is spent, expired or unknown, and the browser has no session to send on.",
    },
    {
      path: "/sign-in/open?token=…",
      mode: "live",
      loaded: { "routes/sign-in-open": { screen: "refused" } },
    },
  ),
];

const SETTING_UP: GalleryState[] = [
  at(
    {
      id: "dashboard-merchant",
      screen: "Opening a seller dashboard",
      when: "Somebody signs in for the first time, before any seller dashboard is theirs.",
      cause: "The signed-in account has no merchant; nothing is made until the button is pressed.",
    },
    { path: "/merchant", mode: "live", loaded: { "routes/merchant": { unavailable: false } } },
  ),
  at(
    {
      id: "dashboard-merchant-not-opened",
      screen: "Opening a seller dashboard",
      when: "Somebody presses Open my seller dashboard and it fails.",
      cause:
        "The gateway did not register the merchant; the person stays signed in to press again.",
    },
    {
      path: "/merchant",
      mode: "live",
      loaded: { "routes/merchant": { unavailable: false } },
      pressed: { "routes/merchant": { unavailable: true } },
    },
  ),
  at(
    {
      id: "dashboard-choose-name",
      screen: "Choosing the seller name",
      when: "A new merchant's dashboard has just been opened.",
      cause: "The merchant has no seller name yet; this is the last step of setting up.",
    },
    {
      path: "/choose-name",
      mode: "live",
      loaded: { "routes/choose-name": { typed: "", rule: NAME_RULE } },
    },
  ),
  at(
    {
      id: "dashboard-choose-name-needed",
      screen: "Choosing the seller name",
      when: "A new merchant presses Use this name with the box empty.",
      cause: "An empty name is refused, and the page offers to leave it for later.",
    },
    {
      path: "/choose-name",
      mode: "live",
      loaded: { "routes/choose-name": { typed: "", rule: NAME_RULE } },
      pressed: { "routes/choose-name": { typed: "", problem: NAME_NEEDED, rule: NAME_RULE } },
    },
  ),
  ((typed) =>
    at(
      {
        id: "dashboard-choose-name-refused",
        screen: "Choosing the seller name",
        when: "A new merchant types a name with a character outside plain ASCII, such as a long dash.",
        cause:
          "The catalogue's rule takes printable ASCII only, so the name is given back to correct.",
      },
      {
        path: "/choose-name",
        mode: "live",
        loaded: { "routes/choose-name": { typed: "", rule: NAME_RULE } },
        pressed: {
          "routes/choose-name": { typed, problem: whatIsWrongWithTheName(typed), rule: null },
        },
      },
    ))("Freeland — eSIM & VPN"),
];

const cards = (told: Told, view: ReturnType<typeof cardsView>, mode: SurfaceMode): GalleryState =>
  at(told, { path: "/cards", mode, loaded: { "routes/cards": view } });

const CARDS: GalleryState[] = [
  cards(
    {
      id: "dashboard-cards",
      screen: "Cards",
      when: "A merchant whose code has published a few products opens the dashboard.",
      cause: "The gateway lists three cards, all on sale.",
    },
    cardsView(seenBy("live"), CATALOGUE, ORIGIN.live),
    "live",
  ),
  cards(
    {
      id: "dashboard-cards-many",
      screen: "Cards",
      when: "A merchant with a whole catalogue opens Cards.",
      cause: "The gateway lists eight cards, one of them paused by the merchant.",
    },
    cardsView(
      seenBy("live"),
      cardsOf("open", [
        "esimEurope",
        "esimAsia",
        "esimUnitedStates",
        "esimGlobal",
        "esimWeek",
        { product: "vpn", paused: true },
        "vpnYear",
        "number",
      ]),
      ORIGIN.live,
    ),
    "live",
  ),
  cards(
    {
      id: "dashboard-cards-none",
      screen: "Cards",
      when: "A merchant opens Cards before their code has published anything.",
      cause: "The gateway lists no cards, and everything publishing needs is set.",
    },
    cardsView(seenBy("live"), cardsOf("open", []), ORIGIN.live),
    "live",
  ),
  cards(
    {
      id: "dashboard-cards-none-without-name",
      screen: "Cards",
      when: "A new merchant skipped choosing a seller name and opens Cards.",
      cause:
        "The merchant has no seller name, so every card their code publishes would be refused.",
    },
    cardsView(seenBy("live", { sellerName: null }), cardsOf("open", []), ORIGIN.live),
    "live",
  ),
  cards(
    {
      id: "dashboard-cards-none-with-woocommerce",
      screen: "Cards",
      when: "A merchant on the test site opens Cards before publishing anything.",
      cause: "No cards, and this dashboard offers the WooCommerce connector beside the SDK.",
    },
    cardsView(seenBy("test"), cardsOf("open", []), ORIGIN.test, true),
    "test",
  ),
  cards(
    {
      id: "dashboard-cards-not-approved",
      screen: "Cards",
      when: "A merchant on the live site has published cards before Agentify approved them.",
      cause:
        "Publishing on live waits for the operator's approval, so the gateway keeps every card off sale.",
    },
    cardsView(
      seenBy("live", { liveApproval: false }),
      cardsOf(
        "open",
        ON_SALE.map((product) => ({ product, selling: "paused" })),
      ),
      ORIGIN.live,
    ),
    "live",
  ),
  cards(
    {
      id: "dashboard-cards-no-wallet",
      screen: "Cards",
      when: "A merchant on the test site has cards but has not set a payout wallet.",
      cause:
        "Where payments settle, a card is off sale until the wallet its money arrives at is set.",
    },
    cardsView(
      seenBy("test", { payout: { wallet: null } }),
      cardsOf(
        "open",
        ON_SALE.map((product) => ({ product, selling: "paused" })),
      ),
      ORIGIN.test,
    ),
    "test",
  ),
  cards(
    {
      id: "dashboard-cards-all-paused",
      screen: "Cards",
      when: "A merchant has pressed Pause all sales.",
      cause:
        "The merchant's selling is paused, so every card reads paused whatever its own switch says.",
    },
    cardsView(seenBy("live"), cardsOf("paused", ON_SALE), ORIGIN.live),
    "live",
  ),
  cards(
    {
      id: "dashboard-cards-left",
      screen: "Cards",
      when: "A merchant who has left Agentify looks at their cards.",
      cause: "The merchant's selling is departed; nothing on this page puts it back on sale.",
    },
    cardsView(seenBy("live"), cardsOf("departed", ON_SALE), ORIGIN.live),
    "live",
  ),
  cards(
    {
      id: "dashboard-cards-selling-through-shop",
      screen: "Cards",
      when: "A merchant who switched to their WooCommerce shop looks at the cards their code published.",
      cause:
        "The merchant sells through the shop, so the code's cards are off sale until they switch back.",
    },
    cardsView(seenBy("test"), CATALOGUE, ORIGIN.test, true, {
      through: "woocommerce",
      offSale: CATALOGUE.cards.map((entry) => entry.id),
    }),
    "test",
  ),
];

const orders = (
  told: Told,
  view: ReturnType<typeof ordersView>,
  mode: SurfaceMode,
  open = false,
): GalleryState =>
  at(told, {
    path: open ? "/orders?open=true" : "/orders",
    mode,
    loaded: { "routes/orders": view },
  });

const OWING = ordersOf([
  ["esimEurope", "refund_due"],
  ["number", "delivered_unpaid"],
  ["vpn", "delivered"],
  ["esimWeek", "refund_due"],
]);

const ORDERS: GalleryState[] = [
  orders(
    {
      id: "dashboard-orders",
      screen: "Orders",
      when: "A merchant whose products are selling opens Orders.",
      cause:
        "The gateway lists orders that went through or are under way, none of them owing anything.",
    },
    ordersView(
      seenBy("live"),
      CATALOGUE,
      ordersOf([
        ["vpn", "delivered"],
        ["esimEurope", "in_progress"],
        ["number", "delivered"],
        ["esimEurope", "delivered"],
      ]),
      false,
    ),
    "live",
  ),
  orders(
    {
      id: "dashboard-orders-need-you",
      screen: "Orders",
      when: "A merchant has orders that owe a refund or were delivered without payment.",
      cause:
        "Orders in refund due or delivered, not paid, each set out under the table with what to do.",
    },
    ordersView(
      seenBy("live"),
      CATALOGUE,
      OWING,
      false,
      Object.fromEntries(
        OWING.orders
          .filter((order) => order.status === "refund_due")
          .map((order, at) => [order.id, at === 0 ? "deadline_passed" : "refused"]),
      ),
    ),
    "live",
  ),
  orders(
    {
      id: "dashboard-orders-every-ending",
      screen: "Orders",
      when: "A busy merchant scrolls back through their orders.",
      cause: "The gateway lists an order in each way an order can stand or end.",
    },
    ordersView(
      seenBy("live"),
      CATALOGUE,
      ordersOf([
        ["vpn", "delivered"],
        ["esimEurope", "in_progress"],
        ["number", "payment_unresolved"],
        ["esimEurope", "refund_due"],
        ["number", "delivered_unpaid"],
        ["vpn", "rejected"],
        ["esimEurope", "declined"],
        ["number", "expired"],
        ["esimEurope", "refunded"],
        ["esimWeek", "delivered"],
      ]),
      false,
    ),
    "live",
  ),
  orders(
    {
      id: "dashboard-orders-none",
      screen: "Orders",
      when: "A merchant opens Orders before anything has been bought.",
      cause: "The gateway lists no orders.",
    },
    ordersView(seenBy("live"), CATALOGUE, ordersOf([]), false),
    "live",
  ),
  orders(
    {
      id: "dashboard-orders-open-none",
      screen: "Orders",
      when: "A merchant filters Orders to the open ones and none is open.",
      cause: "The gateway's open filter lists no order owed goods or money.",
    },
    ordersView(seenBy("live"), CATALOGUE, ordersOf([]), true),
    "live",
    true,
  ),
  orders(
    {
      id: "dashboard-orders-test",
      screen: "Orders",
      when: "A merchant on the test site looks at the orders their trial purchases made.",
      cause: "Every order on the test site is marked as a test purchase.",
    },
    ordersView(
      seenBy("test"),
      CATALOGUE,
      ordersOf(
        [
          ["vpn", "delivered"],
          ["esimEurope", "delivered"],
        ],
        true,
      ),
      false,
    ),
    "test",
  ),
];

const receipts = (told: Told, view: ReturnType<typeof receiptsView>, mode: SurfaceMode) =>
  at(told, { path: "/receipts", mode, loaded: { "routes/receipts": view } });

const RECEIPTS: GalleryState[] = [
  receipts(
    {
      id: "dashboard-receipts",
      screen: "Receipts",
      when: "A merchant whose products have been bought and delivered opens Receipts.",
      cause: "The gateway lists receipts, each with the transfer the payment layer reported.",
    },
    receiptsView(
      seenBy("live"),
      CATALOGUE,
      receiptsOf([
        ["vpn", "delivered"],
        ["esimEurope", "delivered"],
        ["number", "delivered"],
      ]),
      TRANSACTIONS.live,
    ),
    "live",
  ),
  receipts(
    {
      id: "dashboard-receipts-many",
      screen: "Receipts",
      when: "A merchant with a season of sales scrolls through Receipts.",
      cause:
        "Many receipts, one still in progress, one owing a refund and one without a recorded transfer.",
    },
    receiptsView(
      seenBy("live"),
      CATALOGUE,
      receiptsOf([
        ["vpn", "delivered"],
        ["esimEurope", "in_progress"],
        ["esimEurope", "refund_due"],
        ["number", "delivered", false],
        ["vpn", "delivered"],
        ["esimEurope", "delivered"],
        ["number", "delivered"],
        ["vpn", "delivered"],
      ]),
      TRANSACTIONS.live,
    ),
    "live",
  ),
  receipts(
    {
      id: "dashboard-receipts-none",
      screen: "Receipts",
      when: "A merchant opens Receipts before any product was released to a buyer.",
      cause: "The gateway lists no receipts.",
    },
    receiptsView(seenBy("live"), CATALOGUE, receiptsOf([]), TRANSACTIONS.live),
    "live",
  ),
  receipts(
    {
      id: "dashboard-receipts-test",
      screen: "Receipts",
      when: "A merchant on the test site looks at the receipts of their trial purchases.",
      cause: "Every receipt there is a test purchase, settled with test funds on Base Sepolia.",
    },
    receiptsView(
      seenBy("test"),
      CATALOGUE,
      receiptsOf(
        [
          ["vpn", "delivered"],
          ["esimEurope", "delivered"],
        ],
        true,
      ),
      TRANSACTIONS.test,
    ),
    "test",
  ),
];

const integrations = (told: Told, view: ReturnType<typeof integrationsView>, mode: SurfaceMode) =>
  at(told, { path: "/integrations", mode, loaded: { "routes/integrations": view } });

const INTEGRATIONS: GalleryState[] = [
  integrations(
    {
      id: "dashboard-integrations-live",
      screen: "Integrations",
      when: "A merchant on the live site opens Integrations.",
      cause:
        "The live site does not offer the WooCommerce connector, so the SDK is the only way in.",
    },
    integrationsView(undefined),
    "live",
  ),
  integrations(
    {
      id: "dashboard-integrations",
      screen: "Integrations",
      when: "A merchant on the test site opens Integrations without having connected a shop.",
      cause: "No WooCommerce connection and no Connect started for the account.",
    },
    integrationsView({ kind: "none" }),
    "test",
  ),
  integrations(
    {
      id: "dashboard-integrations-shop-connected",
      screen: "Integrations",
      when: "A merchant whose WooCommerce shop is connected opens Integrations.",
      cause: "The shop's keys arrived and grant read and write.",
    },
    integrationsView(CONNECTED),
    "test",
  ),
  integrations(
    {
      id: "dashboard-integrations-shop-read-only",
      screen: "Integrations",
      when: "A merchant approved only read access in their shop.",
      cause: "The shop's keys arrived granting read, which cannot create an order.",
    },
    integrationsView({
      kind: "connected",
      shop: { shopUrl: SHOP, permissions: "read", connectedAt: new Date("2026-10-12T09:12:00Z") },
    }),
    "test",
  ),
  integrations(
    {
      id: "dashboard-integrations-shop-waiting",
      screen: "Integrations",
      when: "A merchant comes to Integrations minutes after pressing Connect.",
      cause: "A Connect started less than fifteen minutes ago and no keys have arrived yet.",
    },
    integrationsView(WAITING_FOR_KEYS),
    "test",
  ),
  integrations(
    {
      id: "dashboard-integrations-shop-no-keys",
      screen: "Integrations",
      when: "A merchant comes back to Integrations long after a Connect they never finished.",
      cause: "Fifteen minutes passed after a Connect with no keys arriving from the shop.",
    },
    integrationsView(NO_KEYS),
    "test",
  ),
  integrations(
    {
      id: "dashboard-integrations-shop-unread",
      screen: "Integrations",
      when: "A merchant opens Integrations while the dashboard's database is failing.",
      cause:
        "The account's WooCommerce connection could not be read, which the page says rather than guessing.",
    },
    integrationsView({ kind: "unread" }),
    "test",
  ),
];

const shop = (told: Told, view: ReturnType<typeof wooShopView>, path = "/woocommerce") =>
  at(told, { path, mode: "test", loaded: { "routes/woocommerce": view } });

/** The answer to a press on the shop screen, drawn at the press's own address. */
const shopPress = (
  told: Told,
  press: "connect" | "import" | "switch" | "disconnect",
  view: ReturnType<typeof wooShopView> | ReturnType<typeof wooImportView>,
) =>
  at(told, {
    path: `/woocommerce/${press}`,
    mode: "test",
    pressed: { [`routes/woocommerce-${press}`]: view },
  });

const WOOCOMMERCE: GalleryState[] = [
  shop(
    {
      id: "dashboard-woocommerce",
      screen: "WooCommerce",
      when: "A merchant who sells through their own code opens the WooCommerce screen.",
      cause: "No shop is connected and no Connect is under way.",
    },
    shopOn(shopRead({ kind: "none" }, { through: "api" })),
  ),
  shop(
    {
      id: "dashboard-woocommerce-waiting",
      screen: "WooCommerce",
      when: "A merchant comes back to the screen a few minutes after pressing Connect.",
      cause: "A Connect started less than fifteen minutes ago and no keys have arrived yet.",
    },
    shopOn(shopRead(WAITING_FOR_KEYS)),
  ),
  shop(
    {
      id: "dashboard-woocommerce-no-keys",
      screen: "WooCommerce",
      when: "A merchant comes back long after a Connect they did not finish.",
      cause: "Fifteen minutes passed with no keys from the shop; why is not known.",
    },
    shopOn(shopRead(NO_KEYS)),
  ),
  shop(
    {
      id: "dashboard-woocommerce-way-back",
      screen: "WooCommerce",
      when: "A merchant pressed Connect, never approved in the shop, and comes back.",
      cause:
        "The merchant sells through the shop and none is connected, so nothing sells until they switch back.",
    },
    shopOn(shopRead({ kind: "none" })),
  ),
  shop(
    {
      id: "dashboard-woocommerce-connected",
      screen: "WooCommerce",
      when: "A merchant approves access in their shop and is sent back here.",
      cause: "The shop's server posted its keys, and the browser came back from the shop.",
    },
    shopOn(shopRead(CONNECTED), { cameBack: true }),
    "/woocommerce?from=shop",
  ),
  shop(
    {
      id: "dashboard-woocommerce-connected-on-code",
      screen: "WooCommerce",
      when: "A merchant whose shop is connected still sells through their own code.",
      cause:
        "The shop is connected but the merchant's integration is their code, so the shop's cards are off sale.",
    },
    shopOn(shopRead(CONNECTED, { through: "api" })),
  ),
  shop(
    {
      id: "dashboard-woocommerce-import-waits-for-settings",
      screen: "WooCommerce",
      when: "A merchant with a connected shop has not set a payout wallet.",
      cause:
        "The gateway refuses every card until the wallet is set, so Import would publish nothing.",
    },
    shopOn(shopRead(CONNECTED, { unset: ["no_payout_wallet"] })),
  ),
  shop(
    {
      id: "dashboard-woocommerce-selling-paused",
      screen: "WooCommerce",
      when: "A merchant with a connected shop has paused all sales.",
      cause: "The merchant's selling is stopped, so nothing imported sells until it starts again.",
    },
    shopOn(shopRead(CONNECTED, { stopped: true })),
  ),
  shop(
    {
      id: "dashboard-woocommerce-read-only",
      screen: "WooCommerce",
      when: "A merchant approved only read access in their shop.",
      cause: "The shop's keys grant read, which cannot create the order a purchase needs.",
    },
    shopOn(
      shopRead({
        kind: "connected",
        shop: { shopUrl: SHOP, permissions: "read", connectedAt: new Date("2026-10-12T09:12:00Z") },
      }),
    ),
  ),
  ((typed) =>
    shopPress(
      {
        id: "dashboard-woocommerce-connect-refused",
        screen: "WooCommerce",
        when: "A merchant presses Connect with an address that is not their shop's https address.",
        cause: "The typed address is refused before the browser is sent anywhere.",
      },
      "connect",
      shopOn(shopRead({ kind: "none" }, { through: "api" }), {
        problem: whatIsWrongWithTheShopUrl(typed) ?? "",
        typed,
      }),
    ))("shop.example.com/wp-admin"),
  shopPress(
    {
      id: "dashboard-woocommerce-connect-orders-waiting",
      screen: "WooCommerce",
      when: "A merchant presses Connect while orders their code took are still open.",
      cause: "The gateway refuses the switch to the shop until those orders end.",
    },
    "connect",
    shopOn(shopRead({ kind: "none" }, { through: "api" }), {
      problem: TO_THE_SHOP,
      typed: SHOP,
    }),
  ),
  shopPress(
    {
      id: "dashboard-woocommerce-import",
      screen: "WooCommerce import",
      when: "A merchant presses Import the catalog.",
      cause:
        "The shop's catalogue was read, and each product was published, refused or left in the shop.",
    },
    "import",
    wooImportView(
      SHOP,
      [
        {
          id: imported("Coffee & Brunch Gift Card").id,
          title: "Coffee & Brunch Gift Card",
          published: idOf("itm", "gift card"),
        },
        {
          id: imported("Coffee beans, one kilogram").id,
          title: "Coffee beans, one kilogram",
          problems: [SITE_IN_SETTINGS],
        },
      ],
      IMPORTED.skipped,
    ),
  ),
  shopPress(
    {
      id: "dashboard-woocommerce-import-interrupted",
      screen: "WooCommerce import",
      when: "A merchant presses Import while Agentify is failing to answer.",
      cause: "The first product got no verdict, so the import stopped and the rest were not sent.",
    },
    "import",
    wooImportView(
      SHOP,
      [
        {
          id: imported("Coffee beans, one kilogram").id,
          title: "Coffee beans, one kilogram",
          failed: LATE.why,
        },
        {
          id: imported("Coffee & Brunch Gift Card").id,
          title: "Coffee & Brunch Gift Card",
          notAttempted: true,
        },
      ],
      IMPORTED.skipped,
    ),
  ),
  shopPress(
    {
      id: "dashboard-woocommerce-import-refused",
      screen: "WooCommerce",
      when: "A merchant presses Import before setting a payout wallet.",
      cause:
        "The gateway would refuse every card, so the shop was not read and nothing was imported.",
    },
    "import",
    shopOn(shopRead(CONNECTED, { unset: ["no_payout_wallet"] }), { refused: ["no_payout_wallet"] }),
  ),
  shopPress(
    {
      id: "dashboard-woocommerce-switch-refused",
      screen: "WooCommerce",
      when: "A merchant presses Sell through this shop while orders their code took are open.",
      cause: "The gateway refuses the switch until those orders end.",
    },
    "switch",
    shopOn(shopRead(CONNECTED, { through: "api" }), {
      switching: TO_THE_SHOP,
    }),
  ),
  shopPress(
    {
      id: "dashboard-woocommerce-disconnect-refused",
      screen: "WooCommerce",
      when: "A merchant presses Forget this shop while orders the shop took are open.",
      cause: "The gateway refuses the switch back to the merchant's code until those orders end.",
    },
    "disconnect",
    shopOn(shopRead(CONNECTED), {
      leaving: TO_THE_CODE,
    }),
  ),
  at(
    {
      id: "dashboard-woocommerce-return",
      screen: "Back from the shop",
      when: "A browser comes back from the shop's approval screen without a dashboard session.",
      cause: "The shop was opened in another browser, or the session ended meanwhile.",
    },
    { path: "/woocommerce/return", mode: "test", loaded: { "routes/woocommerce-return": null } },
  ),
];

const keys = (told: Told, list: readonly MerchantKey[], options = {}, path = "/keys") =>
  at(told, { path, mode: "live", loaded: { "routes/keys": keysView(list, options) } });

const KEYS: GalleryState[] = [
  keys(
    {
      id: "dashboard-keys-none",
      screen: "API keys",
      when: "A merchant opens API keys before creating any.",
      cause: "The gateway lists no keys for the merchant.",
    },
    [],
  ),
  keys(
    {
      id: "dashboard-keys-one-never-used",
      screen: "API keys",
      when: "A merchant has created a key their code has not used yet.",
      cause: "One key, with no call recorded against it.",
    },
    [keyOf("The order worker on our server", "2026-10-12T15:02:00Z", null)],
  ),
  keys(
    {
      id: "dashboard-keys-one-revoked",
      screen: "API keys",
      when: "A merchant replaced a key and revoked the old one.",
      cause: "Two keys, one of them revoked, which stays listed with the moment it stopped.",
    },
    [WORKER, OLD_WORKER],
  ),
  keys(
    {
      id: "dashboard-keys-many",
      screen: "API keys",
      when: "A merchant with several services, each with its own key, opens API keys.",
      cause: "The gateway lists six keys, two of them revoked.",
    },
    [
      WORKER,
      keyOf("Price checks for the virtual numbers", "2026-09-10T11:30:00Z", "2026-10-12T16:39:58Z"),
      keyOf("Nightly catalogue sync", "2026-09-11T02:00:00Z", "2026-10-12T02:00:07Z"),
      keyOf("Staging", "2026-09-15T13:45:00Z", null),
      OLD_WORKER,
      keyOf(
        "A laptop that was lost",
        "2026-08-21T10:00:00Z",
        "2026-08-30T18:22:10Z",
        "2026-08-31T07:03:00Z",
      ),
    ],
  ),
  keys(
    {
      id: "dashboard-keys-new-form",
      screen: "API keys",
      when: "A merchant follows Create an API key from Integrations.",
      cause: "The address asks for the new key's form, which takes the focus.",
    },
    [WORKER],
    { startNew: true },
    "/keys?new=key",
  ),
  at(
    {
      id: "dashboard-keys-name-refused",
      screen: "API keys",
      when: "A merchant presses Issue a key with the name box empty.",
      cause:
        "A key with no name is refused, because it could not be told from the others when revoking.",
    },
    {
      path: "/keys",
      mode: "live",
      loaded: { "routes/keys": null },
      pressed: {
        "routes/keys": keysView([WORKER], { problem: whatIsWrongWithTheLabel("") }),
      },
    },
  ),
  at(
    {
      id: "dashboard-keys-issued",
      screen: "The new key",
      when: "A merchant presses Issue a key.",
      cause: "The gateway issued the key, and this answer is the only time its secret is shown.",
    },
    {
      path: "/keys",
      mode: "live",
      loaded: { "routes/keys": null },
      pressed: { "routes/keys": newKeyView("The order worker on our server", SECRET) },
    },
  ),
];

const settings = (
  told: Told,
  view: ReturnType<typeof settingsView>,
  { mode = "live", path = "/settings" }: { mode?: SurfaceMode; path?: string } = {},
) =>
  at(told, {
    path,
    mode,
    loaded:
      path === "/settings/payout-wallet"
        ? { "routes/settings-payout-wallet": view }
        : { "routes/settings": view, "routes/settings-site": null },
  });

const SETTINGS: GalleryState[] = [
  settings(
    {
      id: "dashboard-settings",
      screen: "Settings",
      when: "A merchant who has set everything opens Settings.",
      cause:
        "The seller name, the shop's site and the payout wallet are all set, and live sales are approved.",
    },
    settingsView("live", WHO, { ...settingsOf(), liveApproval: true }),
  ),
  settings(
    {
      id: "dashboard-settings-new-merchant",
      screen: "Settings",
      when: "A new merchant on the test site opens Settings before setting anything.",
      cause: "No seller name, no site and no payout wallet, and the test site asks for the wallet.",
    },
    settingsView("test", WHO, {
      sellerName: null,
      sellerSite: null,
      payoutWallet: PayoutWalletSchema.parse({ payout_wallet: null, pending: null }),
    }),
    { mode: "test" },
  ),
  settings(
    {
      id: "dashboard-settings-not-approved",
      screen: "Settings",
      when: "A merchant on the live site has not been approved for live sales yet.",
      cause: "The operator's approval is missing, so every card is refused on live.",
    },
    settingsView("live", WHO, { ...settingsOf(), liveApproval: false }),
  ),
  settings(
    {
      id: "dashboard-settings-wallet-change-waiting",
      screen: "Settings",
      when: "A merchant on the live site has asked for a different payout wallet.",
      cause:
        "A change of the wallet waits forty-eight hours after every account is told, and can be cancelled meanwhile.",
    },
    settingsView("live", WHO, { ...settingsOf({ payoutWallet: WAITING }), liveApproval: true }),
  ),
  ((typed) =>
    settings(
      {
        id: "dashboard-settings-name-refused",
        screen: "Settings",
        when: "A merchant saves a seller name with a character outside plain ASCII.",
        cause: "The catalogue's rule refuses the name, which is given back to correct.",
      },
      settingsView(
        "live",
        WHO,
        { ...settingsOf(), liveApproval: true },
        { kind: "name", problem: whatIsWrongWithTheName(typed) ?? "", typed },
      ),
    ))("Freeland — eSIM & VPN"),
  settings(
    {
      id: "dashboard-settings-name-emptied",
      screen: "Settings",
      when: "A merchant clears the seller name and saves, trying to stop being listed.",
      cause: "A name cannot be taken away once set; the page points at pausing sales instead.",
    },
    settingsView(
      "live",
      WHO,
      { ...settingsOf(), liveApproval: true },
      { kind: "name", problem: NAME_CANNOT_BE_TAKEN_AWAY, typed: "" },
    ),
  ),
  ((typed) =>
    settings(
      {
        id: "dashboard-settings-site-refused",
        screen: "Settings",
        when: "A merchant saves their shop's site with a page after the domain.",
        cause:
          "The site must be https and the domain alone, so the address is given back to correct.",
      },
      settingsView(
        "live",
        WHO,
        { ...settingsOf(), liveApproval: true },
        { kind: "site", problem: whatIsWrongWithTheSite(typed) ?? "", typed },
      ),
      { path: "/settings/site" },
    ))("https://freeland.example/shop"),
  settings(
    {
      id: "dashboard-settings-site-emptied",
      screen: "Settings",
      when: "A merchant clears their shop's site and saves.",
      cause: "A site cannot be removed once given, only changed.",
    },
    settingsView(
      "live",
      WHO,
      { ...settingsOf(), liveApproval: true },
      { kind: "site", problem: SITE_CANNOT_BE_TAKEN_AWAY, typed: "" },
    ),
    { path: "/settings/site" },
  ),
  settings(
    {
      id: "dashboard-settings-wallet-mistyped",
      screen: "Settings",
      when: "A merchant pastes a payout wallet with one character's case changed.",
      cause:
        "The address fails its checksum, so nothing is saved and the address is shown whole to check.",
    },
    settingsView(
      "live",
      WHO,
      { ...settingsOf(), liveApproval: true },
      { kind: "wallet", problem: whatIsWrongWithTheWallet(MISTYPED) ?? "", typed: MISTYPED },
    ),
    { path: "/settings/payout-wallet" },
  ),
  settings(
    {
      id: "dashboard-settings-wallet-needed",
      screen: "Settings",
      when: "A merchant presses Save on the payout wallet with the box empty.",
      cause: "An address is needed, and nothing is saved.",
    },
    settingsView(
      "test",
      WHO,
      settingsOf({
        payoutWallet: PayoutWalletSchema.parse({ payout_wallet: null, pending: null }),
      }),
      { kind: "wallet", problem: WALLET_NEEDED, typed: "" },
    ),
    { mode: "test", path: "/settings/payout-wallet" },
  ),
  settings(
    {
      id: "dashboard-settings-wallet-cancelled-by-typing",
      screen: "Settings",
      when: "A merchant types the address paid into now while a change of it waits.",
      cause: "Asking for the current address cancels the waiting change, and the page says so.",
    },
    settingsView(
      "live",
      WHO,
      { ...settingsOf(), liveApproval: true },
      { kind: "wallet-notice", notice: cancelledByTyping(PAID_INTO, ASKED_FOR) },
    ),
    { path: "/settings/payout-wallet" },
  ),
  settings(
    {
      id: "dashboard-settings-wallet-change-landed",
      screen: "Settings",
      when: "A merchant presses Cancel this change on a page opened before the change took effect.",
      cause:
        "The change took effect before the press arrived, so there was nothing left to cancel.",
    },
    settingsView(
      "live",
      WHO,
      {
        ...settingsOf({
          payoutWallet: PayoutWalletSchema.parse({ payout_wallet: ASKED_FOR, pending: null }),
        }),
        liveApproval: true,
      },
      {
        kind: "wallet-notice",
        notice: landedBeforePress({
          waiting: ASKED_FOR,
          from: "2026-10-14T16:05:00Z",
          paid: PAID_INTO,
        }),
      },
    ),
    { path: "/settings/payout-wallet/cancel" },
  ),
  settings(
    {
      id: "dashboard-settings-signed-out-others",
      screen: "Settings",
      when: "A merchant presses Sign out every other device.",
      cause: "The press ended the account's other sessions and says how many.",
    },
    settingsView(
      "live",
      WHO,
      { ...settingsOf(), liveApproval: true },
      { kind: "account", notice: signedOutOthers(2) },
    ),
    { path: "/settings/sign-out-others" },
  ),
];

const PROBLEMS: GalleryState[] = [
  at(
    {
      id: "dashboard-no-such-page",
      screen: "No such page",
      when: "A signed-in merchant follows a link to an address the dashboard does not have.",
      cause: "The address matches none of the dashboard's pages.",
    },
    { path: "/reports", mode: "live", loaded: { "routes/no-such-page": null } },
  ),
  at(
    {
      id: "dashboard-page-not-answered",
      screen: "Something went wrong",
      when: "A merchant opens a page while Agentify is not answering.",
      cause: "The gateway did not answer the page's read in time; the page offers itself again.",
    },
    {
      path: "/cards",
      mode: "live",
      failed: {
        "routes/gate": thrown(LATE_PROBLEM.status, {
          kind: "problem",
          chrome: chromeIn("live"),
          said: LATE_PROBLEM.said,
          again: "/cards",
        }),
      },
    },
  ),
  at(
    {
      id: "dashboard-press-not-answered",
      screen: "Something went wrong",
      when: "A merchant presses Pause on a card while Agentify is not answering.",
      cause: "The gateway did not answer the press in time, so whether it was done is not known.",
    },
    {
      path: `/cards?pause=${idOf("itm", "vpn")}`,
      mode: "live",
      failed: {
        "routes/gate": thrown(LATE_PROBLEM.status, {
          kind: "problem",
          chrome: chromeIn("live"),
          said: LATE_PROBLEM.said,
        }),
      },
    },
  ),
  at(
    {
      id: "dashboard-not-drawn-for-you",
      screen: "Something went wrong",
      when: "A merchant presses a button on a page drawn before they signed in as somebody else in another tab.",
      cause:
        "The form was drawn for another address than the one signed in now, so it was refused.",
    },
    {
      path: "/settings",
      mode: "live",
      failed: {
        "routes/gate": thrown(409, {
          kind: "not-drawn-for-you",
          chrome: chromeIn("live"),
          who: "sales@example.com",
          start: "/cards",
        }),
      },
    },
  ),
  at(
    {
      id: "dashboard-form-from-elsewhere",
      screen: "Something went wrong",
      when: "A form is sent to the dashboard from another site.",
      cause:
        "The post's origin is not the dashboard's host, so it is refused before any page reads it.",
    },
    {
      path: "/cards?selling=pause",
      mode: "live",
      failed: {
        root: thrown(403, { kind: "problem", chrome: chromeIn("live"), said: NOT_FROM_HERE }),
      },
    },
  ),
  at(
    {
      id: "dashboard-broken",
      screen: "Something went wrong",
      when: "Something inside the dashboard fails while answering a press.",
      cause:
        "An exception in the dashboard itself, not a refusal; the page does not claim the press failed.",
    },
    {
      path: "/settings",
      mode: "live",
      failed: { "routes/gate": thrown(500, { kind: "broken", chrome: chromeIn("live") }) },
    },
  ),
];

export const gallery: GallerySurface = {
  id: "dashboard",
  name: "Seller dashboard",
  lang: "en",
  states: [
    ...SIGNING_IN,
    ...SETTING_UP,
    ...CARDS,
    ...ORDERS,
    ...RECEIPTS,
    ...INTEGRATIONS,
    ...WOOCOMMERCE,
    ...KEYS,
    ...SETTINGS,
    ...PROBLEMS,
  ],
};
