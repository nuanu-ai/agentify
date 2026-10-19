/**
 * The server half of the WooCommerce connector's screens: what their loaders
 * and actions call, answering with an `Outcome` as every page's server half
 * does. The shop's key and secret are read here to read its catalogue, and go
 * into no view and no log line. The shop's callback is not here: it is no
 * page, but a post from the shop's server that `server.ts` answers with a
 * status.
 */

import { readinessOf, UNKNOWN } from "@agentify/core";
import {
  type CardInput,
  MERCHANT_FINDINGS,
  type PublishResult,
} from "@nuanu-ai/agentify-contracts";
import type { DashboardConfig } from "./config.js";
import type { DashboardIdentity, Person } from "./dashboard-entry.js";
import type { Acting, Answer, GatewayClient } from "./gateway.js";
import { noted } from "./noted.js";
import { type Outcome, problemOf } from "./page-services.js";
import { unsetIn } from "./viewer.js";
import {
  cardsFromTheShop,
  decimalOfMinorUnits,
  merchantItemIdFor,
  USD_SCALE,
} from "./woo-catalog.js";
import {
  APP_NAME,
  authorizeUrlFor,
  GRANT_MINUTES,
  isTheGrantScreen,
  type Preflight,
  shopUrlAs,
  theStateToken,
  whatIsWrongWithTheShopUrl,
} from "./woo-connect.js";
import { type WooRecoveryView, wooRecoveryPagesFor } from "./woo-recovery-pages.js";
import {
  type CatalogueRead,
  catalogueOf,
  inspectProductInTheShop,
  PRODUCTS_AT_MOST,
  type ProductInspection,
  type ShopKeys,
  type WooOrderLookup,
} from "./woo-shop.js";
import type { WooShops } from "./woo-shops.js";
import {
  type ImportOutcome,
  type ShopAnswer,
  type ShopState,
  type WooImportView,
  type WooShopView,
  wooImportView,
  wooShopView,
} from "./woo-views.js";
import { SITE_IN_SETTINGS, type Unset } from "./words.js";

/**
 * The calls that reach a merchant's shop. Only tests pass others: both real
 * calls reach a shop over https, and a loopback shop would be refused before
 * either ran, so the calls are handed in rather than the shop stood up.
 */
export interface ShopCalls {
  readonly grantScreen: (authorizeUrl: string) => Promise<Preflight>;
  readonly catalogue: (shopUrl: string, atMost?: number) => Promise<CatalogueRead>;
  readonly inspectProduct: (keys: ShopKeys, merchantItemId: string) => Promise<ProductInspection>;
  readonly readOrder?: (keys: ShopKeys, orderId: string) => Promise<WooOrderLookup>;
}

export interface WooPages {
  recovery(person: Person, orderId: string): Promise<Outcome<WooRecoveryView>>;
  recover(person: Person, orderId: string, form: FormData): Promise<Outcome<WooRecoveryView>>;
  recoveryLinks(
    person: Person,
    orderIds: readonly string[],
  ): Promise<Readonly<Record<string, string>>>;
  /** The shop screen, with what its address carried. */
  shop(person: Person, query: URLSearchParams): Promise<Outcome<WooShopView>>;
  connect(person: Person, form: FormData): Promise<Outcome<WooShopView>>;
  importCatalogue(person: Person): Promise<Outcome<WooShopView | WooImportView>>;
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

export function wooPagesFor(config: DashboardConfig, parts: WooParts): WooPages {
  const base = config.basePath;
  const { identity, shops } = parts;
  /** Where a shop sends the merchant back to, and posts the keys to. */
  const whereWeAre = `${config.publicBaseUrl}${base}`;
  const grantScreen = parts.shop?.grantScreen ?? isTheGrantScreen;
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
    const [state, integration] = await Promise.all([
      shopStateOf(shops, person.id),
      gateway.integration(),
    ]);
    if (!integration.ok) return problemOf(integration);
    return {
      kind: "view",
      status,
      view: wooShopView({ state, through: integration.document.through }, answer),
    };
  };

  return {
    recovery: recovery.page,
    recover: recovery.recover,
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

      // A shop with plain permalinks answers this address with its own front
      // page and a 200, so a merchant sent there would land on their shop with
      // nothing to report.
      const looked = await grantScreen(authorize);
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
        startedAt,
        expiresAt: new Date(startedAt.getTime() + GRANT_MINUTES * 60_000),
      });
      noted(person, `started connecting the WooCommerce shop at ${shopUrl}`);
      return { kind: "redirect", location: authorize };
    },

    async importCatalogue(person) {
      const connection = await shops.connectionOf(person.id);
      if (connection === null) {
        return { kind: "redirect", location: `${base}/woocommerce` };
      }

      // Asked before the shop is read, like the settings below: a merchant
      // selling through their code would have every imported card refused, so
      // the shop screen offers them the switch instead.
      const integration = await gatewayAs(person).integration();
      if (!integration.ok) return problemOf(integration);
      if (integration.document.through !== "woocommerce") {
        return await drawTheShop(
          person,
          {
            switching:
              "Nothing was imported: you sell through your own code, so nothing imported would sell. Sell through this shop first.",
          },
          409,
        );
      }

      // Asked before the shop: the gateway refuses every card of a merchant
      // missing any of these, so importing would inspect every product for
      // nothing and repeat the refusal per product in words naming an API
      // route. A gateway that cannot answer this would not take a card either.
      const unset = await unsetOf(gatewayAs(person));
      if (!unset.ok) return problemOf(unset);
      if (unset.document.length > 0) {
        noted(
          person,
          `pressed Import while the publish door would refuse every card with ${unset.document.join(" and ")}, so the shop at` +
            ` ${connection.shopUrl} was not read and nothing was published`,
        );
        return await drawTheShop(person, { refused: unset.document }, 409);
      }

      // The ceiling goes in, so a catalogue too large is refused after three
      // round trips to somebody else's shop rather than fifty.
      const read = await catalogue(connection.shopUrl, PRODUCTS_AT_MOST);
      if (!read.ok) {
        return await drawTheShop(person, { problem: read.why }, 502);
      }

      const qualified = await mapAtMost(read.products, 4, async (product) => {
        const inspected = await inspectProduct(
          connection,
          merchantItemIdFor(connection.shopUrl, String(product.id)),
        );
        if (!inspected.ok) {
          return { ...product, qualification_problem: inspected.why };
        }
        const publicPrice = decimalOfMinorUnits(
          product.prices.price,
          product.prices.currency_minor_unit,
        );
        // Compared only at the scale the connector sells at; a catalogue at
        // another scale is refused by `cardsFromTheShop` in words naming the
        // shop's Number of decimals, whereas comparing "25" with "25.00" here
        // would call two equal prices different.
        if (
          product.prices.currency_minor_unit === USD_SCALE &&
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
      const { cards, skipped } = cardsFromTheShop(qualified, connection.shopUrl);
      const gateway = gatewayAs(person);
      const outcomes: ImportOutcome[] = [];
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

      noted(
        person,
        `imported ${outcomes.filter((one) => "published" in one).length} of` +
          ` ${read.products.length} products from ${connection.shopUrl}`,
      );
      return { kind: "view", view: wooImportView(connection.shopUrl, outcomes, skipped) };
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
