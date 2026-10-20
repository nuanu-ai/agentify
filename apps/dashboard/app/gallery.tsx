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
  merchantPayout,
  PAYOUT_SPLIT_NETWORKS,
  payoutSplitFor,
  payoutSplitNetworkOf,
  type RecordedPayoutSplit,
} from "@agentify/gateway";
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
  matchRoutes,
  type RouteObject,
} from "react-router";
import config from "../react-router.config.js";
import { type AccountNote, type AccountRead, accountOf } from "../src/account-banner.js";
import { NOT_FROM_HERE } from "../src/form-post.js";
import {
  ANSWER_WITHIN_MS,
  type Answer,
  lateAnswer,
  type PayoutSplits,
  switchRefused,
} from "../src/gateway.js";
import { integrationsView } from "../src/integrations-view.js";
import { keysView, newKeyView } from "../src/keys.js";
import type { LiveSalesView } from "../src/live-sales.js";
import {
  askViewOf,
  cancelledByTyping,
  googleRefusalView,
  type LinkAnswer,
  landedBeforePress,
  NOT_AN_ADDRESS,
  problemOf,
  type SignInView,
  signedOutOthers,
  whatIsWrongWithTheLabel,
} from "../src/page-services.js";
import {
  NOT_A_PAYOUT_WALLET,
  WALLET_NEEDED,
  whatIsWrongWithTheWallet,
} from "../src/payout-wallet.js";
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
import { cardsView, type FrameView, ordersView, receiptsView } from "../src/views.js";
import { cardsFromTheShop, type StoreProduct } from "../src/woo-catalog.js";
import { whatIsWrongWithTheShopUrl } from "../src/woo-connect.js";
import type { WooRecoveryView } from "../src/woo-recovery-pages.js";
import {
  type ShopAnswer,
  type ShopRead,
  type ShopState,
  wooImportView,
  wooShopView,
} from "../src/woo-views.js";
import { SITE_IN_SETTINGS } from "../src/words.js";
import type { Chrome, Trouble } from "./answer.js";
import { shortened } from "./components/copy.js";
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

/** A route's id as the build makes it: its file's path without the extension. */
const routeIdOf = (entry: RouteConfigEntry): string =>
  entry.id ?? entry.file.replace(/\.tsx?$/, "");

const stubOf = (entry: RouteConfigEntry): StubRoute => {
  const module = MODULES[`./${entry.file}`];
  if (module === undefined) throw new Error(`routes.ts names ${entry.file}, which is not here`);
  const route = {
    id: routeIdOf(entry),
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

/** The same tree as an address is matched against it. */
const matchedOf = (entry: RouteConfigEntry): RouteObject =>
  entry.index === true
    ? { id: routeIdOf(entry), index: true }
    : { id: routeIdOf(entry), path: entry.path, children: entry.children?.map(matchedOf) };

const TABLE: RouteObject[] = [{ id: "root", path: "/", children: routes.map(matchedOf) }];

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
  /** The banner the layout reads for a page about the merchant's selling; none unless given. */
  readonly account?: readonly AccountNote[];
  readonly loaded?: HydrationState["loaderData"];
  readonly pressed?: HydrationState["actionData"];
  readonly failed?: HydrationState["errors"];
}

type Told = Omit<GalleryState, "address" | "draw">;

/**
 * The address the gate's loader names, for a page behind the gate, and the
 * banner the merchant's layout reads on a page about their selling; a page in
 * front of the gate is drawn for nobody, as the server draws it.
 */
const gateAt = (path: string, frame: FrameView): HydrationState["loaderData"] => {
  const matched = matchRoutes(TABLE, new URL(path, ORIGIN.live).pathname) ?? [];
  const under = (id: string) => matched.some(({ route }) => route.id === id);
  return {
    ...(under("routes/gate") ? { "routes/gate": { who: WHO } } : {}),
    ...(under("routes/merchant-only") ? { "routes/merchant-only": frame } : {}),
  };
};

/** A state at its address, drawn by the route tree as the server answers that address. */
const at = (
  told: Told,
  { path, mode, account = [], loaded, pressed, failed }: Drawn,
): GalleryState => ({
  ...told,
  address: `${BASE}${path}`,
  draw: () => {
    const Stub = createRoutesStub(TREE);
    return (
      <Stub
        initialEntries={[path]}
        hydrationData={{
          loaderData: {
            root: chromeIn(mode),
            ...gateAt(path, { account }),
            ...loaded,
          },
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

const ADDRESSES: Readonly<Record<SurfaceMode, string | null>> = {
  live: "https://basescan.org/address/",
  test: "https://sepolia.basescan.org/address/",
  sandbox: null,
};

/** The chain a merchant's wallet works on, as each channel's configuration names it. */
const WALLET_CHAINS: Readonly<Record<SurfaceMode, number | null>> = {
  live: 8453,
  test: 84532,
  sandbox: null,
};

/** The example addresses from the checksum's own specification. */
const PAID_INTO = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const ASKED_FOR = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
/** The first with its last letter's case flipped, which the checksum catches. */
const MISTYPED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD";

const MERCHANT = idOf("mch", "Freeland");

/** Each channel's payout split as the gateway makes it. */
const PAYOUT_NETWORKS: Readonly<Record<SurfaceMode, string>> = {
  live: "eip155:8453",
  test: "eip155:84532",
  sandbox: "eip155:84532",
};

const networkIn = (mode: SurfaceMode) =>
  payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, PAYOUT_NETWORKS[mode]);

const splitOf = (mode: SurfaceMode, wallet: string): RecordedPayoutSplit => ({
  ...payoutSplitFor(networkIn(mode), MERCHANT, wallet),
  recordedAt: Date.parse("2026-10-01T09:00:00Z"),
});

/** The gateway's answer about the splits of a merchant paid at `wallet`, waiting on `pending`. */
const splitsOf = (
  mode: SurfaceMode,
  wallet: string | null,
  { pending, toPayOut }: { pending?: string; toPayOut?: readonly RecordedPayoutSplit[] } = {},
): PayoutSplits => {
  const network = networkIn(mode);
  const paidOut = toPayOut ?? (wallet === null ? [] : [splitOf(mode, wallet)]);
  return {
    rate: {
      commissionAllocation: network.commissionAllocation,
      totalAllocation: network.totalAllocation,
    },
    inForce: wallet === null ? null : splitOf(mode, wallet),
    pending: pending === undefined ? null : splitOf(mode, pending),
    payout: paidOut.length === 0 ? null : merchantPayout(network, paidOut, PAYOUT_SPLIT_NETWORKS),
  };
};

/** The split each order or receipt whose money moved was charged into. */
const paidIntoSplit = (
  mode: SurfaceMode,
  rows: readonly { readonly id: string; readonly status: string }[],
): Readonly<Record<string, RecordedPayoutSplit>> =>
  Object.fromEntries(
    rows
      .filter((row) =>
        ["delivered", "shipped", "unfulfilled", "fulfillment_closed"].includes(row.status),
      )
      .map((row) => [row.id, splitOf(mode, PAID_INTO)]),
  );

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

/** The banner the merchant's layout reads for this viewer, selling through their code unless told. */
const bannerOf = (viewer: Viewer, read: AccountRead = {}) =>
  accountOf(viewer, { selling: "open", through: "api", ...read });

type Status =
  | "in_progress"
  | "delivered"
  | "shipped"
  | "cancelled"
  | "rejected"
  | "payment_unresolved"
  | "declined"
  | "expired"
  | "unfulfilled"
  | "fulfillment_closed"
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
      payment_status:
        status === "payment_unresolved"
          ? "unresolved"
          : ["delivered", "shipped", "unfulfilled", "fulfillment_closed"].includes(status)
            ? "paid"
            : "not_paid",
    })),
  });

type Outcome = "delivered" | "unfulfilled" | "in_progress";

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

const settingsOf = (more: Partial<Settings> = {}, mode: SurfaceMode = "live"): Settings => ({
  sellerName: "Freeland",
  sellerSite: "https://freeland.example",
  payoutWallet: PayoutWalletSchema.parse({ payout_wallet: PAID_INTO, pending: null }),
  payoutSplits: splitsOf(mode, PAID_INTO),
  addressPage: ADDRESSES[mode],
  walletChain: WALLET_CHAINS[mode],
  ...more,
});

const WAITING = PayoutWalletSchema.parse({
  payout_wallet: PAID_INTO,
  pending: { payout_wallet: ASKED_FOR, takes_effect_at: "2026-10-14T16:05:00Z" },
});

const shopRead = (state: ShopState, more: Partial<ShopRead> = {}): ShopRead => ({
  state,
  through: "woocommerce",
  ...more,
});

const shopOn = (read: ShopRead, answer: ShopAnswer = {}) => wooShopView(read, answer);

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
const TO_THE_SHOP = refusalIn(switchRefused("woocommerce", ORDERS_WAITING));
const TO_THE_CODE = refusalIn(switchRefused("api", ORDERS_WAITING));

// --- the states ----------------------------------------------------------------

/**
 * Whether the sign-in offers Google, as both channels are configured: the live
 * site and the test site each serve the Google button.
 */
const GOOGLE_ON = true;

/** The sign-in page at its address, or, given the answer to a press, as that answer draws it. */
const signIn = (told: Told, path: string, answered?: SignInView): GalleryState =>
  at(told, {
    path,
    mode: "live",
    loaded: { "routes/sign-in": askViewOf(new URL(path, ORIGIN.live).searchParams, GOOGLE_ON) },
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
  at(
    {
      id: "dashboard-sign-in-from-an-ad",
      screen: "Sign in",
      when: "Somebody presses the button on a landing page they reached through a paid ad.",
      cause:
        "The address carries the ad tracker's click identifier and the report to the tracker is switched on. The page is the one without it, and both ways in carry the click, which is reported if this sign-in makes the address's first account.",
    },
    {
      path: "/sign-in?clickid=qa_click_0123456789abcdef",
      mode: "live",
      loaded: {
        "routes/sign-in": {
          ...askViewOf(new URLSearchParams(), GOOGLE_ON),
          clickId: "qa_click_0123456789abcdef",
        },
      },
    },
  ),
  at(
    {
      id: "dashboard-google-start-unavailable",
      screen: "Sign in",
      when: "Somebody presses Google sign-in while Google cannot be reached.",
      cause: "The start failed, so the email form keeps the requested dashboard section.",
    },
    {
      path: "/sign-in/google",
      mode: "live",
      pressed: {
        "routes/sign-in-google": googleRefusalView(GOOGLE_ON, "unavailable", "settings"),
      },
    },
  ),
  at(
    {
      id: "dashboard-google-address-unverified",
      screen: "Sign in",
      when: "Google returns an address whose current ownership it does not confirm.",
      cause: "No session opened; the email form lets the person confirm the returned address.",
    },
    {
      path: "/sign-in/google/callback",
      mode: "live",
      loaded: {
        "routes/sign-in-google-callback": googleRefusalView(
          GOOGLE_ON,
          "email-unverified",
          "settings",
          WHO,
        ),
      },
    },
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
    { screen: "ask", destination: "default", googleEnabled: GOOGLE_ON, problem: NOT_AN_ADDRESS },
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
      loaded: { "routes/sign-in": askViewOf(new URLSearchParams(), GOOGLE_ON) },
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
        "routes/sign-in-open": {
          screen: "open",
          token: "the token from the email",
          email: WHO,
        },
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

const cards = (
  told: Told,
  view: ReturnType<typeof cardsView>,
  mode: SurfaceMode,
  more: Readonly<{ path?: string; account?: readonly AccountNote[] }> = {},
): GalleryState =>
  at(told, {
    path: more.path ?? "/cards",
    mode,
    ...(more.account === undefined ? {} : { account: more.account }),
    loaded: { "routes/cards": view },
  });

/** The cards at an address that asks for a search, a segment or a page. */
const cardsAt = (path: string, list: ReturnType<typeof cardsOf>, mode: SurfaceMode = "live") =>
  cardsView(list, ORIGIN[mode], false, undefined, new URL(path, ORIGIN[mode]).searchParams);

/**
 * A data plan per country and size, as an eSIM seller lists them: a catalogue
 * longer than one page.
 */
const WHOLE_CATALOGUE = MerchantCardListSchema.parse({
  selling: "open",
  cards: [
    "Albania",
    "Argentina",
    "Australia",
    "Austria",
    "Bahrain",
    "Belgium",
    "Brazil",
    "Bulgaria",
    "Cambodia",
    "Canada",
    "Chile",
    "China",
    "Colombia",
    "Croatia",
    "Cyprus",
    "Czechia",
    "Denmark",
    "Egypt",
    "Estonia",
    "Finland",
    "France",
    "Georgia",
    "Germany",
    "Greece",
    "Hong Kong",
    "Hungary",
    "Iceland",
    "India",
    "Indonesia",
    "Ireland",
    "Israel",
    "Italy",
    "Japan",
    "Jordan",
    "Kazakhstan",
    "Kenya",
    "Latvia",
    "Lithuania",
    "Malaysia",
    "Malta",
    "Mexico",
    "Morocco",
    "Netherlands",
    "New Zealand",
    "Norway",
    "Oman",
    "Peru",
    "Philippines",
    "Poland",
    "Portugal",
    "Qatar",
    "Romania",
    "Saudi Arabia",
    "Serbia",
    "Singapore",
    "Slovakia",
    "Slovenia",
    "South Africa",
    "South Korea",
    "Spain",
    "Sri Lanka",
    "Sweden",
    "Switzerland",
    "Taiwan",
    "Tanzania",
    "Thailand",
    "Turkey",
    "Ukraine",
    "United Arab Emirates",
    "United Kingdom",
    "Uruguay",
    "Vietnam",
  ].flatMap((country) =>
    [1, 3, 5].map((gigabytes) => {
      const code = `esim-${country.toLowerCase().replaceAll(" ", "-")}-${gigabytes}gb`;
      return {
        id: idOf("itm", code),
        as_of: "2026-10-01T09:00:00Z",
        card: {
          ...PRODUCTS.esimEurope,
          merchant_item_id: code,
          title: `eSIM ${country}, ${gigabytes} GB for 30 days`,
          price: { amount: `${(gigabytes * 1.5 + 2).toFixed(2)}`, currency: "USD" },
        },
        selling: "open",
        paused: false,
      };
    }),
  ),
});

/**
 * A parcel, which names its time to reach a carrier, and a data plan sent
 * later that names no window of its own, beside one that names its window.
 */
const WINDOWS = MerchantCardListSchema.parse({
  selling: "open",
  cards: [
    {
      id: idOf("itm", "esimEurope"),
      as_of: "2026-10-01T09:00:00Z",
      card: PRODUCTS.esimEurope,
      selling: "open",
      paused: false,
    },
    {
      id: idOf("itm", "esim-japan-unnamed"),
      as_of: "2026-10-01T09:00:00Z",
      card: {
        ...PRODUCTS.esimEurope,
        merchant_item_id: "esim-jp-3gb-15d",
        title: "eSIM Japan, 3 GB for 15 days",
        fulfill_deadline_seconds: undefined,
      },
      selling: "open",
      paused: false,
    },
    {
      id: idOf("itm", "router"),
      as_of: "2026-10-01T09:00:00Z",
      card: {
        merchant_item_id: "travel-router",
        title: "A pocket travel router",
        description: "A router for a hotel room, sent by post",
        price: { amount: "39.00", currency: "USD" },
        fulfillment: "ship",
        ship_within_seconds: 172_800,
        price_check: "handler",
      },
      selling: "open",
      paused: false,
    },
  ],
});

/** Presses the button that opens the menu at the end of the header's row. */
const openTheMenu = (page: Document) => {
  const button = page.querySelector<HTMLElement>(".site-menu > summary");
  if (button === null) throw new Error("the page draws no menu");
  button.click();
};

const CARDS: GalleryState[] = [
  cards(
    {
      id: "dashboard-cards",
      screen: "Cards",
      when: "A merchant whose code has published a few products opens the dashboard.",
      cause: "The gateway lists three cards, all on sale.",
    },
    cardsView(CATALOGUE, ORIGIN.live),
    "live",
  ),
  {
    ...cards(
      {
        id: "dashboard-cards-menu",
        screen: "Cards",
        when: "A merchant on a phone or a tablet opens the menu at the end of the header's row.",
        cause:
          "Where the sidebar gives way, the header keeps the lockup and the menu's button, and the menu holds the sections, the way to the documentation, the address and the way out.",
      },
      cardsView(CATALOGUE, ORIGIN.live),
      "live",
    ),
    scene: {
      steps: [{ shows: "Product cards", does: openTheMenu }],
      shows: "Sign out",
    },
  },
  cards(
    {
      id: "dashboard-cards-account-unread",
      screen: "Cards",
      when: "A merchant opens Cards while the read of their account's standing does not answer in time.",
      cause:
        "The layout could not read whether anything holds the account's sales, so the banner says it could not check rather than showing nothing.",
    },
    cardsView(CATALOGUE, ORIGIN.live),
    "live",
    { account: bannerOf(seenBy("live"), { unread: true }) },
  ),
  cards(
    {
      id: "dashboard-cards-many",
      screen: "Cards",
      when: "A merchant with a whole catalogue opens Cards.",
      cause: "The gateway lists eight cards, one of them paused by the merchant.",
    },
    cardsView(
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
  {
    ...cards(
      {
        id: "dashboard-cards-opened-row",
        screen: "Cards",
        when: "A merchant taps a card's price to read since when it holds.",
        cause:
          "A row shows the title, the price, the state, the delivery and the product code; a fixed price opens to the moment it holds from, which no row prints, on every width.",
      },
      cardsView(CATALOGUE, ORIGIN.live),
      "live",
    ),
    scene: {
      steps: [
        {
          shows: "On the card since",
          does: (page) => page.querySelector("details.price-since")?.setAttribute("open", ""),
        },
      ],
      shows: "On the card since",
    },
  },
  cards(
    {
      id: "dashboard-cards-windows",
      screen: "Cards",
      when: "A merchant who sells a parcel and a data plan whose card names no delivery window opens Cards.",
      cause:
        "A parcel's card names its time to reach a carrier; a card sent later that names no window is held to Agentify's default one, which the row says and links to rather than reading as no window at all.",
    },
    cardsView(WINDOWS, ORIGIN.live),
    "live",
  ),
  cards(
    {
      id: "dashboard-cards-cut-short",
      screen: "Cards",
      when: "A merchant selling a data plan per country and size opens Cards.",
      cause:
        "The catalogue holds 216 cards and a page draws fifty, so the list says which fifty of how many and leads to the next page.",
    },
    cardsAt("/cards", WHOLE_CATALOGUE),
    "live",
  ),
  cards(
    {
      id: "dashboard-cards-search",
      screen: "Cards",
      when: "A merchant searches a long catalogue for one country's plans.",
      cause:
        "The address carries the search, which the loader answers with the three cards whose title or product code holds it; each segment counts its share of them.",
    },
    cardsAt("/cards?q=japan", WHOLE_CATALOGUE),
    "live",
    { path: "/cards?q=japan" },
  ),
  cards(
    {
      id: "dashboard-cards-search-by-code",
      screen: "Cards",
      when: "A merchant follows the link the WooCommerce import gives a published product, or types a card's whole product code.",
      cause:
        "The search is one card's whole product code, so the list shows that card alone and says so, not every card whose code holds it.",
    },
    cardsAt("/cards?q=esim-japan-1gb", WHOLE_CATALOGUE),
    "live",
    { path: "/cards?q=esim-japan-1gb" },
  ),
  cards(
    {
      id: "dashboard-cards-search-no-match",
      screen: "Cards",
      when: "A merchant searches their cards for a word none of them holds.",
      cause:
        "No title or product code holds the search, so the list says what was searched for and offers to clear it, which is not what an empty catalogue says.",
    },
    cardsAt(
      "/cards?q=router",
      cardsOf("open", ["esimEurope", "esimAsia", { product: "vpn", paused: true }, "number"]),
    ),
    "live",
    { path: "/cards?q=router" },
  ),
  ((pasted) =>
    cards(
      {
        id: "dashboard-cards-search-cut",
        screen: "Cards",
        when: "A merchant pastes a card's whole description into the search.",
        cause:
          "The search is longer than 200 characters, so its first 200 are matched and given back, and the page says the rest was not used.",
      },
      cardsAt(`/cards?${new URLSearchParams({ q: pasted })}`, CATALOGUE),
      "live",
      { path: `/cards?${new URLSearchParams({ q: pasted })}` },
    ))(
    "A data plan delivered as a profile after the purchase. Scan the code it arrives with, keep the profile switched off until you land, and turn it on in your phone's settings once you are there; the plan starts counting its thirty days from that moment.",
  ),
  cards(
    {
      id: "dashboard-cards-segment-empty",
      screen: "Cards",
      when: "A merchant whose every card is on sale picks Off sale.",
      cause: "The segment holds no card, so the list says so and leads back to all of them.",
    },
    cardsAt("/cards?show=off-sale", CATALOGUE),
    "live",
    { path: "/cards?show=off-sale" },
  ),
  cards(
    {
      id: "dashboard-cards-none",
      screen: "Cards",
      when: "A merchant opens Cards before their code has published anything.",
      cause: "The gateway lists no cards, and everything publishing needs is set.",
    },
    cardsView(cardsOf("open", []), ORIGIN.live),
    "live",
  ),
  cards(
    {
      id: "dashboard-cards-first-on-live",
      screen: "Cards",
      when: "A merchant who has just signed up on the live site opens the dashboard for the first time.",
      cause:
        "No cards, no payout wallet and no approval yet, so the banner names both and leads to the test channel's dashboard, where the first sale is made.",
    },
    cardsView(cardsOf("open", []), ORIGIN.live),
    "live",
    { account: bannerOf(seenBy("live", { liveApproval: false, payout: { wallet: null } })) },
  ),
  cards(
    {
      id: "dashboard-cards-none-without-name",
      screen: "Cards",
      when: "A new merchant skipped choosing a seller name and opens Cards.",
      cause:
        "The merchant has no seller name, so every card their code publishes would be refused.",
    },
    cardsView(cardsOf("open", []), ORIGIN.live),
    "live",
    { account: bannerOf(seenBy("live", { sellerName: null })) },
  ),
  cards(
    {
      id: "dashboard-cards-none-with-woocommerce",
      screen: "Cards",
      when: "A merchant on the test site opens Cards before publishing anything.",
      cause: "No cards, and this dashboard offers the WooCommerce connector beside the SDK.",
    },
    cardsView(cardsOf("open", []), ORIGIN.test, true),
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
      cardsOf(
        "open",
        ON_SALE.map((product) => ({ product, selling: "paused" })),
      ),
      ORIGIN.live,
    ),
    "live",
    { account: bannerOf(seenBy("live", { liveApproval: false })) },
  ),
  cards(
    {
      id: "dashboard-cards-no-wallet",
      screen: "Cards",
      when: "A merchant on the test site has cards but has not set a payout wallet.",
      cause:
        "Where payments settle, a card is off sale until the wallet its share is paid out to is set.",
    },
    cardsView(
      cardsOf(
        "open",
        ON_SALE.map((product) => ({ product, selling: "paused" })),
      ),
      ORIGIN.test,
    ),
    "test",
    { account: bannerOf(seenBy("test", { payout: { wallet: null } })) },
  ),
  cards(
    {
      id: "dashboard-cards-no-name",
      screen: "Cards",
      when: "A merchant whose code published cards before they chose a seller name opens Cards.",
      cause:
        "Without a seller name the gateway keeps every card off sale, so the banner over the page says so and leads to Settings.",
    },
    cardsView(
      cardsOf(
        "open",
        ON_SALE.map((product) => ({ product, selling: "paused" })),
      ),
      ORIGIN.live,
    ),
    "live",
    { account: bannerOf(seenBy("live", { sellerName: null })) },
  ),
  cards(
    {
      id: "dashboard-cards-several-reasons",
      screen: "Cards",
      when: "A new merchant on the live site pressed Pause all sales before Agentify approved them or they set a payout wallet.",
      cause:
        "Three things hold the whole account at once, so the one banner names each of them, broadest first.",
    },
    cardsView(cardsOf("paused", ON_SALE), ORIGIN.live),
    "live",
    {
      account: bannerOf(seenBy("live", { liveApproval: false, payout: { wallet: null } }), {
        selling: "paused",
      }),
    },
  ),
  cards(
    {
      id: "dashboard-cards-all-paused",
      screen: "Cards",
      when: "A merchant who had paused one card has pressed Pause all sales.",
      cause:
        "The merchant's selling is paused, so every card is off sale and the banner says why; each card keeps its own switch, and the one they paused themselves stays paused when all sales resume.",
    },
    cardsView(
      cardsOf("paused", ["esimEurope", { product: "vpn", paused: true }, "number"]),
      ORIGIN.live,
    ),
    "live",
    { account: bannerOf(seenBy("live"), { selling: "paused" }) },
  ),
  cards(
    {
      id: "dashboard-cards-left",
      screen: "Cards",
      when: "A merchant who has left Agentify looks at their cards.",
      cause: "The merchant's selling is departed; nothing on this page puts it back on sale.",
    },
    cardsView(cardsOf("departed", ON_SALE), ORIGIN.live),
    "live",
    { account: bannerOf(seenBy("live"), { selling: "departed" }) },
  ),
  cards(
    {
      id: "dashboard-cards-left-none",
      screen: "Cards",
      when: "A merchant who left Agentify before publishing anything opens Cards.",
      cause:
        "The merchant's selling is departed and they have no cards, so the page offers no way to publish one.",
    },
    cardsView(cardsOf("departed", []), ORIGIN.live, true),
    "live",
    { account: bannerOf(seenBy("live"), { selling: "departed" }) },
  ),
  cards(
    {
      id: "dashboard-cards-selling-through-shop",
      screen: "Cards",
      when: "A merchant who switched to their WooCommerce shop looks at the cards their code published.",
      cause:
        "The merchant sells through the shop, so the code's cards are off sale until they switch back.",
    },
    cardsView(CATALOGUE, ORIGIN.test, true, {
      through: "woocommerce",
      offSale: CATALOGUE.cards.map((entry) => entry.id),
    }),
    "test",
    { account: bannerOf(seenBy("test"), { through: "woocommerce" }) },
  ),
  cards(
    {
      id: "dashboard-cards-shop-cards-while-code-sells",
      screen: "Cards",
      when: "A merchant who imported products from their WooCommerce shop switched back to selling through their own code.",
      cause:
        "The code sells, so the cards the shop published are off sale; no banner reason covers them, so each of those rows says why.",
    },
    cardsView(cardsOf("open", ON_SALE), ORIGIN.test, true, {
      through: "api",
      offSale: [idOf("itm", "number")],
    }),
    "test",
  ),
];

/**
 * The orders the gateway's open list would hold among these: the ones still
 * owed goods or money, as near as a status can say it.
 */
const openAmong = (listed: ReturnType<typeof ordersOf>) =>
  OrderListSchema.parse({
    orders: listed.orders.filter((order) =>
      ["in_progress", "unfulfilled", "delivered_unpaid", "payment_unresolved"].includes(
        order.status,
      ),
    ),
  });

/**
 * Orders as the loader answers them at `path`, whose address carries the
 * search and the segment, with the unfulfilled orders' causes where they are known.
 */
const ordersAt = (
  path: string,
  listed: ReturnType<typeof ordersOf>,
  {
    mode = "live",
    cards = CATALOGUE,
    open = openAmong(listed),
    owed = {},
  }: Readonly<{
    mode?: SurfaceMode;
    cards?: ReturnType<typeof cardsOf>;
    open?: ReturnType<typeof ordersOf>;
    owed?: Parameters<typeof ordersView>[5];
  }> = {},
) =>
  ordersView(
    mode,
    cards,
    listed,
    open,
    new URL(path, ORIGIN[mode]).searchParams,
    owed,
    paidIntoSplit(mode, listed.orders),
  );

/** The layout reads the banner from the same selling state the orders' cards carry. */
const orders = (
  told: Told,
  listed: ReturnType<typeof ordersOf>,
  path = "/orders",
  more: Parameters<typeof ordersAt>[2] = {},
): GalleryState =>
  at(told, {
    path,
    mode: more.mode ?? "live",
    account: bannerOf(seenBy(more.mode ?? "live"), {
      selling: (more.cards ?? CATALOGUE).selling,
    }),
    loaded: { "routes/orders": ordersAt(path, listed, more) },
  });

const OWING = ordersOf([
  ["esimEurope", "unfulfilled"],
  ["number", "delivered_unpaid"],
  ["vpn", "delivered"],
  ["esimWeek", "unfulfilled"],
]);

/** The first unfulfilled order ran out of time, the second was refused by the merchant's code. */
const OWED_BECAUSE = Object.fromEntries(
  OWING.orders
    .filter((order) => order.status === "unfulfilled")
    .map((order, at) => [order.id, at === 0 ? "deadline_passed" : "refused"] as const),
);

/** A season of sales, one every 37 minutes back from the latest. */
const SEASON = ordersOf(
  Array.from(
    { length: 214 },
    (_, at) => [(["vpn", "esimEurope", "number"] as const)[at % 3] ?? "vpn", "delivered"] as const,
  ),
);

const CLOSED = OrderListSchema.parse({
  orders: ordersOf([
    ["esimEurope", "fulfillment_closed"],
    ["number", "payment_unresolved"],
  ]).orders.map((order, at) => ({
    ...order,
    merchant_closure: {
      closed_at: "2026-10-19T09:30:00Z",
      ...(at === 0
        ? { message: "The buyer and merchant arranged the remedy outside Agentify." }
        : {}),
    },
  })),
});

const ORDERS: GalleryState[] = [
  {
    ...orders(
      {
        id: "dashboard-orders-closed",
        screen: "Orders",
        when: "A merchant checks an order they closed and an original payment still unknown.",
        cause:
          "Merchant closure is shown separately from the original payment. The explanation is attributed to the merchant; the unknown payment remains unknown.",
      },
      CLOSED,
    ),
    scene: {
      steps: [
        {
          shows: "Order details",
          does: (page) => page.querySelector("details.cell-more")?.setAttribute("open", ""),
        },
      ],
      shows: "Your explanation to the buyer",
    },
  },
  {
    ...orders(
      {
        id: "dashboard-orders-close",
        screen: "Orders",
        when: "A merchant opens a paid unfulfilled order to stop future Agentify delivery.",
        cause:
          "The shared order control offers an optional statement and says what closure does: no transfer and no shop cancellation.",
      },
      OWING,
    ),
    scene: {
      steps: [
        {
          shows: "Order details",
          does: (page) => page.querySelector("details.cell-more")?.setAttribute("open", ""),
        },
      ],
      shows: "Close fulfillment",
    },
  },
  orders(
    {
      id: "dashboard-orders",
      screen: "Orders",
      when: "A merchant whose products are selling opens Orders.",
      cause:
        "The gateway lists orders that went through or are under way, none of them owing anything.",
    },
    ordersOf([
      ["vpn", "delivered"],
      ["esimEurope", "in_progress"],
      ["number", "delivered"],
      ["esimEurope", "delivered"],
    ]),
  ),
  orders(
    {
      id: "dashboard-orders-need-you",
      screen: "Orders",
      when: "A merchant has paid orders left unfulfilled, and an order delivered without payment.",
      cause:
        "Two paid orders are unfulfilled, one after its delivery window and one refused by the integration. Each has its cause stated; the merchant decides the remedy. Another order was delivered but not paid.",
    },
    OWING,
    "/orders",
    { owed: OWED_BECAUSE },
  ),
  orders(
    {
      id: "dashboard-orders-every-ending",
      screen: "Orders",
      when: "A busy merchant scrolls back through their orders.",
      cause:
        "The gateway lists an order in each way an order can stand or end, so the State column holds its longest words, Payment outcome unknown and Declined at confirmation.",
    },
    ordersOf([
      ["vpn", "delivered"],
      ["esimEurope", "in_progress"],
      ["number", "payment_unresolved"],
      ["esimEurope", "unfulfilled"],
      ["number", "delivered_unpaid"],
      ["vpn", "rejected"],
      ["esimEurope", "declined"],
      ["number", "expired"],
      ["esimEurope", "fulfillment_closed"],
      ["esimWeek", "delivered"],
      ["vpn", "shipped"],
      ["number", "cancelled"],
    ]),
  ),
  {
    ...orders(
      {
        id: "dashboard-orders-opened-row",
        screen: "Orders",
        when: "A merchant on a phone taps the first order's line to read what the narrow row leaves out.",
        cause:
          "A phone's row shows the product, the amount, the state and the time; the whole order ID, both shares and the moment the price was set are in the row's opened part.",
      },
      OWING,
      "/orders",
      { owed: OWED_BECAUSE },
    ),
    scene: {
      steps: [
        {
          shows: "Order details",
          does: (page) => page.querySelector("details.cell-more")?.setAttribute("open", ""),
        },
      ],
      shows: "Order details",
    },
  },
  orders(
    {
      id: "dashboard-orders-search",
      screen: "Orders",
      when: "A merchant pastes the short order ID they copied from an unfulfilled order.",
      cause:
        "The address carries the search, and the short form finds the one order whose ID begins and ends as it does, in its unfulfilled row and in the list.",
    },
    OWING,
    `/orders?q=${encodeURIComponent(shortened(OWING.orders[0]?.id ?? ""))}`,
    { owed: OWED_BECAUSE },
  ),
  orders(
    {
      id: "dashboard-orders-search-no-match",
      screen: "Orders",
      when: "A merchant searches their orders for a product none of them is for.",
      cause:
        "No order's ID, product or product code holds the search, so the list says what was searched for and offers to clear it, which is not what a merchant without orders reads.",
    },
    OWING,
    "/orders?q=router",
    { owed: OWED_BECAUSE },
  ),
  orders(
    {
      id: "dashboard-orders-open",
      screen: "Orders",
      when: "A merchant picks Open to see what is still open for fulfillment or payment.",
      cause:
        "The gateway's open list holds the two unfulfilled orders and the goods held for payment, and the list shows those three alone.",
    },
    OWING,
    "/orders?show=open",
    { owed: OWED_BECAUSE },
  ),
  orders(
    {
      id: "dashboard-orders-open-none",
      screen: "Orders",
      when: "A merchant picks Open while every order is finished.",
      cause:
        "The gateway's open list holds no order, so the list says nothing is open and leads back to all of them.",
    },
    ordersOf([
      ["vpn", "delivered"],
      ["number", "delivered"],
    ]),
    "/orders?show=open",
  ),
  orders(
    {
      id: "dashboard-orders-cut-short",
      screen: "Orders",
      when: "A merchant with a season of sales opens Orders.",
      cause:
        "The gateway lists 214 orders and a page draws fifty, the newest first, so the list says which fifty of how many and leads to the next page.",
    },
    SEASON,
  ),
  orders(
    {
      id: "dashboard-orders-sales-paused",
      screen: "Orders",
      when: "A merchant who pressed Pause all sales on Cards opens Orders.",
      cause:
        "The orders read the merchant's selling state, so the banner says all sales are paused and leads back to Cards to resume them.",
    },
    ordersOf([
      ["vpn", "delivered"],
      ["esimEurope", "in_progress"],
    ]),
    "/orders",
    { cards: cardsOf("paused", ON_SALE) },
  ),
  orders(
    {
      id: "dashboard-orders-none",
      screen: "Orders",
      when: "A merchant opens Orders before anything has been bought.",
      cause: "The gateway lists no orders, so there is nothing to search or narrow.",
    },
    ordersOf([]),
  ),
  orders(
    {
      id: "dashboard-orders-test",
      screen: "Orders",
      when: "A merchant on the test site looks at the orders their trial purchases made.",
      cause:
        "Every order on the test site is a test purchase, one of them unfulfilled, and each sum carries the test mark.",
    },
    ordersOf(
      [
        ["vpn", "delivered"],
        ["esimEurope", "unfulfilled"],
        ["esimEurope", "delivered"],
      ],
      true,
    ),
    "/orders",
    { mode: "test" },
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
      cause:
        "The gateway lists receipts with transactions reported by the facilitator or verified from chain evidence.",
    },
    ((listed) =>
      receiptsView(
        seenBy("live"),
        CATALOGUE,
        listed,
        TRANSACTIONS.live,
        paidIntoSplit(
          "live",
          listed.receipts.map((receipt) => ({ id: receipt.order_id, status: receipt.outcome })),
        ),
      ))(
      receiptsOf([
        ["vpn", "delivered"],
        ["esimEurope", "delivered"],
        ["number", "delivered"],
      ]),
    ),
    "live",
  ),
  receipts(
    {
      id: "dashboard-receipts-many",
      screen: "Receipts",
      when: "A reviewer checks every paid outcome the receipt contract admits.",
      cause:
        "The contract admits receipts with historical unfulfilled or closed outcomes; the gateway currently issues only delivered or shipped receipts. One row has no recorded transaction.",
    },
    receiptsView(
      seenBy("live"),
      CATALOGUE,
      receiptsOf([
        ["vpn", "delivered"],
        ["esimEurope", "in_progress"],
        ["esimEurope", "unfulfilled"],
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

/**
 * The banner over a WooCommerce screen: the shop's when the merchant sells
 * through it, and all sales paused where the example says so.
 */
/** What the merchant's layout reads beside a WooCommerce example, where it is not as usual. */
interface ShopAccount {
  readonly selling?: AccountRead["selling"];
  /** No payout wallet set, which the example's own read says. */
  readonly noWallet?: true;
}

const shopBanner = (
  view: ReturnType<typeof wooShopView> | ReturnType<typeof wooImportView>,
  { selling = "open", noWallet }: ShopAccount,
) =>
  bannerOf(seenBy("test", noWallet ? { payout: { wallet: null } } : {}), {
    through: view.screen === "shop" && view.connectSwitches ? "api" : "woocommerce",
    selling,
  });

const shop = (
  told: Told,
  view: ReturnType<typeof wooShopView>,
  { path = "/woocommerce", ...account }: ShopAccount & { readonly path?: string } = {},
) =>
  at(told, {
    path,
    mode: "test",
    account: shopBanner(view, account),
    loaded: { "routes/woocommerce": view },
  });

/** The answer to a press on the shop screen, drawn at the press's own address. */
const shopPress = (
  told: Told,
  press: "connect" | "import" | "switch" | "disconnect",
  view: ReturnType<typeof wooShopView> | ReturnType<typeof wooImportView>,
  account: ShopAccount = {},
) =>
  at(told, {
    path: `/woocommerce/${press}`,
    mode: "test",
    account: shopBanner(view, account),
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
    { path: "/woocommerce?from=shop" },
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
    shopOn(shopRead(CONNECTED)),
    { noWallet: true },
  ),
  shop(
    {
      id: "dashboard-woocommerce-selling-paused",
      screen: "WooCommerce",
      when: "A merchant with a connected shop has paused all sales.",
      cause: "The merchant's selling is stopped, so nothing imported sells until it starts again.",
    },
    shopOn(shopRead(CONNECTED)),
    { selling: "paused" },
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
      when: "A merchant presses Import products.",
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
    shopOn(shopRead(CONNECTED), { refused: ["no_payout_wallet"] }),
    { noWallet: true },
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
      when: "A merchant presses Disconnect shop while orders the shop took are open.",
      cause: "The gateway refuses the switch back to the merchant's code until those orders end.",
    },
    "disconnect",
    shopOn(shopRead(CONNECTED), {
      leaving: TO_THE_CODE,
    }),
  ),
  shopPress(
    {
      id: "dashboard-woocommerce-disconnect-refused-many",
      screen: "WooCommerce",
      when: "A merchant presses Disconnect shop while seven orders the shop took are open.",
      cause:
        "The gateway refuses the switch back; the screen names the first five orders and counts the rest.",
    },
    "disconnect",
    shopOn(shopRead(CONNECTED), {
      leaving: refusalIn(
        switchRefused(
          "api",
          Array.from({ length: 7 }, (_, at) => idOf("ord", `waiting ${at}`)),
        ),
      ),
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

const RECOVERY_SALE = {
  orderId: idOf("ord", "Coffee & Brunch Gift Card recovery"),
  product: imported("Coffee & Brunch Gift Card").card.merchant_item_id,
  shopOrigin: SHOP,
  amount: "25.00 USD",
  test: true,
};

const RECOVERY_FRAME = {
  path: `/integrations/woocommerce/recover/${RECOVERY_SALE.orderId}`,
  mode: "test" as const,
  account: bannerOf(seenBy("test"), { through: "woocommerce", selling: "open" }),
};

const WOO_RECOVERY: GalleryState[] = [
  at(
    {
      id: "dashboard-woo-recovery-link",
      screen: "Recover WooCommerce delivery",
      when: "A merchant opens recovery for their download whose shop order creation was not confirmed.",
      cause:
        "The saved sale has no linked shop order; the merchant can name the exact existing order for the connector to verify before delivering its download.",
    },
    {
      ...RECOVERY_FRAME,
      loaded: {
        "routes/woocommerce-recovery": {
          ...RECOVERY_SALE,
          mode: "link",
          wooOrderId: "",
          message: null,
        } satisfies WooRecoveryView,
      },
    },
  ),
  at(
    {
      id: "dashboard-woo-recovery-retry",
      screen: "Recover WooCommerce delivery",
      when: "A merchant linked the matching shop order, but Agentify did not confirm the delivery.",
      cause:
        "The shop order and its download were saved before the delivery answer was lost; their ID stays visible and the next press retries the same delivery.",
    },
    {
      ...RECOVERY_FRAME,
      loaded: { "routes/woocommerce-recovery": null },
      pressed: {
        "routes/woocommerce-recovery": {
          ...RECOVERY_SALE,
          mode: "retry",
          wooOrderId: "13",
          message: "Agentify did not confirm the late delivery.",
        } satisfies WooRecoveryView,
      },
    },
  ),
  at(
    {
      id: "dashboard-woo-recovery-delivered",
      screen: "Recover WooCommerce delivery",
      when: "A merchant reloads recovery after their download was delivered.",
      cause:
        "The saved shop order and Agentify's fresh delivered readback agree; the page confirms delivery and offers no further recovery press.",
    },
    {
      ...RECOVERY_FRAME,
      loaded: {
        "routes/woocommerce-recovery": {
          ...RECOVERY_SALE,
          mode: "delivered",
          wooOrderId: "13",
          message: "Agentify confirms that this download was delivered.",
        } satisfies WooRecoveryView,
      },
    },
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
  {
    mode = "live",
    path = "/settings",
    account = [],
  }: { mode?: SurfaceMode; path?: string; account?: readonly AccountNote[] } = {},
) =>
  at(told, {
    path,
    mode,
    account,
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
      payoutSplits: splitsOf("test", null),
      addressPage: ADDRESSES.test,
      walletChain: WALLET_CHAINS.test,
    }),
    {
      mode: "test",
      account: bannerOf(seenBy("test", { sellerName: null, payout: { wallet: null } })),
    },
  ),
  settings(
    {
      id: "dashboard-settings-not-approved",
      screen: "Settings",
      when: "A merchant on the live site has not been approved for live sales yet.",
      cause: "The operator's approval is missing, so every card is refused on live.",
    },
    settingsView("live", WHO, { ...settingsOf(), liveApproval: false }),
    { account: bannerOf(seenBy("live", { liveApproval: false })) },
  ),
  settings(
    {
      id: "dashboard-settings-wallet-change-waiting",
      screen: "Settings",
      when: "A merchant on the live site has asked for a different payout wallet.",
      cause:
        "A change of the wallet waits forty-eight hours after every account is told, and can be cancelled meanwhile.",
    },
    settingsView("live", WHO, {
      ...settingsOf({
        payoutWallet: WAITING,
        payoutSplits: splitsOf("live", PAID_INTO, { pending: ASKED_FOR }),
      }),
      liveApproval: true,
    }),
  ),
  settings(
    {
      id: "dashboard-settings-test-payout",
      screen: "Settings",
      when: "A merchant on the test site opens Settings after saving their payout wallet.",
      cause:
        "Buyers pay into the merchant's payout contract on Base Sepolia, and the payout is sent with test ETH.",
    },
    settingsView("test", WHO, settingsOf({}, "test")),
    { mode: "test" },
  ),
  settings(
    {
      id: "dashboard-settings-sandbox-wallet",
      screen: "Settings",
      when: "A merchant on a laptop's sandbox opens Settings after saving a payout wallet.",
      cause:
        "The payout contract is computed and recorded, and never deployed, so there is no payout to send.",
    },
    settingsView("sandbox", WHO, settingsOf({}, "sandbox")),
    { mode: "sandbox" },
  ),
  settings(
    {
      id: "dashboard-settings-payout-earlier-contract",
      screen: "Settings",
      when: "A merchant opens Settings after their new payout wallet took effect.",
      cause:
        "Payments were made into the earlier wallet's contract, so the payout pays out both, each to its own wallet.",
    },
    settingsView("live", WHO, {
      ...settingsOf({
        payoutWallet: PayoutWalletSchema.parse({ payout_wallet: ASKED_FOR, pending: null }),
        payoutSplits: splitsOf("live", ASKED_FOR, {
          toPayOut: [splitOf("live", PAID_INTO), splitOf("live", ASKED_FOR)],
        }),
      }),
      liveApproval: true,
    }),
  ),
  settings(
    {
      id: "dashboard-settings-payout-too-many",
      screen: "Settings",
      when: "A merchant whose wallet changed many times opens Settings.",
      cause:
        "More payout contracts can hold the merchant's money than one transaction pays out, so they wait for Agentify's own payout, on no set date.",
    },
    settingsView("live", WHO, {
      ...settingsOf({
        payoutSplits: { ...splitsOf("live", PAID_INTO), payout: { tooMany: 23 } },
      }),
      liveApproval: true,
    }),
  ),
  settings(
    {
      id: "dashboard-settings-payout-unbuilt",
      screen: "Settings",
      when: "A merchant opens Settings while a payout contract of theirs is one no payout is built over.",
      cause:
        "The builder refuses a split as recorded, such as one paying its share to Multicall3, so no transaction is drawn; the rest of Settings is.",
    },
    settingsView("live", WHO, {
      ...settingsOf({
        payoutSplits: { ...splitsOf("live", PAID_INTO), payout: "unbuilt" },
      }),
      liveApproval: true,
    }),
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
      settingsOf(
        {
          payoutWallet: PayoutWalletSchema.parse({ payout_wallet: null, pending: null }),
          payoutSplits: splitsOf("test", null),
        },
        "test",
      ),
      { kind: "wallet", problem: WALLET_NEEDED, typed: "" },
    ),
    { mode: "test", path: "/settings/payout-wallet" },
  ),
  ((typed) =>
    settings(
      {
        id: "dashboard-settings-wallet-not-a-wallet",
        screen: "Settings",
        when: "A merchant pastes Multicall3, the address the payout is sent to, as their payout wallet.",
        cause:
          "A share paid to a contract a payout calls could never come back, so the gateway refuses it and nothing is saved.",
      },
      settingsView(
        "live",
        WHO,
        { ...settingsOf(), liveApproval: true },
        { kind: "wallet", problem: NOT_A_PAYOUT_WALLET.multicall3, typed },
      ),
      { path: "/settings/payout-wallet" },
    ))(networkIn("live").multicall3),
  settings(
    {
      id: "dashboard-settings-wallet-cancelled-by-typing",
      screen: "Settings",
      when: "A merchant types the wallet paid out to now while a change of it waits.",
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
          payoutSplits: splitsOf("live", ASKED_FOR),
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

const LIVE_SALES: GalleryState[] = [
  at(
    {
      id: "dashboard-admin-live-sales",
      screen: "Live sales approval",
      when: "An administrator opens the live sales screen from Admin.",
      cause: "Their current session has the administrative flag; no seller has been selected.",
    },
    {
      path: "/admin/live-sales",
      mode: "live",
      loaded: {
        "routes/admin-live-sales": {
          live: true,
          email: "",
          merchant: null,
          message: null,
        } satisfies LiveSalesView,
      },
    },
  ),
  at(
    {
      id: "dashboard-admin-live-sales-confirm",
      screen: "Live sales approval",
      when: "An administrator has found the merchant to approve.",
      cause:
        "One account matches the email and names this existing merchant, which has not been admitted to live sales.",
    },
    {
      path: "/admin/live-sales",
      mode: "live",
      loaded: {
        "routes/admin-live-sales": {
          live: true,
          email: WHO,
          message: null,
          merchant: {
            email: WHO,
            id: MERCHANT,
            name: "Freeland",
            site: "https://freeland.example",
            integration: "api",
            approvedAt: null,
          },
        } satisfies LiveSalesView,
      },
    },
  ),
];

export const gallery: GallerySurface = {
  id: "dashboard",
  name: "Seller dashboard",
  lang: "en",
  states: [
    ...LIVE_SALES,
    ...SIGNING_IN,
    ...SETTING_UP,
    ...CARDS,
    ...ORDERS,
    ...RECEIPTS,
    ...INTEGRATIONS,
    ...WOOCOMMERCE,
    ...WOO_RECOVERY,
    ...KEYS,
    ...SETTINGS,
    ...PROBLEMS,
  ],
};
