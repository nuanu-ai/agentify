/**
 * A WooCommerce shop's own catalogue, read through its Store API and written
 * out as cards our publish door would recognise.
 *
 * The Store API is the half of WooCommerce that needs no key at all: a shop
 * serves `/wp-json/wc/store/v1/products` to anybody, out of the box, and that
 * is where the products a merchant is asking us to sell come from
 * (`docs/research/33-woo-connect-probe.md`). Nothing here talks to a shop —
 * `woo-shop.ts` does the fetching — so every decision in this file is a
 * function of a document and can be read back off a test.
 *
 * Two rules run through it.
 *
 * **A price is a number and a scale, never a number.** The Store API writes a
 * price as a string of minor units with `currency_minor_unit` beside it, so
 * `"12000"` is a hundred and twenty dollars at a scale of two and twelve
 * thousand yen at a scale of zero. `wc/v3`, which is what we create the order
 * through, writes the same price as a decimal, and in two ways: a product's
 * price as the merchant typed it, `"25"` or `"19.9"`, and an order's totals at
 * the shop's number of decimals, `"25.00"`. A converter that reads the number
 * and assumes the scale is wrong by a factor of a hundred for every ordinary
 * currency, silently, in the direction of somebody's money.
 *
 * **Nothing the merchant wrote is edited to fit.** A description too long for
 * our own catalogue is carried across whole and refused at the publish, where
 * the merchant reads the refusal in our own words and can go and shorten it in
 * their shop. Cutting it here would publish prose under their name that they
 * never wrote, and they would have no way of finding out. The same goes for a
 * product this cannot map at all: it is left out and named, rather than
 * published as something approximate.
 */

import { createHash } from "node:crypto";
import { type CardInput, CurrencyCodeSchema, IdentifierSchema } from "@nuanu-ai/agentify-contracts";
import { z } from "zod";

/**
 * One product as the Store API serves it — the fields we read, and no claim
 * about the rest.
 *
 * Loose rather than strict, and that is the difference between a shop on a
 * WooCommerce we have seen and a shop on the next one. The document carries
 * dozens of fields we have no use for, and a strict schema would refuse a whole
 * merchant's catalogue the day WooCommerce adds one more.
 */
export const StoreProductSchema = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  /** The merchant's own code for the product. Empty on a product with none. */
  sku: z.string().default(""),
  /** `simple`, `variable`, `grouped`, `external` — WooCommerce's own word. */
  type: z.string(),
  /** The shop's long prose for the product, as HTML. */
  description: z.string().default(""),
  short_description: z.string().default(""),
  is_purchasable: z.boolean(),
  is_in_stock: z.boolean(),
  status: z.string().default("publish"),
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
    /** How many of the digits in `price` are fractional. */
    currency_minor_unit: z.number().int(),
  }),
});

export type StoreProduct = z.infer<typeof StoreProductSchema>;

/** Every product the Store API answered a page with. */
export const StoreProductsSchema = z.array(StoreProductSchema);

/**
 * A price in minor units, written as the decimal our own contract carries, or
 * null where the shop sent something that is not a price at all.
 *
 * The scale is read rather than assumed, which is the whole of this function.
 * Null rather than a fallback for anything unreadable: every alternative to
 * null here is a number that ends up on a card somebody sells at, and a price
 * we invented is worse than a product we did not import.
 *
 * Nothing is rounded and nothing is parsed into a floating point number on the
 * way through. The digits the shop sent are the digits that come out, with a
 * dot moved into them — which is what keeps `"0.10"` from becoming
 * `"0.1000000000000000055"`.
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

/**
 * The decimal places this connector sells at: a US dollar's two. It is the
 * `currency_minor_unit` the Store API has to answer for a product to be
 * imported, and both that and the decimals WooCommerce writes an order's
 * totals at come from one setting of the shop's, its number of decimals.
 */
export const USD_SCALE = 2;

/**
 * A price the way WooCommerce stores what a merchant typed: digits, or digits,
 * a dot and more digits, where the digits before the dot may be missing.
 * WooCommerce keeps ".99" as typed and drops a trailing dot, so "5." never
 * arrives and is not a price here either.
 */
export const TYPED_PRICE = /^(?=\.?\d)(\d*)(?:\.(\d+))?$/;

/**
 * A price as a merchant typed it into WooCommerce, written at two decimal
 * places, or null where that would take rounding or the text is not a decimal.
 *
 * WooCommerce keeps a product's price the way it was typed — it turns the
 * shop's decimal separator into a dot and pads nothing — so `wc/v3` answers
 * `"25"` and `"19.9"` for prices the Store API and every order total write as
 * twenty-five and nineteen dollars ninety. The card, the quote and the order
 * are compared with those totals character for character, so this is the one
 * form they all carry.
 *
 * Padding is exact, and so are writing the zero a merchant left off before
 * the dot, dropping a leading zero and dropping a zero past the second place. Dropping any other digit is rounding, and a rounded price is a
 * price the merchant did not set, which is why `"25.001"` is null rather than
 * `"25.00"`.
 */
export const usdAmountOf = (typed: string): string | null => {
  const written = TYPED_PRICE.exec(typed);
  if (written === null) {
    return null;
  }
  // Leading zeros go, and a whole part left empty — "0.99", or ".99" as it
  // was typed — is the zero it stands for, exactly.
  const whole = (written[1] ?? "").replace(/^0+/, "") || "0";
  const fraction = written[2] ?? "";
  if (/[1-9]/.test(fraction.slice(USD_SCALE))) {
    return null;
  }
  return `${whole}.${fraction.slice(0, USD_SCALE).padEnd(USD_SCALE, "0")}`;
};

/**
 * The named references WordPress writes into a Store API product.
 *
 * WooCommerce sends a product's name and prose through wptexturize,
 * convert_chars and wp_kses_post. The first two write what they produce as
 * numbers — an apostrophe as `&#8217;`, an ampersand as `&#038;` — which the
 * arithmetic below reads whatever the character is. Names come from what the
 * merchant stored. WordPress's own editor writes characters as themselves
 * except `&amp;`, `&lt;`, `&gt;` and `&nbsp;`; the dash, quotation mark and
 * ellipsis names in this table come from HTML pasted in or written by hand.
 * wp_kses_post lets any other name on HTML 4's list through, so one missing
 * here (`&eacute;` typed by hand) reaches the card as it was written: visible,
 * and never guessed at.
 *
 * A table and not a dependency: a decoder with HTML's whole list would be one
 * more package in the cabinet for names no shop we have read sends. The day
 * one does, that package is the smaller change.
 */
const NAMED_CHARACTERS: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
};

/**
 * The elements a browser puts on a line of their own.
 *
 * Everything not on this list is inline and leaves no gap behind it. The list
 * is short because the mistake it prevents is one-directional: a block element
 * missing from it joins two sentences into one word, which a reader notices,
 * while an inline element wrongly on it leaves a space before a comma, which
 * nobody does.
 */
const BREAKS_THE_LINE = new Set([
  "p",
  "div",
  "br",
  "hr",
  "li",
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "tr",
  "td",
  "th",
  "table",
  "thead",
  "tbody",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "section",
  "article",
  "header",
  "footer",
  "figure",
  "figcaption",
]);

/**
 * A shop's prose as text: the markup gone, the entities put back, the
 * whitespace collapsed.
 *
 * The two blocks that are removed whole rather than unwrapped are the ones a
 * browser does not show either — a `<script>` and a `<style>` — so stripping
 * only their tags would put a stylesheet into the description of a product.
 *
 * Whitespace is collapsed because a card's description is read by a program and
 * displayed in a catalogue, where the paragraphs of a shop page have nowhere to
 * go; what would otherwise cross is the newline the editor put between two
 * `<p>` elements, counted against the length limit as a character the merchant
 * cannot see.
 */
export const plainTextOf = (html: string): string => {
  const withoutHiddenBlocks = html.replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    // A space, so that "a<style>…</style>b" does not become one word.
    " ",
  );
  const withoutTags = withoutHiddenBlocks.replace(
    /<\/?([a-z][a-z0-9]*)\b[^>]*>/gi,
    // A tag that ends a line becomes a space and a tag inside a line becomes
    // nothing, because the two are not the same edit. "code <em>by email</em>."
    // with every tag spaced out reads "code by email ." — a space before a full
    // stop, in prose a stranger's agent is about to read.
    (_whole: string, name: string) => (BREAKS_THE_LINE.has(name.toLowerCase()) ? " " : ""),
  );
  const decoded = withoutTags.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole: string, name: string) => {
      if (name.startsWith("#x") || name.startsWith("#X")) {
        return codePoint(Number.parseInt(name.slice(2), 16)) ?? whole;
      }
      if (name.startsWith("#")) {
        return codePoint(Number.parseInt(name.slice(1), 10)) ?? whole;
      }
      return NAMED_CHARACTERS[name.toLowerCase()] ?? whole;
    },
  );
  return decoded.replace(/\s+/g, " ").trim();
};

/** One character from its number, or null where that number is not one. */
const codePoint = (value: number): string | null => {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) {
    return null;
  }
  try {
    return String.fromCodePoint(value);
  } catch {
    return null;
  }
};

/** One product turned into a card, with the product it came from named. */
export interface ImportedCard {
  /** The shop's own identifier, which is the card's `merchant_item_id`. */
  readonly id: string;
  /** What the merchant sees this product called in their shop. */
  readonly title: string;
  readonly card: CardInput;
}

/** One product that stayed in the shop, and the reason in words. */
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
 * What the agent is handed when the sale goes through.
 *
 * One field, and it is the one fact a buyer can act on afterwards: the number
 * the shop itself put on their order. With it they can ask the merchant about
 * the order, and the merchant can find it on the screen they already use. A
 * card has to declare at least one field that always arrives, and inventing a
 * second one we might not be able to fill would be a promise made on the
 * merchant's behalf.
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
 * The cards a shop's catalogue becomes, and the products that stayed behind.
 *
 * Order is preserved so that a merchant reading the two lists against their own
 * catalogue screen reads them in the same order.
 */
export const cardsFromTheShop = (
  products: readonly StoreProduct[],
  shopOrigin = "https://shop.example.com",
): ImportedCatalogue => {
  const cards: ImportedCard[] = [];
  const skipped: SkippedProduct[] = [];

  for (const product of products) {
    const id = String(product.id);
    const title = plainTextOf(product.name);
    // The shop's own name for the product where there is one, so that a line
    // about a product nobody could map names it the way the merchant knows it.
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
    if (!product.virtual) {
      refused("Only virtual products can be delivered to an agent without a shipping address.");
      continue;
    }
    if (!product.downloadable) {
      refused("This product has no WooCommerce download to deliver to the agent.");
      continue;
    }
    if (product.manage_stock) {
      refused("Products whose stock is counted are not supported by this connector.");
      continue;
    }
    if (product.download_limit !== -1 || product.download_expiry !== -1) {
      refused("The download must have unlimited uses and no expiry.");
      continue;
    }
    if (product.downloads.length !== 1) {
      refused("The product must carry exactly one downloadable file.");
      continue;
    }

    if (product.prices.currency_code !== "USD") {
      refused(
        `The shop prices this product in ${JSON.stringify(product.prices.currency_code)}, and` +
          " this connector sells in US dollars only.",
      );
      continue;
    }
    if (product.prices.currency_minor_unit !== USD_SCALE) {
      // Named as the setting rather than as the prices: a whole-dollar shop
      // that retyped every price with cents would be refused exactly the same.
      refused(
        `The shop's catalogue writes prices with ${product.prices.currency_minor_unit} decimal` +
          ` places, and this connector sells at ${USD_SCALE}. Set WooCommerce → Settings → General →` +
          ` Number of decimals to ${USD_SCALE}; if it already is, something in the shop is` +
          " changing the decimals its catalogue is written at.",
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
    const currency = product.prices.currency_code;
    if (!CurrencyCodeSchema.safeParse(currency).success) {
      refused(
        `The shop prices this product in ${JSON.stringify(currency)}, which is not a currency` +
          " code we can put on a card.",
      );
      continue;
    }

    if (title === "") {
      refused("The product has no name in the shop, and a card is found by its title.");
      continue;
    }
    const merchantItemId = merchantItemIdFor(shopOrigin, id);
    if (!IdentifierSchema.safeParse(merchantItemId).success) {
      refused("The shop's own identifier for this product is not one a card can be keyed by.");
      continue;
    }

    const description = firstProseOf(product);
    if (description === "") {
      refused(
        "The shop's page for this product has no description. A card carries one, because it is" +
          " what an agent reads before it decides to buy.",
      );
      continue;
    }

    cards.push({
      id,
      title,
      card: {
        merchant_item_id: merchantItemId,
        title,
        description,
        price: { amount, currency },
        result: { ...WHAT_THE_BUYER_RECEIVES },
        fulfillment: "async",
        price_check: "handler",
      },
    });
  }

  return { cards, skipped };
};

/** A card key that cannot silently switch shops when two shops share product id 42. */
export const merchantItemIdFor = (shopOrigin: string, productId: string): string => {
  const origin = new URL(shopOrigin).origin.toLowerCase();
  const fingerprint = createHash("sha256").update(origin).digest("hex").slice(0, 16);
  return `woo_${fingerprint}_${productId}`;
};

/** The Woo product behind a card, only when the card is bound to this shop. */
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
 * The prose a card's description is taken from.
 *
 * The long description first, because that is the field a shop writes what the
 * buyer actually gets into, and the short one after it — a shop that put
 * everything in the excerpt is a shop whose products would otherwise all be
 * refused for having no description at all.
 */
const firstProseOf = (product: StoreProduct): string => {
  const long = plainTextOf(product.description);
  return long === "" ? plainTextOf(product.short_description) : long;
};
