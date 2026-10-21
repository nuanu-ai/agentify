/**
 * A WooCommerce shop's catalogue, read through its keyless Store API
 * (`/wp-json/wc/store/v1/products`), written out as cards. Nothing here talks
 * to a shop (`woo-shop.ts` fetches), so every decision is a function of a
 * document.
 *
 * A price is a number and a scale, never a number alone. The Store API writes
 * minor units with `currency_minor_unit` beside them, so `"12000"` is $120.00
 * at scale two and ¥12000 at scale zero, while `wc/v3` writes decimals: a
 * product's price as typed (`"25"`, `"19.9"`) and order totals at the shop's
 * decimals (`"25.00"`). Assuming the scale is wrong by a factor of a hundred,
 * silently, in the direction of somebody's money.
 *
 * Nothing the merchant wrote is edited to fit. A description too long for the
 * catalogue is carried whole and refused at publish, where the merchant can
 * shorten it in their shop; cutting it here would publish prose under their
 * name they never wrote. A product that cannot be mapped is left out and named,
 * never published as something approximate.
 */

import { createHash } from "node:crypto";
import {
  type CardInput,
  CurrencyCodeSchema,
  IdentifierSchema,
  priceProblemsOf,
} from "@nuanu-ai/agentify-contracts";
import { z } from "zod";
import { type HtmlAsText, plainTextOfHtml } from "./html-text.js";
import { dollarsAt, type ShopDecimals } from "./woo-money.js";

/**
 * Loose, so the day WooCommerce adds a field it does not refuse a whole
 * merchant's catalogue.
 */
const StoreProductSchema = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  /** Empty on a product with none. */
  sku: z.string().default(""),
  type: z.string(),
  /** As HTML. */
  description: z.string().default(""),
  short_description: z.string().default(""),
  is_purchasable: z.boolean(),
  is_in_stock: z.boolean(),
  status: z.string().default("publish"),
  /**
   * The Store API's list carries neither, so the import fills both from the
   * protected product check (`inspectProductInTheShop`) before
   * `cardsFromTheShop`; an unchecked product reads as these defaults and is
   * refused for its check's reason.
   */
  virtual: z.boolean().default(false),
  downloadable: z.boolean().default(false),
  manage_stock: z.boolean().default(false),
  download_limit: z.number().int().default(-1),
  download_expiry: z.number().int().default(-1),
  downloads: z
    .array(
      z.looseObject({
        id: z.string(),
        name: z.string(),
        file: z.string(),
      }),
    )
    .default([]),
  qualification_problem: z.string().nullable().default(null),
  prices: z.looseObject({
    price: z.string(),
    currency_code: z.string(),
    /** How many digits of `price` are fractional. */
    currency_minor_unit: z.number().int(),
  }),
});

export type StoreProduct = z.infer<typeof StoreProductSchema>;

export const StoreProductsSchema = z.array(StoreProductSchema);

/**
 * The scale is read, never assumed. Null rather than a fallback, because every
 * alternative is a number a card would sell at. Nothing is rounded or parsed as
 * a float: the shop's digits come out with a dot moved into them, so `"0.10"`
 * cannot become `"0.1000000000000000055"`.
 */
export const decimalOfMinorUnits = (minor: string, scale: number): string | null => {
  if (!/^\d+$/.test(minor)) {
    return null;
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
    return null;
  }
  if (scale === 0) {
    return minor;
  }
  const digits = minor.padStart(scale + 1, "0");
  return `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
};

const sentenceOf = (clause: string): string =>
  `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;

interface ImportedCard {
  /** Also the card's `merchant_item_id`. */
  readonly id: string;
  readonly title: string;
  readonly card: CardInput;
}

export interface SkippedProduct {
  readonly id: string;
  readonly title: string;
  readonly why: string;
}

export interface ImportedCatalogue {
  readonly cards: readonly ImportedCard[];
  readonly skipped: readonly SkippedProduct[];
}

/**
 * The shop's own order number: with it the buyer can ask the merchant, who
 * finds the order on the screen they already use. A card must declare at least
 * one field that always arrives; a second we might not fill would be a promise
 * made on the merchant's behalf.
 */
const WHAT_THE_BUYER_RECEIVES = {
  download_url: {
    type: "string",
    title: "The private WooCommerce download address",
  },
  file_name: {
    type: "string",
    title: "The name of the downloadable file",
  },
  order_number: {
    type: "string",
    title: "The number this order has in the shop",
  },
} as const;

/**
 * Agentify's number, not the merchant's estimate: WooCommerce has no field for
 * it. It holds while parcels sell in test mode only; selling them live needs
 * the time to ship from the merchant. The import screen says so, because an
 * order not shipped after it reads as unfulfilled.
 */
const SHIP_WITHIN_SECONDS = 7 * 24 * 60 * 60;

/**
 * What the shop sells in, by its own settings, and the merchant's rate for it:
 * how many units of that currency one US dollar buys, null for US dollars.
 */
export interface ShopSale {
  readonly currency: string;
  readonly decimals: ShopDecimals;
  readonly rate: string | null;
}

const IN_DOLLARS: ShopSale = { currency: "USD", decimals: 2, rate: null };

/**
 * In the shop's order, so the merchant reads both lists against their own
 * catalogue screen. Every card is priced in US dollars: a shop in another
 * currency at its merchant's rate, rounded up to the cent.
 */
export const cardsFromTheShop = (
  products: readonly StoreProduct[],
  shopOrigin = "https://shop.example.com",
  sale: ShopSale = IN_DOLLARS,
): ImportedCatalogue => {
  const cards: ImportedCard[] = [];
  const skipped: SkippedProduct[] = [];

  for (const product of products) {
    const id = String(product.id);
    const name = plainTextOfHtml(product.name);
    const title = name.text;
    // Names a product nobody could map the way the merchant knows it.
    const named = title === "" ? (product.sku === "" ? id : product.sku) : title;
    const refused = (why: string): void => {
      skipped.push({ id, title: named, why });
    };

    if (product.qualification_problem !== null) {
      refused(product.qualification_problem);
      continue;
    }

    if (product.type !== "simple") {
      refused(
        `The shop sells this as a "${product.type}" product. A card is one thing at one price,` +
          " so a product with variations or parts has no single card to become.",
      );
      continue;
    }
    if (!product.is_purchasable) {
      refused("The shop does not offer this product for sale.");
      continue;
    }
    if (!product.is_in_stock) {
      refused("The shop says this product is out of stock.");
      continue;
    }
    if (product.status !== "publish") {
      refused("The product is not published in the shop.");
      continue;
    }
    // Two classes and nothing between: a virtual download handed to the agent,
    // and a physical product a carrier takes. A virtual product with no file
    // has nothing to hand over or ship; a non-virtual download would be both at
    // once.
    const parcel = !product.virtual && !product.downloadable;
    if (!parcel && !product.virtual) {
      refused(
        "The shop sells this as a download that also ships. This connector sells a virtual" +
          " download or a physical product that ships, not both at once.",
      );
      continue;
    }
    if (!parcel && !product.downloadable) {
      refused("This product has no WooCommerce download to deliver to the agent.");
      continue;
    }
    if (product.manage_stock) {
      refused("Products whose stock is counted are not supported by this connector.");
      continue;
    }
    if (!parcel && (product.download_limit !== -1 || product.download_expiry !== -1)) {
      refused("The download must have unlimited uses and no expiry.");
      continue;
    }
    if (!parcel && product.downloads.length !== 1) {
      refused("The product must carry exactly one downloadable file.");
      continue;
    }

    if (product.prices.currency_code !== sale.currency) {
      refused(
        `The shop's public catalogue prices this product in` +
          ` ${JSON.stringify(product.prices.currency_code)}, while the shop's own currency setting` +
          ` is ${sale.currency}, which ${sale.rate === null ? "this connector sells in" : "your rate is set for"}.` +
          " A plugin that changes the currency by visitor is the usual cause.",
      );
      continue;
    }
    if (product.prices.currency_minor_unit !== sale.decimals) {
      // Named as the setting rather than the prices: a whole-dollar shop that
      // retyped every price with cents would be refused all the same.
      refused(
        `The shop's catalogue writes prices with ${product.prices.currency_minor_unit} decimal` +
          ` places, and this shop is sold from at ${sale.decimals}. Set WooCommerce → Settings →` +
          ` General → Number of decimals to ${sale.decimals}; if it already is, something in the` +
          " shop is changing the decimals its catalogue is written at.",
      );
      continue;
    }
    const amount = decimalOfMinorUnits(product.prices.price, product.prices.currency_minor_unit);
    if (amount === null) {
      refused(
        `The shop sent ${JSON.stringify(product.prices.price)} as this product's price, at a` +
          ` scale of ${product.prices.currency_minor_unit}, and that is not a number we can read` +
          " as an amount.",
      );
      continue;
    }
    const dollars = sale.rate === null ? amount : dollarsAt(amount, sale.rate);
    const currency = sale.rate === null ? product.prices.currency_code : "USD";
    if (dollars === null || !CurrencyCodeSchema.safeParse(currency).success) {
      refused(
        `The shop prices this product at ${JSON.stringify(product.prices.price)} in` +
          ` ${JSON.stringify(product.prices.currency_code)}, which is not an amount we can put on a card.`,
      );
      continue;
    }
    // The contract's own price rule, so a product it would refuse is named here
    // as left in the shop. Only zero can reach it; currency and decimals are
    // settled above.
    const unsellable = priceProblemsOf({ amount: dollars, currency });
    if (unsellable.length > 0) {
      refused(unsellable.map((problem) => sentenceOf(problem.message)).join(" "));
      continue;
    }

    if (title === "") {
      refused("The product has no name in the shop, and a card is found by its title.");
      continue;
    }
    if (!name.plain) {
      refused(stillNotPlainText("name", name.found));
      continue;
    }
    const merchantItemId = merchantItemIdFor(shopOrigin, id);
    if (!IdentifierSchema.safeParse(merchantItemId).success) {
      refused("The shop's own identifier for this product is not one a card can be keyed by.");
      continue;
    }

    const prose = firstProseOf(product);
    const description = prose.text;
    if (description === "") {
      refused(
        "The shop's page for this product has no description. A card carries one, because it is" +
          " what an agent reads before it decides to buy.",
      );
      continue;
    }
    if (!prose.plain) {
      refused(stillNotPlainText("description", prose.found));
      continue;
    }

    cards.push({
      id,
      title,
      card: parcel
        ? {
            merchant_item_id: merchantItemId,
            title,
            description,
            price: { amount: dollars, currency },
            fulfillment: "ship",
            price_check: "handler",
            ship_within_seconds: SHIP_WITHIN_SECONDS,
          }
        : {
            merchant_item_id: merchantItemId,
            title,
            description,
            price: { amount: dollars, currency },
            result: { ...WHAT_THE_BUYER_RECEIVES },
            fulfillment: "async",
            price_check: "handler",
          },
    });
  }

  return { cards, skipped };
};

/**
 * Includes the shop, so a card cannot silently switch shops when two shops
 * share product id 42.
 */
export const merchantItemIdFor = (shopOrigin: string, productId: string): string => {
  const origin = new URL(shopOrigin).origin.toLowerCase();
  const fingerprint = createHash("sha256").update(origin).digest("hex").slice(0, 16);
  return `woo_${fingerprint}_${productId}`;
};

/** Only when the card is bound to this shop. */
export const productIdFromMerchantItem = (
  shopOrigin: string,
  merchantItemId: string,
): string | null => {
  const marker = merchantItemIdFor(shopOrigin, "");
  if (!merchantItemId.startsWith(marker)) {
    return null;
  }
  const productId = merchantItemId.slice(marker.length);
  return /^\d+$/.test(productId) ? productId : null;
};

/**
 * The long description first, since that is where a shop says what the buyer
 * gets; the short one otherwise, so a shop that wrote only excerpts is not
 * refused for having no description.
 */
const firstProseOf = (product: StoreProduct): HtmlAsText => {
  const long = plainTextOfHtml(product.description);
  return long.text === "" ? plainTextOfHtml(product.short_description) : long;
};

/**
 * The page shows `<header>` or `&#038;` because the merchant wrote it as text,
 * so the sentence names what was found and where to change it, rather than
 * sending the card to be refused for HTML the merchant never wrote as HTML.
 */
const stillNotPlainText = (what: "name" | "description", found: readonly string[]): string =>
  `Read the way the shop's page shows it, this product's ${what} carries ${found.join("; and ")}.` +
  ` A card's text is plain text, so change the ${what} in the shop and import again.`;
