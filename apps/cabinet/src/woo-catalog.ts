/**
 * A WooCommerce shop's own catalogue, read through its Store API and written
 * out as cards our publish door would recognise.
 *
 * The Store API is the half of WooCommerce that needs no key at all: a shop
 * serves `/wp-json/wc/store/v1/products` to anybody, out of the box, and that
 * is where the products a merchant is asking us to sell come from
 * (`docs/research/27-woo-connect-probe.md`). Nothing here talks to a shop —
 * `woo-shop.ts` does the fetching — so every decision in this file is a
 * function of a document and can be read back off a test.
 *
 * Two rules run through it.
 *
 * **A price is a number and a scale, never a number.** The Store API writes a
 * price as a string of minor units with `currency_minor_unit` beside it, so
 * `"12000"` is a hundred and twenty dollars at a scale of two and twelve
 * thousand yen at a scale of zero. `wc/v3`, which is what we create the order
 * through, writes the same price as a decimal. A converter that reads the
 * number and assumes the scale is wrong by a factor of a hundred for every
 * ordinary currency, silently, in the direction of somebody's money.
 *
 * **Nothing the merchant wrote is edited to fit.** A description too long for
 * our own catalogue is carried across whole and refused at the publish, where
 * the merchant reads the refusal in our own words and can go and shorten it in
 * their shop. Cutting it here would publish prose under their name that they
 * never wrote, and they would have no way of finding out. The same goes for a
 * product this cannot map at all: it is left out and named, rather than
 * published as something approximate.
 */

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
  if (!Number.isInteger(scale) || scale < 0) {
    return null;
  }
  if (scale === 0) {
    return minor;
  }
  const digits = minor.padStart(scale + 1, "0");
  return `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
};

/**
 * The five characters HTML has to spell out, and the one that is a space.
 *
 * Written out rather than reached for through a parser, because the whole
 * dependency tree of an HTML parser would arrive for one field of prose. What
 * this covers is what a WordPress editor actually emits; anything else in the
 * numeric forms below is covered by the arithmetic.
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
export const cardsFromTheShop = (products: readonly StoreProduct[]): ImportedCatalogue => {
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
    if (!IdentifierSchema.safeParse(id).success) {
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
        merchant_item_id: id,
        title,
        description,
        price: { amount, currency },
        result: { ...WHAT_THE_BUYER_RECEIVES },
      },
    });
  }

  return { cards, skipped };
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
