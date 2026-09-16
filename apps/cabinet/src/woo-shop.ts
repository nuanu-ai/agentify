/**
 * The two calls we make against a merchant's own shop.
 *
 * Reading the catalogue goes to the Store API, which WooCommerce serves to
 * anybody with no authentication at all — so no key is sent, because a secret
 * sent where it buys nothing is a secret in one more log. Creating the order
 * goes to `wc/v3` with the granted key pair as HTTP Basic, which is the scheme
 * WooCommerce accepts over https (`docs/research/27-woo-connect-probe.md`); the
 * shop address is refused at the door unless it is https, so there is one
 * scheme here and not two.
 *
 * Every failure comes back as a sentence the shop itself said, with a word for
 * whether asking again could change it. Both halves are for somebody else: the
 * sentence is what a merchant reads on a screen, and the word is what decides
 * whether an order is refused for good or handed back to be delivered again.
 */

import type { Money } from "@nuanu-ai/coinslot-contracts";
import { type StoreProduct, StoreProductsSchema } from "./woo-catalog.js";

/** How long we wait on a merchant's shop for one call. */
const SHOP_ANSWERS_WITHIN_MS = 15_000;

/**
 * How many products we ask for at a time.
 *
 * The Store API's own ceiling. Asking for fewer would be more round trips to
 * somebody else's server for the same catalogue.
 */
const PER_PAGE = 100;

/**
 * How many products the caller is willing to be handed, where it does not say.
 *
 * The ceiling is a parameter rather than a constant read here because the
 * caller is the one that knows what it can do with them — the import publishes
 * every one of them through the door while somebody holds a page open. Asked
 * for at all, it stops the walk as soon as it is passed: a shop with five
 * thousand products would otherwise be read whole, fifty round trips to
 * somebody else's server, and then refused for being too large.
 *
 * Ten thousand is the default and it is a guard rather than a policy: it stops
 * a shop answering a full page forever — a misconfigured proxy repeating one
 * response — from being a loop with a merchant watching it.
 */
const AT_MOST = 10_000;

export type CatalogueRead =
  | { readonly ok: true; readonly products: readonly StoreProduct[] }
  | { readonly ok: false; readonly why: string };

/** Everything the shop needs to know us by, once a grant has been made. */
export interface ShopKeys {
  readonly shopUrl: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
}

/** One sale, as the shop has to be told about it. */
export interface SoldItem {
  /** Our own order identifier, which goes onto the shop's order as a thread. */
  readonly orderId: string;
  /** The shop's own product identifier, which is the card's merchant_item_id. */
  readonly productId: string;
  /** Whose address goes on the order in the shop. */
  readonly email: string;
  /** What the buyer actually paid, which is what the shop's order records. */
  readonly price: Money;
}

export type OrderMade =
  | { readonly ok: true; readonly id: string; readonly number: string }
  | {
      readonly ok: false;
      readonly why: string;
      /**
       * Whether making this same call again could land.
       *
       * True only where nothing was decided — a shop that did not answer, a
       * shop that fell over. A shop that answered and refused says the same
       * thing to the same call forever, and an order handed back for another
       * attempt on one of those spends a delivery the merchant never failed.
       */
      readonly again: boolean;
    };

/**
 * The whole of a shop's public catalogue.
 *
 * Paged until a page comes back short, which is how the Store API says there is
 * no more: it carries a header with the total, and reading the header would be
 * one more thing to be wrong about on a shop behind a proxy that strips it.
 */
export const catalogueOf = async (
  shopUrl: string,
  atMost: number = AT_MOST,
): Promise<CatalogueRead> => {
  const products: StoreProduct[] = [];
  const pages = Math.ceil(atMost / PER_PAGE) + 1;

  for (let page = 1; page <= pages; page += 1) {
    const at = `${shopUrl}/wp-json/wc/store/v1/products?per_page=${PER_PAGE}&page=${page}`;
    let answered: Response;
    try {
      answered = await fetch(at, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(SHOP_ANSWERS_WITHIN_MS),
      });
    } catch (thrown) {
      return { ok: false, why: `Your shop did not answer: ${String(thrown)}` };
    }

    const said = await answered.text();
    if (!answered.ok) {
      return {
        ok: false,
        why:
          `Your shop answered ${answered.status} when we asked for its catalogue: ` +
          whatTheShopSaid(said, answered.status),
      };
    }

    let document: unknown;
    try {
      document = JSON.parse(said);
    } catch {
      return {
        ok: false,
        why:
          "Your shop answered the catalogue address with something that is not JSON. Check that" +
          " nothing in front of it is serving a page of its own at /wp-json.",
      };
    }

    const read = StoreProductsSchema.safeParse(document);
    if (!read.success) {
      // Not folded into "no products". A catalogue that is empty and a
      // document we cannot read are different news, and a merchant told the
      // first would go looking for products that are sitting right there.
      return {
        ok: false,
        why:
          "Your shop answered the catalogue address with a document we could not read as a list" +
          ` of products: ${read.error.issues[0]?.message ?? "the shape was not the expected one"}.`,
      };
    }

    products.push(...read.data);
    // The ceiling is read before the short page is, and the order of these two
    // is the whole of whether the ceiling means anything. The other way round,
    // a shop of two hundred and fifty products against a ceiling of two hundred
    // answers its third page short, and the short page returns them all — so
    // the number only ever bit on a catalogue that happened to be an exact
    // multiple of the page size, and everything in between came over whole with
    // nobody told.
    if (products.length > atMost) {
      // Stopped here rather than after the whole catalogue has been read: the
      // answer is the same either way, and the difference is how many round
      // trips somebody else's shop makes for a refusal.
      break;
    }
    if (read.data.length < PER_PAGE) {
      return { ok: true, products };
    }
  }

  return {
    ok: false,
    why:
      `Your shop offers more than ${atMost} products, which is more than this brings over in one` +
      " go. Nothing was imported.",
  };
};

/**
 * Creates one paid order in the merchant's shop.
 *
 * `set_paid` is the whole point: without it the order sits in the shop's
 * pending list and the merchant never ships it, although the buyer has paid.
 * The probe measured what the shop does with it — status `processing`, a
 * `date_paid` the shop stamps itself, and the order on the screen in wp-admin.
 *
 * It also sends two emails, one to the merchant and one to the address on the
 * order, and nothing in the request can suppress them. That is why the address
 * below is the merchant's own: see the decision record.
 *
 * The price sent is what the buyer actually paid rather than what the shop
 * charges today. The two can disagree — a merchant who changed a price after
 * the card was published — and of the two numbers, the one the shop's order
 * should record is the one the money moved for.
 */
export const createTheOrderInTheShop = async (
  keys: ShopKeys,
  sold: SoldItem,
): Promise<OrderMade> => {
  const productId = Number(sold.productId);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    return {
      ok: false,
      why:
        `This card is keyed by ${JSON.stringify(sold.productId)}, which is not a product` +
        " identifier in a WooCommerce shop, so there is nothing in the shop to order.",
      again: false,
    };
  }

  const body = {
    payment_method: "coinslot",
    payment_method_title: "Agentify",
    // The shop stores this string without checking it, and shows it on the
    // order screen — so it is our own order identifier, which is the one thread
    // between an order here and an order there.
    transaction_id: sold.orderId,
    set_paid: true,
    currency: sold.price.currency,
    billing: { email: sold.email },
    meta_data: [{ key: "coinslot_order_id", value: sold.orderId }],
    line_items: [
      {
        product_id: productId,
        quantity: 1,
        subtotal: sold.price.amount,
        total: sold.price.amount,
      },
    ],
  };

  let answered: Response;
  try {
    answered = await fetch(`${keys.shopUrl}/wp-json/wc/v3/orders`, {
      method: "POST",
      headers: {
        authorization: basicFor(keys),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SHOP_ANSWERS_WITHIN_MS),
    });
  } catch (thrown) {
    // Nothing was decided. It is also the one case where the order may have
    // reached the shop and the answer may have been lost, which is why the
    // caller keeps a record of having tried before it tries.
    return { ok: false, why: `The shop did not answer: ${String(thrown)}`, again: true };
  }

  const said = await answered.text();

  if (!answered.ok) {
    return {
      ok: false,
      why: `The shop answered ${answered.status}: ${whatTheShopSaid(said, answered.status)}`,
      again: worthAskingAgain(answered.status),
    };
  }

  let document: unknown;
  try {
    document = JSON.parse(said);
  } catch {
    return {
      ok: false,
      why: "The shop answered the order call with something that is not JSON.",
      again: false,
    };
  }

  const made = document as { id?: unknown; number?: unknown };
  const id = typeof made.id === "number" ? String(made.id) : null;
  if (id === null) {
    // The shop said yes and named no order. Whatever is at that address, it is
    // not WooCommerce answering, and claiming an order number out of it would
    // hand the buyer a string that means nothing in the merchant's shop.
    return {
      ok: false,
      why:
        "The shop accepted the order and its answer names no order, so there is nothing to tell" +
        " the buyer. Nothing here can say whether an order was created.",
      again: false,
    };
  }
  const number = typeof made.number === "string" && made.number !== "" ? made.number : id;
  return { ok: true, id, number };
};

/**
 * Whether a shop that answered with this status is worth asking again.
 *
 * A 5xx is the shop having a bad moment. So are the two below, and they are
 * named rather than left to fall through with the rest: a shop behind a rate
 * limiter or a proxy answers `429 Too Many Requests` and `408 Request Timeout`,
 * both of which mean "ask again in a moment" and neither of which is a 5xx.
 * Read as final, they close a sale for good and hand the buyer a refusal —
 * which is what a shop having a busy afternoon would cost its own merchant.
 *
 * Everything else is the shop having read the request and said no, and it will
 * say no again.
 */
const worthAskingAgain = (status: number): boolean =>
  status >= 500 || status === 408 || status === 429;

/** The key pair as WooCommerce takes it over https. */
const basicFor = (keys: ShopKeys): string =>
  `Basic ${Buffer.from(`${keys.consumerKey}:${keys.consumerSecret}`).toString("base64")}`;

/**
 * What the shop said, out of its own error document, or the status where there
 * is nothing to read.
 *
 * WordPress refuses in a shape of its own — a code and a message — and the
 * message is written for a person. What sits between us and the shop can be a
 * proxy or a firewall with a page of its own, which is why this falls back to
 * the status rather than parsing its way into an exception.
 */
const whatTheShopSaid = (said: string, status: number): string => {
  try {
    const body = JSON.parse(said) as { message?: unknown };
    if (typeof body.message === "string" && body.message !== "") {
      return body.message;
    }
  } catch {
    // Not a document. The status is the whole of what is known.
  }
  return `the answer carried no message we could read (HTTP ${status}).`;
};
