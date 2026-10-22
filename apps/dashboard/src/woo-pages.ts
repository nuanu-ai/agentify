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
import {
  type CardInput,
  MERCHANT_FINDINGS,
  type PublishResult,
} from "@nuanu-ai/agentify-contracts";
import type { DashboardConfig } from "./config.js";
import type { DashboardIdentity, Person } from "./dashboard-entry.js";
import type { Acting, Answer, GatewayClient } from "./gateway.js";
import { type Postman, postmanFor } from "./mail.js";
import { noted } from "./noted.js";
import { type Outcome, problemOf } from "./page-services.js";
import { unsetIn } from "./viewer.js";
import { cardsFromTheShop, decimalOfMinorUnits, merchantItemIdFor } from "./woo-catalog.js";
import {
  APP_NAME,
  authorizeUrlFor,
  EXAMPLE_PAGE,
  GRANT_MINUTES,
  isTheGrantScreen,
  noReferenceFor,
  type Preflight,
  type PricedExample,
  pricedExampleOfTheShop,
  referenceUnanswered,
  type ShopSample,
  sampleOfTheShop,
  shopUrlAs,
  theStateToken,
  whatIsWrongWithTheShopUrl,
  writesOtherDecimals,
} from "./woo-connect.js";
import { dollarsAt, gapOf, minorOf, rateWrittenAs, shopDecimalsOf } from "./woo-money.js";
import { rateNoticeMessage } from "./woo-rate-mail.js";
import { type WooRecoveryView, wooRecoveryPagesFor } from "./woo-recovery-pages.js";
import { type ReferenceRead, referenceRateOf } from "./woo-reference.js";
import {
  type CatalogueRead,
  catalogueOf,
  inspectProductInTheShop,
  PRODUCTS_AT_MOST,
  type ProductInspection,
  type ShopKeys,
  type WooOrderLookup,
} from "./woo-shop.js";
import type { ShopCurrency, ShopTotal, WooConnection, WooShops } from "./woo-shops.js";
import {
  type ImportOutcome,
  type ShopAnswer,
  type ShopState,
  type WooImportView,
  type WooShopView,
  wooImportView,
  wooShopView,
} from "./woo-views.js";
import { moment, SITE_IN_SETTINGS, type Unset } from "./words.js";

/**
 * The calls that reach a merchant's shop. Only tests pass others: both real
 * calls reach a shop over https, and a loopback shop would be refused before
 * either ran, so the calls are handed in rather than the shop stood up.
 */
export interface ShopCalls {
  readonly grantScreen: (authorizeUrl: string) => Promise<Preflight>;
  /** Null where the shop did not clearly say. */
  readonly sample: (shopUrl: string) => Promise<ShopSample | null>;
  /** The rate guard's example, in the shop's currency at its decimals. */
  readonly example?: (shopUrl: string, currency: ShopCurrency) => Promise<PricedExample>;
  /** Coinbase's rate for one US dollar; not the shop's, but read only beside it. */
  readonly reference?: (currency: string) => Promise<ReferenceRead>;
  readonly catalogue: (shopUrl: string, atMost?: number) => Promise<CatalogueRead>;
  readonly inspectProduct: (keys: ShopKeys, merchantItemId: string) => Promise<ProductInspection>;
  readonly readOrder?: (keys: ShopKeys, orderId: string) => Promise<WooOrderLookup>;
}

export interface WooPages {
  recovery(person: Person, orderId: string): Promise<Outcome<WooRecoveryView>>;
  recover(person: Person, orderId: string, form: FormData): Promise<Outcome<WooRecoveryView>>;
  /** What the shop's orders for these sales total, where the connector placed them. */
  shopTotals(
    person: Person,
    orderIds: readonly string[],
  ): Promise<Readonly<Record<string, ShopTotal>>>;
  recoveryLinks(
    person: Person,
    orderIds: readonly string[],
  ): Promise<Readonly<Record<string, string>>>;
  /** The shop screen, with what its address carried. */
  shop(person: Person, query: URLSearchParams): Promise<Outcome<WooShopView>>;
  connect(person: Person, form: FormData): Promise<Outcome<WooShopView>>;
  importCatalogue(person: Person): Promise<Outcome<WooShopView | WooImportView>>;
  /**
   * Saves the rate of a shop in another currency, and imports the shop again at
   * it. `cookie` names the session saving it, which its notice tells apart.
   */
  setRate(
    person: Person,
    form: FormData,
    cookie: string | undefined,
  ): Promise<Outcome<WooShopView | WooImportView>>;
  switchToShop(person: Person): Promise<Outcome<WooShopView>>;
  disconnect(person: Person): Promise<Outcome<WooShopView>>;
  /**
   * Where the shop sends the browser back to, in front of the gate. It reads
   * the session and nothing else, and answers anybody without one alike.
   */
  cameBack(cookie: string | undefined, query: URLSearchParams): Promise<Outcome<null>>;
  /** The account's connection as the shop screen reads it, for any screen that says it. */
  stateOf(accountId: string): Promise<ShopState>;
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

/** Preserves input order while bounding calls into one merchant's shop. */
const mapAtMost = async <Input, Output>(
  values: readonly Input[],
  atMost: number,
  visit: (value: Input) => Promise<Output>,
): Promise<Output[]> => {
  const results = new Array<Output>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await visit(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(atMost, values.length) }, worker));
  return results;
};

/**
 * A throw may come after the card was written, so it is neither a refusal nor a
 * publication: the import records no verdict, says whether it was published is
 * unknown, and stops, leaving the rest not attempted. Thrown out of the loop,
 * it would lose the record of every card already published.
 */
async function publishedOrNot(
  gateway: GatewayClient,
  card: CardInput,
): Promise<Answer<PublishResult>> {
  try {
    return await gateway.publishCard(card);
  } catch {
    // Not the exception, which can carry the values its store was given.
    console.error("[dashboard] publishing a card failed");
    return {
      ok: false,
      status: 500,
      why: "something failed inside Agentify while this product was being published, so whether it was published is not known; import again later, which does not double cards",
    };
  }
}

/** How many products one import run published, was refused or failed, and passed over. */
interface ImportCounts {
  readonly imported_count: number;
  readonly failed_count: number;
  readonly skipped_count: number;
}

const NOTHING_COUNTED: ImportCounts = { imported_count: 0, failed_count: 0, skipped_count: 0 };

type ReasonCode = ReturnType<typeof publishRefusalReason>;

/**
 * One import run's result as product analytics counts it: one event per run,
 * pressed or run again by a saved rate, whatever it came to, the products it
 * published counted as imported whether or not their cards were new.
 */
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

/** The currency and decimals the first product check that passed read off the shop's settings. */
const currencyRead = (inspections: readonly ProductInspection[]): ShopCurrency | null => {
  for (const one of inspections) {
    if (!one.ok) continue;
    const decimals = minorOf(one.product.price.amount)?.decimals;
    if (decimals !== undefined) return { code: one.product.price.currency, decimals };
  }
  return null;
};

export function wooPagesFor(config: DashboardConfig, parts: WooParts): WooPages {
  const base = config.basePath;
  const { identity, shops } = parts;
  /** Where a shop sends the merchant back to, and posts the keys to. */
  const whereWeAre = `${config.publicBaseUrl}${base}`;
  const grantScreen = parts.shop?.grantScreen ?? isTheGrantScreen;
  const sample = parts.shop?.sample ?? sampleOfTheShop;
  const example =
    parts.shop?.example ??
    ((shopUrl: string, currency: ShopCurrency) => pricedExampleOfTheShop(shopUrl, currency));
  const reference = parts.shop?.reference ?? ((code: string) => referenceRateOf(code));
  const postman = parts.postman ?? postmanFor(config);
  const catalogue = parts.shop?.catalogue ?? catalogueOf;
  const inspectProduct = parts.shop?.inspectProduct ?? inspectProductInTheShop;
  const recovery = wooRecoveryPagesFor({
    shops,
    gatewayFor: parts.clientFor,
    inspectProduct,
    ...(parts.shop?.readOrder === undefined ? {} : { readOrder: parts.shop.readOrder }),
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
   * gateway's. The operator's approval goes in as unknown: the connector is not
   * offered on live, the only place it is asked for.
   */
  const unsetOf = async (gateway: GatewayClient): Promise<Answer<readonly Unset[]>> => {
    const [name, wallet] = await Promise.all([gateway.sellerName(), gateway.payoutWallet()]);
    if (!name.ok) {
      return name;
    }
    if (!wallet.ok) {
      return wallet;
    }
    const door = readinessOf(
      {
        sellerName: name.document,
        payoutWallet: wallet.document.payout_wallet,
        liveApproval: UNKNOWN,
      },
      config.surfaceMode,
    );
    return { ok: true, document: unsetIn(door) };
  };

  /**
   * In one place because the screen is reached five ways (opened, and redrawn
   * after any of the four presses is refused), and a forgotten answer in one of
   * them would look like a merchant who has set nothing. The integration
   * failing to read fails the page: drawn without it, the page would offer or
   * hide the switch on a guess.
   */
  const drawTheShop = async (
    person: Person,
    answer: ShopAnswer,
    status = 200,
  ): Promise<Outcome<WooShopView>> => {
    const gateway = gatewayAs(person);
    const [state, integration, rate] = await Promise.all([
      shopStateOf(shops, person.id),
      gateway.integration(),
      rateOf(person),
    ]);
    if (!integration.ok) return problemOf(integration);
    return {
      kind: "view",
      status,
      view: wooShopView(
        { state, through: integration.document.through, ...(rate === null ? {} : { rate }) },
        answer,
      ),
    };
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

  /**
   * Import, as the button runs it and as saving a rate runs it again, which
   * says what was saved in every answer it gives.
   */
  const importFor = async (
    person: Person,
    rateSaved: string | null,
  ): Promise<Outcome<WooShopView | WooImportView>> => {
    const saved = rateSaved === null ? {} : { rate: { saved: rateSaved } };
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
            "Nothing was imported: you sell through your own code, so nothing imported would sell. Sell through this shop first.",
          ...saved,
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
    if (unset.document.length > 0) {
      // Counted as the gateway counts a card refused for the same lack.
      await resulted({ outcome: "blocked", reason_code: publishRefusalReason(unset.document) });
      noted(
        person,
        `pressed Import while the publish door would refuse every card with ${unset.document.join(" and ")}, so the shop at` +
          ` ${connection.shopUrl} was not read and nothing was published`,
      );
      return await drawTheShop(person, { refused: unset.document, ...saved }, 409);
    }

    // The ceiling goes in, so a catalogue too large is refused after three
    // round trips to somebody else's shop rather than fifty.
    const read = await catalogue(connection.shopUrl, PRODUCTS_AT_MOST);
    if (!read.ok) {
      await resulted({ outcome: "blocked", reason_code: "catalogue_unavailable" });
      return await drawTheShop(person, { problem: read.why, ...saved }, 502);
    }

    const inspections = await mapAtMost(read.products, 4, async (product) => ({
      product,
      inspected: await inspectProduct(
        connection,
        merchantItemIdFor(connection.shopUrl, String(product.id)),
      ),
    }));
    // The shop's own settings, as every product check read them, name what it
    // sells in; noted for the screen, which asks for a rate in that currency.
    const sells = currencyRead(inspections.map((one) => one.inspected));
    if (sells !== null) await shops.noteCurrency(person.id, sells);
    let rate: string | null = null;
    if (sells !== null && sells.code !== "USD") {
      const current = await shops.currentRate(person.id, originOf(connection), sells.code);
      if (current === null) {
        // A rate is a setting of the merchant's, as a wallet or a site is.
        await resulted({ outcome: "blocked", reason_code: "profile_missing" });
        noted(
          person,
          `pressed Import for a shop selling in ${sells.code} with no rate set, so nothing was published`,
        );
        return await drawTheShop(
          person,
          {
            rate: {
              ...saved.rate,
              problem:
                `Nothing was imported: your shop sells in ${sells.code}, and no rate is set for` +
                " it yet. Set one below; saving it imports your products at it.",
            },
          },
          409,
        );
      }
      rate = current.rate;
    }

    const qualified = inspections.map(({ product, inspected }) => {
      if (!inspected.ok) {
        return { ...product, qualification_problem: inspected.why };
      }
      const publicPrice = decimalOfMinorUnits(
        product.prices.price,
        product.prices.currency_minor_unit,
      );
      // Compared only at the decimals the shop's settings write; a catalogue
      // at others is refused by `cardsFromTheShop` in words naming the
      // shop's Number of decimals, whereas comparing "25" with "25.00" here
      // would call two equal prices different.
      if (
        product.prices.currency_minor_unit === minorOf(inspected.product.price.amount)?.decimals &&
        (publicPrice !== inspected.product.price.amount ||
          product.prices.currency_code !== inspected.product.price.currency)
      ) {
        return {
          ...product,
          qualification_problem:
            "The public catalog price does not match the protected WooCommerce product price.",
        };
      }
      // The Store API's list does not say whether a product is virtual or a
      // download, so the class the protected check found is written in.
      const checked = inspected.product;
      return {
        ...product,
        status: "publish",
        virtual: checked.kind === "download",
        downloadable: checked.kind === "download",
        manage_stock: false,
        download_limit: -1,
        download_expiry: -1,
        downloads:
          checked.kind === "download"
            ? [{ id: checked.downloadId, name: checked.fileName, file: "protected-by-woo" }]
            : [],
        qualification_problem: null,
      };
    });
    const { cards, skipped } =
      sells === null
        ? cardsFromTheShop(qualified, connection.shopUrl)
        : cardsFromTheShop(qualified, connection.shopUrl, {
            currency: sells.code,
            decimals: sells.decimals,
            rate,
          });
    const gateway = gatewayAs(person);
    const outcomes: ImportOutcome[] = [];
    let firstRefusal: ReasonCode | null = null;
    for (const [index, one] of cards.entries()) {
      const published = await publishedOrNot(gateway, one.card);
      if (!published.ok) {
        // The gateway did not answer, or answered with something else: not a
        // refused card, and said as what it is.
        outcomes.push({ id: one.id, title: one.title, failed: published.why });
        outcomes.push(
          ...cards
            .slice(index + 1)
            .map((later) => ({ id: later.id, title: later.title, notAttempted: true as const })),
        );
        break;
      }
      if (published.document.ok) {
        outcomes.push({ id: one.id, title: one.title, published: published.document.id });
        continue;
      }
      firstRefusal ??= publishRefusalReason(
        published.document.error.problems.map((problem) => problem.code),
      );
      // The gateway's findings word for word, telling the merchant which
      // field to change in their shop; the shop's site is the exception, set
      // in Settings by the person here rather than through the API.
      outcomes.push({
        id: one.id,
        title: one.title,
        problems: published.document.error.problems.map((problem) =>
          problem.code === MERCHANT_FINDINGS.NO_SELLER_SITE
            ? SITE_IN_SETTINGS
            : problem.path.length === 0
              ? problem.message
              : `${problem.path.join(".")}: ${problem.message}`,
        ),
      });
    }

    const counted = (kind: "published" | "problems" | "failed" | "notAttempted") =>
      outcomes.filter((one) => kind in one).length;
    // A product left unattempted after a failure is passed over like one the
    // shop's catalogue could not make a card of.
    const counts: ImportCounts = {
      imported_count: counted("published"),
      failed_count: counted("problems") + counted("failed"),
      skipped_count: skipped.length + counted("notAttempted"),
    };
    await resulted(
      // The card whose publication failed may have been published.
      counted("failed") > 0
        ? { outcome: "unknown", reason_code: "internal_error" }
        : counts.failed_count === 0
          ? { outcome: "completed" }
          : counts.imported_count > 0
            ? { outcome: "partial" }
            : { outcome: "blocked", reason_code: firstRefusal ?? "invalid_input" },
      counts,
    );
    noted(
      person,
      `imported ${counts.imported_count} of` +
        ` ${read.products.length} products from ${connection.shopUrl}`,
    );
    return {
      kind: "view",
      view: wooImportView(connection.shopUrl, outcomes, skipped, rateSaved),
    };
  };

  return {
    recovery: recovery.page,
    recover: recovery.recover,
    async shopTotals(person, orderIds) {
      if (person.merchant === null) return {};
      return await shops.shopTotals(person.id, orderIds);
    },
    async recoveryLinks(person, orderIds) {
      if (person.merchant === null) return {};
      const ids = await shops.recoverableOrders(person.id, orderIds);
      return Object.fromEntries(
        ids.map((id) => [id, `${base}/integrations/woocommerce/recover/${encodeURIComponent(id)}`]),
      );
    },
    stateOf: async (accountId) => await shopStateOf(shops, accountId),

    async shop(person, query) {
      // The only page that reads the flag the return address's redirect set,
      // and it is spent by being drawn, so a merchant opening this page
      // tomorrow is not told they just came back. The flag, never the token.
      const typed = once(query.getAll("shop_url"));
      return await drawTheShop(person, {
        cameBack: once(query.getAll("from")) === "shop",
        ...(typeof typed === "string" ? { typed } : {}),
      });
    },

    async connect(person, form) {
      const named = once(form.getAll("shop_url"));
      const typed = typeof named === "string" ? named.trim() : "";

      const wrong = whatIsWrongWithTheShopUrl(typed);
      if (wrong !== null) {
        return await drawTheShop(person, { problem: wrong, typed }, 400);
      }
      const shopUrl = shopUrlAs(typed);

      // Our own address first: WooCommerce refuses a `callback_url` that is not
      // https, so on an http deployment every Connect would end at the shop's
      // own SSL refusal for something that is ours.
      if (!whereWeAre.startsWith("https://")) {
        return await drawTheShop(
          person,
          {
            problem:
              `This Agentify deployment is reachable at ${whereWeAre}, which is not https, and WooCommerce` +
              " will not send a shop's keys to an address that is not. Nothing here can connect a" +
              " shop until whoever runs this deployment puts it behind https.",
            typed,
          },
          400,
        );
      }

      const connected = await shops.connectionOf(person.id);
      if (connected !== null && new URL(connected.shopUrl).origin !== new URL(shopUrl).origin) {
        return await drawTheShop(
          person,
          {
            problem:
              "Disconnect the connected shop before connecting another. Orders still waiting on the shop must finish first.",
            typed,
          },
          409,
        );
      }

      // Minted first, so the address checked is character for character the
      // address the browser is sent to.
      const token = theStateToken();
      const authorize = authorizeUrlFor(shopUrl, {
        appName: APP_NAME,
        userId: token,
        returnUrl: `${whereWeAre}/woocommerce/return`,
        callbackUrl: `${whereWeAre}/woocommerce/callback`,
      });

      // A shop that could sell nothing, in a currency or at decimals out of
      // scope, is refused before the switch below takes the code's cards off
      // sale. Asked alongside the grant screen, so Connect waits for the slower
      // of the two rather than both in turn.
      //
      // A shop with plain permalinks answers the grant address with its own
      // front page and a 200, so a merchant sent there would land on their
      // shop with nothing to report.
      const [sampled, looked] = await Promise.all([sample(shopUrl), grantScreen(authorize)]);
      const decimals = sampled === null ? null : shopDecimalsOf(String(sampled.decimals));
      if (sampled !== null && sampled.currency !== "USD") {
        if (decimals === null) {
          return await drawTheShop(
            person,
            { problem: writesOtherDecimals(sampled.currency, sampled.decimals), typed },
            400,
          );
        }
        const listed = await reference(sampled.currency);
        if (!listed.ok) {
          return await drawTheShop(
            person,
            {
              problem:
                listed.listed === false
                  ? noReferenceFor(sampled.currency)
                  : referenceUnanswered(sampled.currency),
              typed,
            },
            listed.listed === false ? 400 : 503,
          );
        }
      }
      if (!looked.ok) {
        return await drawTheShop(person, { problem: looked.why, typed }, 400);
      }

      // The merchant moves to the shop here, before they are sent to it, and
      // not when the keys arrive: refused at the callback, the switch could
      // only be told to the shop's server; refused here, it is told to the
      // merchant beside the button. One who goes and never approves sells
      // through a shop with none connected, and the page offers the way back.
      const switched = await gatewayAs(person).sellThrough("woocommerce");
      if (!switched.ok) {
        return await drawTheShop(person, { problem: switched, typed }, 409);
      }

      // Written only now: a Connect nobody could complete is a row nobody comes
      // back for. One clock reading for both fields, so "started four minutes
      // ago" and "the fifteen minutes are up" can never disagree.
      const startedAt = new Date();
      await shops.beginGrant({
        token,
        accountId: person.id,
        shopUrl,
        currency:
          sampled === null || decimals === null ? null : { code: sampled.currency, decimals },
        startedAt,
        expiresAt: new Date(startedAt.getTime() + GRANT_MINUTES * 60_000),
      });
      noted(person, `started connecting the WooCommerce shop at ${shopUrl}`);
      return { kind: "redirect", location: authorize };
    },

    importCatalogue: async (person) => await importFor(person, null),

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
            problem:
              currency === null
                ? "Nothing was saved: Agentify has not read your shop's currency yet. Import your products once, which reads it."
                : "Nothing was saved: your shop sells in US dollars, which need no rate.",
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
              problem:
                `Nothing was saved: your shop now sells in ${currency.code}, not` +
                ` ${typeof asked === "string" ? asked : "the currency this page was drawn for"}.` +
                ` Set a rate for ${currency.code} below.`,
            },
          },
          409,
        );
      }
      const rate = rateWrittenAs(typed);
      if (rate === null) {
        return await drawTheShop(
          person,
          {
            rate: {
              typed,
              problem:
                `Nothing was saved. Write how many ${currency.code} one US dollar buys in digits,` +
                " with a dot only before a fraction of at most six digits and nothing between" +
                " thousands: 18000, not 18,000 or 18 000.",
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
              problem:
                `Nothing was saved: Coinbase gives no rate for ${currency.code}, and Agentify sells` +
                " from a shop in another currency than US dollars only where it can show you" +
                " Coinbase's rate beside yours.",
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
        const product = await example(connection.shopUrl, currency);
        const costs =
          product.kind === "priced"
            ? `So ${product.name}, priced ${product.price} ${currency.code}, would sell for` +
              ` ${dollarsAt(product.price, rate) ?? "?"} USD instead of` +
              ` ${dollarsAt(product.price, read.rate) ?? "?"} USD.`
            : product.kind === "none"
              ? "What one of your products would cost is not shown, because none of the first" +
                ` ${EXAMPLE_PAGE} products in your shop's public catalogue has a price in ${currency.code}.`
              : "What one of your products would cost could not be shown, because your shop's" +
                " public catalogue did not answer just now.";
        return await drawTheShop(
          person,
          {
            rate: {
              typed: rate,
              again:
                `${rate} ${currency.code} per US dollar is ${gap.shown} Coinbase's ${read.rate},` +
                ` read at ${moment(read.readAt.toISOString())}. ${costs} Type the rate again to` +
                " save it; if you wrote a dot between thousands, leave it out.",
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
          sessionSignedInAt: session?.person.id === person.id ? session.signedInAt : null,
          screen: `${whereWeAre}/woocommerce`,
        }),
      );
      if (handed !== "accepted") {
        return await drawTheShop(
          person,
          {
            rate: {
              typed: rate,
              problem:
                `Nothing was saved: every new rate is mailed to ${person.email}, and that message` +
                " could not be sent just now. Try again in a moment.",
            },
          },
          503,
        );
      }
      await shops.saveRate(person.id, shopOrigin, {
        currency: currency.code,
        rate,
        setAt,
        setBy: person.email,
        reference: read.ok ? { rate: read.rate, source: read.source, readAt: read.readAt } : null,
        confirmed,
      });
      noted(
        person,
        `set the rate of the WooCommerce shop at ${shopOrigin} to ${rate} ${currency.code} per US dollar`,
      );
      return await importFor(
        person,
        read.ok
          ? `Your rate of ${rate} ${currency.code} per US dollar was saved.`
          : `Your rate of ${rate} ${currency.code} per US dollar was saved. Coinbase's rate could` +
              " not be read just now, so this rate was not compared with anything.",
      );
    },

    async switchToShop(person) {
      // For a merchant whose shop is connected while they sell through their
      // code: what Connect does before sending them to the shop, for one whose
      // shop is already here.
      const switched = await gatewayAs(person).sellThrough("woocommerce");
      if (!switched.ok) {
        return await drawTheShop(person, { switching: switched }, 409);
      }
      noted(person, "switched to selling through their connected WooCommerce shop");
      return { kind: "redirect", location: `${base}/woocommerce` };
    },

    async disconnect(person) {
      // Back to the merchant's own code first, and the keys forgotten only
      // once that held: a shop forgotten while one of its orders still waits
      // would leave that order to nobody, since a parcel's shipment is read
      // off the shop, and only while it is connected.
      const switched = await gatewayAs(person).sellThrough("api");
      if (!switched.ok) {
        return await drawTheShop(person, { leaving: switched }, 409);
      }
      const shopUrl = await shops.forget(person.id);
      noted(person, "forgot the keys their WooCommerce shop had given");
      // Where the code's cards came back with selling stopped, the merchant is
      // sent to the screen that starts it again, which says it is stopped.
      if (switched.document.sellingPaused) {
        return { kind: "redirect", location: `${base}/cards` };
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
          location: `${base}/woocommerce?from=shop`,
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
