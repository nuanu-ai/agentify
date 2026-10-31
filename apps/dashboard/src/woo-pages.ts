import { shopJobView } from "./shop-job-view.js";
import { jobIsCurrent } from "./shop-jobs.js";

/**
 * The server half of the WooCommerce connector's screens: what their loaders
 * and actions call, answering with an `Outcome` as every page's server half
 * does. The shop's key and secret are read here to read its catalogue, and go
 * into no view and no log line. The shop's callback is not here: it is no
 * page, but a post from the shop's server that `server.ts` answers with a
 * status.
 */

import { readinessOf, UNKNOWN } from "@agentify/core";
import { publishRefusalReason } from "@agentify/gateway";
import type { SetupResult } from "@agentify/gateway/analytics";
import type { LiveSalesEvidence } from "@agentify/gateway/live-sales";
import { keepUnits, withUnit } from "@agentify/ui/units";
import { MERCHANT_FINDINGS, type Problem } from "@nuanu-ai/agentify-contracts";
import type { DashboardConfig } from "./config.js";
import type { DashboardIdentity, Person } from "./dashboard-entry.js";
import type { Acting, Answer, GatewayClient } from "./gateway.js";
import { type Postman, postmanFor } from "./mail.js";
import { noted } from "./noted.js";
import { type Outcome, problemOf } from "./page-services.js";
import { unsetIn } from "./viewer.js";
import type { ConnectorSale } from "./views.js";
import {
  APP_NAME,
  authorizeUrlFor,
  EXAMPLE_PAGE,
  GRANT_MINUTES,
  isTheGrantScreen,
  noReferenceFor,
  type Preflight,
  type PricedExample,
  type PublicShopRead,
  pricedExampleOfTheShop,
  publicShopOf,
  referenceUnanswered,
  shopUrlAs,
  theStateToken,
  whatIsWrongWithTheShopUrl,
  wordpressNameOf,
  writesOtherDecimals,
} from "./woo-connect.js";
import { dollarsAt, gapOf, rateWrittenAs, shopDecimalsOf } from "./woo-money.js";
import { rateNoticeMessage } from "./woo-rate-mail.js";
import { type WooRecoveryView, wooRecoveryPagesFor } from "./woo-recovery-pages.js";
import { type ReferenceRead, referenceRateOf } from "./woo-reference.js";
import {
  inspectProductInTheShop,
  type OrderMade,
  PRODUCTS_AT_MOST,
  type ProductInspection,
  type ShopKeys,
  type SoldItem,
  type WooOrderLookup,
} from "./woo-shop.js";
import type { ShopCurrency, ShopTotal, WooConnection, WooShops } from "./woo-shops.js";
import {
  groupedRate,
  type Held,
  heldBy,
  NOT_APPROVED_YET,
  referenceShown,
  type Said,
  type ShopAnswer,
  type ShopRead,
  type ShopState,
  settingsNamed,
  type WooShopView,
  wooShopView,
} from "./woo-views.js";
import { NO_SHOP, shopNameOf } from "./woo-words.js";
import { SITE_IN_SETTINGS, type Unset } from "./words.js";

/**
 * The calls that reach a merchant's shop. Only tests pass others: both real
 * calls reach a shop over https, and a loopback shop would be refused before
 * either ran, so the calls are handed in rather than the shop stood up.
 */
export interface ShopCalls {
  readonly sellerName?: (shopUrl: string) => Promise<string | null>;
  readonly grantScreen: (authorizeUrl: string) => Promise<Preflight>;
  /** Null where the shop did not clearly say. */
  readonly preview: (shopUrl: string) => Promise<PublicShopRead>;
  /** The rate guard's example, in the shop's currency at its decimals. */
  readonly example?: (shopUrl: string, currency: ShopCurrency) => Promise<PricedExample>;
  /** Coinbase's rate for one US dollar; not the shop's, but read only beside it. */
  readonly reference?: (currency: string) => Promise<ReferenceRead>;
  readonly inspectProduct: (keys: ShopKeys, merchantItemId: string) => Promise<ProductInspection>;
  readonly readOrder?: (keys: ShopKeys, orderId: string) => Promise<WooOrderLookup>;
  /** The shop's own creation where a deployment passes nothing. */
  readonly placeOrder?: (keys: ShopKeys, sold: SoldItem) => Promise<OrderMade>;
}

export interface WooPages {
  recovery(person: Person, orderId: string): Promise<Outcome<WooRecoveryView>>;
  recover(person: Person, orderId: string, form: FormData): Promise<Outcome<WooRecoveryView>>;
  /** What the shop's orders for these sales total, where the connector placed them. */
  shopTotals(
    person: Person,
    orderIds: readonly string[],
  ): Promise<Readonly<Record<string, ShopTotal>>>;
  /** Which of these sales the shop connector holds, and how a late delivery can still reach each. */
  connectorSales(
    person: Person,
    orderIds: readonly string[],
  ): Promise<Readonly<Record<string, ConnectorSale>>>;
  /** The shop screen, with what its address carried. */
  shop(person: Person, query: URLSearchParams): Promise<Outcome<WooShopView>>;
  useShopSite(person: Person): Promise<Outcome<WooShopView>>;
  connect(person: Person, form: FormData): Promise<Outcome<WooShopView>>;
  checkCatalogue(person: Person): Promise<Outcome<WooShopView>>;
  importCatalogue(person: Person, checkedJob: string | null): Promise<Outcome<WooShopView>>;
  /**
   * Saves the rate of a shop in another currency, and imports the shop again at
   * it. `cookie` names the session saving it, which its notice tells apart.
   */
  setRate(
    person: Person,
    form: FormData,
    cookie: string | undefined,
  ): Promise<Outcome<WooShopView>>;
  switchToShop(person: Person): Promise<Outcome<WooShopView>>;
  /**
   * Refused, with the page drawn as it stands, where the form names another
   * shop than the one connected now, or none where one is.
   */
  disconnect(person: Person, form: FormData): Promise<Outcome<WooShopView>>;
  /**
   * Where the shop sends the browser back to, in front of the gate. It reads
   * the session and nothing else, and answers anybody without one alike.
   */
  cameBack(cookie: string | undefined, query: URLSearchParams): Promise<Outcome<null>>;
  /** The account's connection as the shop screen reads it, for any screen that says it. */
  stateOf(accountId: string): Promise<ShopState>;
  onboardingFacts(
    person: Person,
  ): Promise<Readonly<{ evidence: LiveSalesEvidence | null; connectedBefore: boolean }>>;
  sellerName(person: Person): Promise<string | null>;
}

export interface WooParts {
  readonly identity: DashboardIdentity;
  /** The gateway's application called as the merchant on the signed-in account's row. */
  readonly clientFor: (acting: Acting) => GatewayClient;
  readonly shops: WooShops;
  readonly shop?: ShopCalls;
  /** The dashboard's own mail by default; tests pass another. */
  readonly postman?: Postman;
}

/**
 * One function for every screen that says what became of a Connect, so no two
 * decide a state differently, and the only place the clock is held against a
 * Connect. A connection wins over a pending Connect for a second shop: the
 * merchant stays connected until new keys arrive.
 */
const shopStateOf = async (shops: WooShops, accountId: string): Promise<ShopState> => {
  const connection = await shops.connectionOf(accountId);
  if (connection !== null) {
    return {
      kind: "connected",
      // The fields a screen may know, never the row: the key and secret are a
      // stranger's credential at rest, and screens that cannot reach them
      // cannot draw them.
      shop: {
        shopUrl: connection.shopUrl,
        permissions: connection.permissions,
        connectedAt: connection.connectedAt,
      },
    };
  }
  const waiting = await shops.grantFor(accountId);
  if (waiting === null) {
    return { kind: "none" };
  }
  const now = Date.now();
  if (waiting.expiresAt.getTime() <= now) {
    return { kind: "unanswered", shopUrl: waiting.shopUrl };
  }
  return {
    kind: "waiting",
    shopUrl: waiting.shopUrl,
    // Rounded down, so forty seconds reads "less than a minute": a number a
    // merchant can watch climb is worth more than one right on average.
    startedMinutesAgo: Math.floor((now - waiting.startedAt.getTime()) / 60_000),
  };
};

/**
 * A value named once, as a form or an address names it; named twice it is
 * nobody's choice, and is read as not named at all.
 */
const once = (values: readonly unknown[]): unknown => (values.length === 1 ? values[0] : undefined);

/** How many products one import run published, was refused or failed, and passed over. */
interface ImportCounts {
  readonly imported_count: number;
  readonly failed_count: number;
  readonly skipped_count: number;
}

const NOTHING_COUNTED: ImportCounts = { imported_count: 0, failed_count: 0, skipped_count: 0 };

type ReasonCode = ReturnType<typeof publishRefusalReason>;

/** Refusals before a durable publication starts; the job records its terminal result. */
const importResult = (
  person: Person,
  settled:
    | { readonly outcome: "completed" | "partial" }
    | { readonly outcome: "blocked" | "failed" | "unknown"; readonly reason_code: ReasonCode },
  counts: ImportCounts = NOTHING_COUNTED,
): SetupResult =>
  ({
    name: "agc_setup_result",
    actor: "human",
    source: "dashboard",
    refs:
      person.merchant === null
        ? { person: person.id }
        : { merchant: person.merchant.id, person: person.id },
    fields: { step: "woo_import", integration: "woocommerce", ...settled, ...counts },
  }) as SetupResult;

const originOf = (connection: WooConnection): string => new URL(connection.shopUrl).origin;

/**
 * The rate a merchant who wrote thousands apart, or a decimal comma, most
 * likely meant, named in the refusal for them to type; nothing is saved from
 * it. A comma before three digits is read as thousands, the way rates in the
 * thousands are written, and a rate guessed wrong is caught beside Coinbase's.
 */
const rateMeant = (typed: string): string | null => {
  if (/^\d{1,3}(?:[, ]\d{3})+(?:\.\d+)?$/.test(typed)) return typed.replace(/[, ]/g, "");
  if (/^\d+,\d+$/.test(typed)) return typed.replace(",", ".");
  return null;
};

/** WooCommerce's names for the fields a refused product's findings point at. */
const FIELD_NAMES: Readonly<Record<string, string>> = Object.freeze({
  title: "Product name",
  description: "Description",
});

/**
 * A refused card's findings as the import result lists them: the gateway's
 * words, each under the name the shop gives the field, telling the merchant
 * what to change in their shop. The shop's site is the exception, set in
 * Settings by the person here rather than through the API.
 */
export const findingsOf = (
  problems: readonly Problem[],
): { readonly problems: readonly string[]; readonly tooLong?: true } => ({
  problems: problems.map((problem) =>
    problem.code === MERCHANT_FINDINGS.NO_SELLER_SITE
      ? SITE_IN_SETTINGS
      : problem.path.length === 0
        ? problem.message
        : `${FIELD_NAMES[problem.path.join(".")] ?? problem.path.join(".")}: ${problem.message}`,
  ),
  ...(problems.some((problem) => problem.code === "too_big") ? { tooLong: true } : {}),
});

/**
 * Why a rate far from Coinbase's is asked for again: how far, and what one of
 * the shop's products would then sell for. A dot is the likeliest slip, a dot
 * written between thousands, so it is named where one was typed.
 */
export const rateFarSays = (far: {
  readonly rate: string;
  readonly typed: string;
  readonly currency: string;
  readonly gap: string;
  readonly reference: string;
  readonly example: PricedExample;
}): string => {
  const { rate, currency, example } = far;
  const costs =
    example.kind === "priced"
      ? `${keepUnits(example.name)} (${withUnit(groupedRate(example.price), currency)}) would sell for` +
        ` ${withUnit(dollarsAt(example.price, rate) ?? "?", "USD")} instead of` +
        ` ${withUnit(dollarsAt(example.price, far.reference) ?? "?", "USD")}.`
      : example.kind === "none"
        ? `None of the first ${EXAMPLE_PAGE} products in your shop's public catalogue has a` +
          ` price in ${currency}, so no example is shown.`
        : "Your shop's public catalogue didn't answer, so no example is shown.";
  return (
    `${withUnit(groupedRate(rate), currency)} is ${far.gap} Coinbase's ${referenceShown(far.reference)}.` +
    ` ${costs} If that's right, type the rate again.` +
    (far.typed.includes(".") ? " If the dot separates thousands, leave it out." : "")
  );
};

export function wooPagesFor(config: DashboardConfig, parts: WooParts): WooPages {
  const base = config.basePath;
  const { identity, shops } = parts;
  /** Where a shop sends the merchant back to, and posts the keys to. */
  const whereWeAre = `${config.publicBaseUrl}${base}`;
  const grantScreen = parts.shop?.grantScreen ?? isTheGrantScreen;
  const preview = parts.shop?.preview ?? publicShopOf;
  const example =
    parts.shop?.example ??
    ((shopUrl: string, currency: ShopCurrency) => pricedExampleOfTheShop(shopUrl, currency));
  const reference = parts.shop?.reference ?? ((code: string) => referenceRateOf(code));
  const postman = parts.postman ?? postmanFor(config);
  const inspectProduct = parts.shop?.inspectProduct ?? inspectProductInTheShop;
  const recovery = wooRecoveryPagesFor({
    shops,
    gatewayFor: parts.clientFor,
    inspectProduct,
    ...(parts.shop?.readOrder === undefined ? {} : { readOrder: parts.shop.readOrder }),
    ...(parts.shop?.placeOrder === undefined ? {} : { placeOrder: parts.shop.placeOrder }),
    now: () => new Date(),
  });

  /**
   * Only called behind the gate that sends an account with no merchant to the
   * control that makes one, so a missing merchant here is a defect, not a case.
   */
  const gatewayAs = (person: Person): GatewayClient => {
    if (person.merchant === null) {
      throw new Error(
        "a WooCommerce screen ran for an account with no merchant, which means the merchant" +
          " gate let one through — this is a defect in how the routes are nested",
      );
    }
    return parts.clientFor({ merchantId: person.merchant.id, email: person.email });
  };

  /**
   * The rule is the gateway's own (`readinessOf` in the core). This dashboard
   * has its gateway's chain and facilitator, so its surface mode is the
   * gateway's. The operator's approval goes in as unknown, since nobody sets it
   * in Settings and `unsetIn` leaves it out: on live the import asks it on its
   * own, and the banner over the page says it is missing.
   */
  const unsetOf = async (
    gateway: GatewayClient,
  ): Promise<Answer<{ settings: readonly Unset[]; site: string | null }>> => {
    const [seller, wallet] = await Promise.all([gateway.seller(), gateway.payoutWallet()]);
    if (!seller.ok) {
      return seller;
    }
    if (!wallet.ok) {
      return wallet;
    }
    const door = readinessOf(
      {
        sellerName: seller.document.name,
        payoutWallet: wallet.document.payout_wallet,
        liveApproval: UNKNOWN,
      },
      config.surfaceMode,
    );
    return { ok: true, document: { settings: unsetIn(door), site: seller.document.site } };
  };

  /**
   * In one place because the screen is reached five ways (opened, and redrawn
   * after any of the four presses is refused), and a forgotten answer in one of
   * them would look like a merchant who has set nothing. The integration
   * failing to read fails the page: drawn without it, the page would offer or
   * hide the switch on a guess. Unread settings also fail the page: an unread
   * site must not look empty. Products that could not be counted have no number.
   */
  const readTheShop = async (person: Person): Promise<Outcome<ShopRead>> => {
    const gateway = gatewayAs(person);
    const [state, integration, rate, unset] = await Promise.all([
      shopStateOf(shops, person.id),
      gateway.integration(),
      rateOf(person),
      unsetOf(gateway),
    ]);
    if (!integration.ok) return problemOf(integration);
    if (!unset.ok) return problemOf(unset);
    const { through, offSale } = integration.document;
    return {
      kind: "view",
      view: {
        state,
        through,
        codeProducts:
          through === "woocommerce" ? offSale.length : await codeProductsBeside(gateway, offSale),
        unset: unset.document.settings,
        sellerSite: unset.document.site,
        testMoney: config.surfaceMode !== "live",
        ...(rate === null ? {} : { rate }),
      },
    };
  };

  const drawTheShop = async (
    person: Person,
    answer: ShopAnswer = {},
    status = 200,
    query = new URLSearchParams(),
  ): Promise<Outcome<WooShopView>> => {
    const read = await readTheShop(person);
    return read.kind === "view"
      ? {
          kind: "view",
          status,
          view: {
            ...wooShopView(read.view, answer),
            job:
              person.merchant === null ? null : await shopJobView(shops, person.merchant.id, query),
          },
        }
      : read;
  };

  const codeProductsBeside = async (
    gateway: GatewayClient,
    shops: readonly string[],
  ): Promise<number | null> => {
    const cards = await gateway.cards();
    return cards.ok ? cards.document.cards.length - shops.length : null;
  };

  /**
   * A refused move between integrations, worded from the orders that hold it,
   * read once more so a purchase about to lapse is told apart from goods owed.
   */
  const refusedMove = async (
    gateway: GatewayClient,
    to: Held["to"],
    refused: Answer<never> & { ok: false },
  ): Promise<Said> => {
    if (refused.code !== "orders_waiting" || refused.orders === undefined) return refused;
    const open = await gateway.orders(true);
    return { held: heldBy(to, refused.orders, open.ok ? open.document.orders : null) };
  };

  /**
   * For a connected shop in another currency: the rate it sells at now and
   * Coinbase's beside it, read each time the screen is drawn. Nothing for a
   * shop in US dollars, which no rate is asked of and Coinbase is not read for.
   */
  const rateOf = async (person: Person) => {
    const connection = await shops.connectionOf(person.id);
    const currency = connection?.currency ?? null;
    if (connection === null || currency === null || currency.code === "USD") return null;
    const [current, read] = await Promise.all([
      shops.currentRate(person.id, originOf(connection), currency.code),
      reference(currency.code),
    ]);
    return { currency, current, reference: read };
  };

  /** A publication press names the stored check the merchant saw. */
  const importFor = async (
    person: Person,
    checkedJob: string | null,
  ): Promise<Outcome<WooShopView>> => {
    const resulted = (settled: Parameters<typeof importResult>[1], counts?: ImportCounts) =>
      shops.recordAnalytics(importResult(person, settled, counts), new Date());

    const connection = await shops.connectionOf(person.id);
    if (connection === null) {
      await resulted({ outcome: "blocked", reason_code: "no_connection" });
      return { kind: "redirect", location: `${base}/woocommerce` };
    }

    // Asked before the shop is read, like the settings below: a merchant
    // selling through their code would have every imported card refused, so
    // the shop screen offers them the switch instead.
    const integration = await gatewayAs(person).integration();
    if (!integration.ok) {
      await resulted({ outcome: "failed", reason_code: "internal_error" });
      return problemOf(integration);
    }
    if (integration.document.through !== "woocommerce") {
      await resulted({ outcome: "blocked", reason_code: "integration_mismatch" });
      return await drawTheShop(
        person,
        {
          switching:
            "Nothing was imported: you sell through your own code. Switch to this shop first.",
        },
        409,
      );
    }

    // Asked before the shop: the gateway refuses every card of a merchant
    // missing any of these, so importing would inspect every product for
    // nothing and repeat the refusal per product in words naming an API
    // route. A gateway that cannot answer this would not take a card either.
    const unset = await unsetOf(gatewayAs(person));
    if (!unset.ok) {
      await resulted({ outcome: "failed", reason_code: "internal_error" });
      return problemOf(unset);
    }
    if (unset.document.site === null) {
      await resulted({ outcome: "blocked", reason_code: "seller_site_missing" });
      return await drawTheShop(
        person,
        { importing: "Nothing was imported: set your shop's site before importing." },
        409,
      );
    }
    if (unset.document.settings.length > 0) {
      // Counted as the gateway counts a card refused for the same lack.
      await resulted({
        outcome: "blocked",
        reason_code: publishRefusalReason(unset.document.settings),
      });
      noted(
        person,
        `pressed Import while the publish door would refuse every card with ${unset.document.settings.join(" and ")}, so the shop at` +
          ` ${connection.shopUrl} was not read and nothing was published`,
      );
      // The screen holds Import for what is unset; a press that got here was
      // drawn before it was, so the answer says what the press did.
      return await drawTheShop(
        person,
        {
          importing: `Nothing was imported: set your ${settingsNamed(unset.document.settings)} in Settings first.`,
        },
        409,
      );
    }

    // On live the operator's approval is asked before the shop too: without it
    // the gateway refuses every card in the same sentence, which names nothing
    // in the shop to change, and the merchant has only to import again later.
    if (config.surfaceMode === "live") {
      const approval = await gatewayAs(person).liveApproval();
      if (!approval.ok) {
        await resulted({ outcome: "failed", reason_code: "internal_error" });
        return problemOf(approval);
      }
      if (!approval.document) {
        await resulted({
          outcome: "blocked",
          reason_code: publishRefusalReason([MERCHANT_FINDINGS.NO_OPERATOR_APPROVAL]),
        });
        noted(
          person,
          `pressed Import before the operator approved the merchant for live sales, so the shop at` +
            ` ${connection.shopUrl} was not read and nothing was published`,
        );
        return await drawTheShop(person, { importing: NOT_APPROVED_YET }, 409);
      }
    }

    if (person.merchant === null) throw new Error("merchant required");
    const snapshots = await shops.jobs.snapshots(person.merchant.id);
    if (
      snapshots.some(
        ({ job }) => job.kind === "check" && (job.status === "queued" || job.status === "running"),
      )
    )
      return drawTheShop(
        person,
        { importing: "A check is still running. Publish when it finishes." },
        409,
      );
    const activePublication = snapshots.find(
      ({ job }) => job.kind === "publish" && (job.status === "queued" || job.status === "running"),
    )?.job;
    if (activePublication && (await jobIsCurrent(shops, activePublication)))
      return drawTheShop(person);
    const bound = snapshots.find(({ job }) => job.id === checkedJob)?.job;
    if (
      !bound ||
      bound.currency === null ||
      (bound.currency.code !== "USD" && bound.rate === null) ||
      bound.status === "queued" ||
      bound.status === "running" ||
      bound.stopCode === "rate_required" ||
      bound.stopCode === "reconnect" ||
      !(await jobIsCurrent(shops, bound))
    )
      return drawTheShop(
        person,
        {
          importing:
            "Check your products again before publishing. The shop or exchange rate may have changed.",
        },
        409,
      );
    const requested = await shops.jobs.request({
      merchantId: person.merchant.id,
      accountId: person.id,
      connectionRevision: connection.revision,
      shopUrl: connection.shopUrl,
      kind: "publish",
      currency: bound.currency,
      rate: bound.rate,
    });
    return await drawTheShop(
      person,
      requested.accepted
        ? {}
        : { importing: "A check is still running. Publish when it finishes." },
      requested.accepted ? 200 : 409,
    );
  };

  return {
    async checkCatalogue(person) {
      const connection = await shops.connectionOf(person.id);
      if (connection && person.merchant && connection.permissions === "read_write")
        await shops.jobs.request({
          merchantId: person.merchant.id,
          accountId: person.id,
          connectionRevision: connection.revision,
          shopUrl: connection.shopUrl,
          kind: "check",
        });
      return await drawTheShop(person);
    },
    recovery: recovery.page,
    recover: recovery.recover,
    async shopTotals(person, orderIds) {
      if (person.merchant === null) return {};
      return await shops.shopTotals(person.id, orderIds);
    },
    async connectorSales(person, orderIds) {
      if (person.merchant === null) return {};
      const held = await shops.heldSales(person.id, orderIds);
      return Object.fromEntries(
        Object.entries(held).map(([id, sale]): [string, ConnectorSale] => [
          id,
          sale === "parcel" || sale === "unplaced_parcel"
            ? { kind: "parcel", placed: sale === "parcel" }
            : {
                kind: "download",
                recover:
                  sale === "recoverable" || sale === "refused" || sale === "silent"
                    ? `${base}/integrations/woocommerce/recover/${encodeURIComponent(id)}`
                    : null,
              },
        ]),
      );
    },
    stateOf: async (accountId) => await shopStateOf(shops, accountId),
    async sellerName(person) {
      const connection = await shops.connectionOf(person.id);
      return connection === null
        ? null
        : await (parts.shop?.sellerName ?? wordpressNameOf)(connection.shopUrl);
    },
    async onboardingFacts(person) {
      if (person.merchant === null) return { evidence: null, connectedBefore: false };
      const [snapshots, connection] = await Promise.all([
        shops.jobs.snapshots(person.merchant.id),
        shops.connectionOf(person.id),
      ]);
      for (const { job, rows } of snapshots) {
        if (
          job.kind !== "check" ||
          job.status === "queued" ||
          job.status === "running" ||
          !(await jobIsCurrent(shops, job))
        )
          continue;
        const ready = rows.filter((row) => row.group === "ready").length;
        if (connection === null || connection.permissions !== "read_write" || ready === 0) break;
        return {
          connectedBefore: true,
          evidence: {
            integration: "woocommerce",
            host: new URL(connection.shopUrl).host,
            checkedAt: new Date(job.endedAt ?? job.startedAt).getTime(),
            ready,
            read: job.read,
            total: job.total,
            complete: job.status === "completed" && job.total !== null && job.total === job.read,
          },
        };
      }
      return { evidence: null, connectedBefore: snapshots.length > 0 || connection !== null };
    },

    async shop(person, query) {
      // The only page that reads the flag the return address's redirect set,
      // and it is spent by being drawn, so a merchant opening this page
      // tomorrow is not told they just came back. The flag, never the token.
      const typed = once(query.getAll("shop_url"));
      return await drawTheShop(
        person,
        {
          cameBack: once(query.getAll("from")) === "shop",
          ...(typeof typed === "string" ? { typed } : {}),
        },
        200,
        query,
      );
    },

    async useShopSite(person) {
      const connection = await shops.connectionOf(person.id);
      if (connection === null || connection.permissions !== "read_write") {
        return await drawTheShop(
          person,
          { problem: "Connect your shop with read and write access first." },
          409,
        );
      }
      const saved = await gatewayAs(person).fillSellerSite(originOf(connection));
      return await drawTheShop(
        person,
        saved.ok ? { siteSaved: true } : { siteProblem: saved.why },
        saved.ok ? 200 : 503,
      );
    },

    async connect(person, form) {
      const named = once(form.getAll("shop_url"));
      const typed = typeof named === "string" ? named.trim() : "";
      const wrong = whatIsWrongWithTheShopUrl(typed);
      const shopUrl = wrong === null ? shopUrlAs(typed) : typed;
      const connect = once(form.getAll("checked_shop")) === shopUrl;
      const token = theStateToken();
      let authorize = "";
      let cachedRead: ShopRead | null = null;
      const drawChecked = (answer: ShopAnswer, status = 200): Outcome<WooShopView> =>
        cachedRead === null
          ? {
              kind: "problem",
              problem: {
                status: 503,
                said: "Your account could not be checked just now. Press Check my shop again.",
              },
            }
          : { kind: "view", status, view: wooShopView(cachedRead, answer) };
      type Checked =
        | { readonly failed: Outcome<WooShopView> }
        | {
            readonly problem: Said;
            readonly status: number;
            readonly preview?: PublicShopRead;
            readonly address?: boolean;
          }
        | { readonly preview: PublicShopRead; readonly currency: ShopCurrency | null };
      let timedOut = false;
      let timeoutAnswer: Checked = {
        problem: "Your account could not be checked just now. Press Check my shop again.",
        status: 503,
      };
      // All work before this race is read-only. A late answer cannot create a
      // grant after the page has already said it could not read the shop.
      const check = async (): Promise<Checked> => {
        const baseRead = await readTheShop(person);
        if (timedOut) return timeoutAnswer;
        if (baseRead.kind !== "view") return { failed: baseRead };
        cachedRead = baseRead.view;
        if (wrong !== null) return { problem: wrong, status: 400, address: true };
        authorize = authorizeUrlFor(shopUrl, {
          appName: APP_NAME,
          userId: token,
          returnUrl: `${whereWeAre}/woocommerce/return`,
          callbackUrl: `${whereWeAre}/woocommerce/callback`,
        });
        if (!whereWeAre.startsWith("https://"))
          return {
            problem:
              `This Agentify deployment is reachable at ${whereWeAre}, which is not https, and WooCommerce` +
              " will not send a shop's access credentials to an address that is not. Nothing here can connect a" +
              " shop until whoever runs this deployment puts it behind https.",
            status: 400,
          };
        const connected = cachedRead.state.kind === "connected" ? cachedRead.state.shop : null;
        if (connected !== null && new URL(connected.shopUrl).origin !== shopUrl)
          return {
            problem: {
              why: `Disconnect ${shopNameOf(connected.shopUrl)} before connecting another shop.`,
              follow: "integrations",
            },
            status: 409,
          };
        const gateway = gatewayAs(person);
        const allowed = await gateway.maySellThrough("woocommerce");
        if (timedOut) return timeoutAnswer;
        if (!allowed.ok)
          return { problem: await refusedMove(gateway, "woocommerce", allowed), status: 409 };
        timeoutAnswer = { preview: { kind: "unread" }, currency: null };
        const read = await preview(shopUrl);
        if (timedOut) return timeoutAnswer;
        if (read.kind === "refused") return { problem: read.why, status: 400 };
        const total = read.kind === "read" ? read.estimate.total : (read.total ?? null);
        if (total !== null && total > PRODUCTS_AT_MOST)
          return {
            problem: `${shopNameOf(shopUrl)} lists ${total.toLocaleString("en-US")} products. Agentify reads up to 2,000 in one go, so it can't bring this shop over yet.`,
            status: 400,
          };
        const sampled = read.sample ?? null;
        const decimals = sampled === null ? null : shopDecimalsOf(String(sampled.decimals));
        if (sampled !== null && sampled.currency !== "USD") {
          if (decimals === null)
            return {
              problem: writesOtherDecimals(sampled.currency, sampled.decimals),
              status: 400,
            };
          timeoutAnswer = { problem: referenceUnanswered(sampled.currency), status: 503 };
          const listed = await reference(sampled.currency);
          if (timedOut) return timeoutAnswer;
          if (!listed.ok)
            return {
              problem:
                listed.listed === false
                  ? noReferenceFor(sampled.currency)
                  : referenceUnanswered(sampled.currency),
              status: listed.listed === false ? 400 : 503,
            };
        }
        if (connect) {
          timeoutAnswer = {
            problem:
              "Our server could not reach this shop. Check the address and shop status, then try again.",
            status: 503,
            preview: read,
          };
          const looked = await grantScreen(authorize);
          if (timedOut) return timeoutAnswer;
          if (!looked.ok) return { problem: looked.why, status: 400, preview: read };
        }
        return {
          preview: read,
          currency:
            sampled === null || decimals === null ? null : { code: sampled.currency, decimals },
        };
      };
      let late: ReturnType<typeof setTimeout> | undefined;
      let checked: Checked;
      try {
        checked = await Promise.race([
          check(),
          new Promise<Checked>((resolve) => {
            late = setTimeout(() => {
              timedOut = true;
              resolve(timeoutAnswer);
            }, 15_000);
          }),
        ]);
      } finally {
        clearTimeout(late);
      }
      if ("failed" in checked) return checked.failed;
      if ("problem" in checked)
        return drawChecked(
          {
            ...(checked.address
              ? { addressProblem: String(checked.problem) }
              : { problem: checked.problem }),
            typed: shopUrl,
            ...(checked.preview === undefined ? {} : { preview: checked.preview }),
          },
          checked.status,
        );
      if (!connect || timedOut) return drawChecked({ preview: checked.preview, typed: shopUrl });
      const startedAt = new Date();
      await shops.beginGrant({
        ...(person.merchant === null ? {} : { merchantId: person.merchant.id }),
        token,
        accountId: person.id,
        shopUrl,
        currency: checked.currency,
        startedAt,
        expiresAt: new Date(startedAt.getTime() + GRANT_MINUTES * 60_000),
      });
      noted(person, `started connecting the WooCommerce shop at ${shopUrl}`);
      return { kind: "redirect", location: authorize };
    },

    importCatalogue: async (person, checkedJob) => await importFor(person, checkedJob),

    async setRate(person, form, cookie) {
      const connection = await shops.connectionOf(person.id);
      if (connection === null) {
        return { kind: "redirect", location: `${base}/woocommerce` };
      }
      const currency = connection.currency;
      if (currency === null || currency.code === "USD") {
        return await drawTheShop(
          person,
          {
            importing:
              currency === null
                ? "No rate was saved: Agentify hasn't read your shop's currency yet. Check your products first."
                : "No rate was saved: your shop sells in US dollars, which need no rate.",
          },
          409,
        );
      }
      const named = once(form.getAll("rate"));
      const typed = typeof named === "string" ? named.trim() : "";
      const asked = once(form.getAll("currency"));
      if (asked !== currency.code) {
        return await drawTheShop(
          person,
          {
            rate: {
              refused:
                `No rate was saved: your shop now sells in ${currency.code}, not` +
                ` ${typeof asked === "string" ? asked : "the currency this page was drawn for"}.` +
                ` Set a rate for ${currency.code} below.`,
            },
          },
          409,
        );
      }
      const rate = rateWrittenAs(typed);
      if (rate === null) {
        const meant = rateMeant(typed);
        return await drawTheShop(
          person,
          {
            rate: {
              typed,
              problem:
                meant === null
                  ? `Write how many ${currency.code} one US dollar buys in digits, like 18000.`
                  : `Write the rate in digits, with a dot only before decimals: ${meant}`,
            },
          },
          400,
        );
      }
      const read = await reference(currency.code);
      if (!read.ok && read.listed === false) {
        return await drawTheShop(
          person,
          {
            rate: {
              typed,
              refused:
                `No rate was saved: Coinbase gives no rate for ${currency.code}, and Agentify sells` +
                " from a shop in another currency only where it can show Coinbase's rate beside yours.",
            },
          },
          409,
        );
      }
      // The guard catches a digit too many or too few and a rate written the
      // wrong way round; it never refuses a rate the merchant typed twice.
      const gap = read.ok ? gapOf(rate, read.rate) : null;
      const confirmed = gap?.far === true;
      const again = once(form.getAll("again"));
      if (read.ok && gap?.far === true && rateWrittenAs(String(again ?? "")) !== rate) {
        return await drawTheShop(
          person,
          {
            rate: {
              typed: rate,
              again: rateFarSays({
                rate,
                typed,
                currency: currency.code,
                gap: gap.shown,
                reference: read.rate,
                example: await example(connection.shopUrl, currency),
              }),
            },
          },
          409,
        );
      }
      const shopOrigin = originOf(connection);
      const [previous, session] = await Promise.all([
        shops.currentRate(person.id, shopOrigin, currency.code),
        identity.whoIs(cookie, { renew: false }),
      ]);
      const setAt = new Date();
      // Handed over before the rate is written: a rate nobody was told of could
      // sell the shop's goods for cents unseen, so no notice means no rate.
      const handed = await postman(
        rateNoticeMessage({
          to: person.email,
          shopOrigin,
          currency: currency.code,
          rate,
          previous: previous?.rate ?? null,
          setAt,
          sessionSignedInAt: session?.signedInAt ?? null,
          screen: `${whereWeAre}/woocommerce`,
        }),
      );
      if (handed !== "accepted") {
        return await drawTheShop(
          person,
          {
            rate: {
              typed: rate,
              refused:
                `No rate was saved: every new rate is mailed to ${person.email}, and that message` +
                " couldn't be sent just now. Try again in a moment.",
            },
          },
          503,
        );
      }
      await shops.saveRate(person.id, shopOrigin, {
        currency: currency.code,
        rate,
        setAt,
        sessionSignedInAt: session?.signedInAt ?? null,
        reference: read.ok ? { rate: read.rate, source: read.source, readAt: read.readAt } : null,
        confirmed,
      });
      noted(
        person,
        `set the rate of the WooCommerce shop at ${shopOrigin} to ${rate} ${currency.code} per US dollar`,
      );
      return await drawTheShop(person, {
        rate: {
          saved: read.ok
            ? `Rate saved: ${withUnit(groupedRate(rate), currency.code)} per US dollar.`
            : `Rate saved: ${withUnit(groupedRate(rate), currency.code)} per US dollar. Coinbase's rate` +
              " couldn't be read, so it wasn't compared with anything.",
        },
      });
    },

    async switchToShop(person) {
      // For a merchant whose shop is connected while they sell through their
      // code: the switch the keys' arrival makes, asked again by the merchant.
      const switched = await gatewayAs(person).sellThrough("woocommerce");
      if (!switched.ok) {
        return await drawTheShop(
          person,
          { switching: await refusedMove(gatewayAs(person), "woocommerce", switched) },
          409,
        );
      }
      noted(person, "switched to selling through their connected WooCommerce shop");
      return { kind: "redirect", location: `${base}/woocommerce` };
    },

    async disconnect(person, form) {
      // A page drawn before keys arrived, or before another tab connected
      // another shop, would forget a shop its reader never saw.
      const connected = await shops.connectionOf(person.id);
      if (once(form.getAll("shop")) !== (connected?.shopUrl ?? NO_SHOP)) {
        return await drawTheShop(
          person,
          {
            leaving:
              connected === null
                ? "Nothing was changed: the shop this page showed is no longer connected."
                : `Nothing was disconnected: ${shopNameOf(connected.shopUrl)} was connected after this page loaded. Disconnect it here if you meant to.`,
          },
          409,
        );
      }
      // Back to the merchant's own code first, and the keys forgotten only
      // once that held: a shop forgotten while one of its orders still waits
      // would leave that order to nobody, since a parcel's shipment is read
      // off the shop, and only while it is connected.
      const switched = await gatewayAs(person).sellThrough("api");
      if (!switched.ok) {
        return await drawTheShop(
          person,
          { leaving: await refusedMove(gatewayAs(person), "api", switched) },
          409,
        );
      }
      const shopUrl = await shops.forget(person.id);
      noted(person, "forgot the keys their WooCommerce shop had given");
      // Where the code's cards came back with selling stopped, the merchant is
      // sent to the screen that starts it again, which says it is stopped.
      if (switched.document.sellingPaused) {
        return { kind: "redirect", location: `${base}/products` };
      }
      const query = shopUrl === null ? "" : `?${new URLSearchParams({ shop_url: shopUrl })}`;
      return { kind: "redirect", location: `${base}/woocommerce${query}` };
    },

    /**
     * In front of the gate: a browser can come back from the shop without a
     * session (it ended meanwhile, or the shop was opened in another browser),
     * and a sign-in form at the end of a working Connect reads as failure. A
     * browser with a session, the ordinary case under `Lax`, is sent on into
     * the dashboard. Without a session this reads no row, asks the gateway
     * nothing and draws the same page for everybody, so a stranger learns only
     * that the address exists.
     *
     * The token comes out of the address bar first: WooCommerce hands
     * `user_id` back here, and when the keys never arrived it is unspent for
     * the rest of its fifteen minutes. Sending the browser to the same address
     * without the query keeps it out of the address bar, history and any
     * `Referer`; it cannot remove it from the logs of the request that already
     * happened, which only spending or expiry ends.
     */
    async cameBack(cookie, query) {
      const signedIn = await identity.whoIs(cookie);
      if (signedIn !== null) {
        return {
          kind: "redirect",
          location: `${base}/${(await identity.onboardingChoices(signedIn.person.id)).platform === "woocommerce" ? "products" : "woocommerce"}?from=shop`,
          setCookies: signedIn.setCookies,
        };
      }
      if (query.size > 0) {
        return { kind: "redirect", location: `${base}/woocommerce/return` };
      }
      return { kind: "view", view: null };
    },
  };
}
