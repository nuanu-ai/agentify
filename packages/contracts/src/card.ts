/**
 * One product, in the shapes it has: the card the merchant publishes, the card
 * an agent reads in a catalog, the listing a discovery catalog reads, and the
 * card its own merchant reads back.
 *
 * Everything an agent sees is drawn from the published card, so an agent
 * holding only the card it read has to be able to assemble a correct purchase
 * and know what it will get back. The catalog identifier is not part of the
 * published card: it is issued at publication and handed back in the result.
 */

import { z } from "zod";
import type { FieldSpec, ParamSpec, ParamSpecInput, ParamType } from "./param-spec.js";
import {
  FieldSpecSchema,
  ParamNameSchema,
  ParamSpecSchema,
  paramSpecToValidator,
} from "./param-spec.js";
import { notPlainTextIn, type TextLines } from "./plain-text.js";
import { SMALLEST_PRICE } from "./price-rule.js";
import type { Money } from "./primitives.js";
import { IdentifierSchema, MoneySchema, OpenWordSchema, TimestampSchema } from "./primitives.js";
import { SellerSiteSchema } from "./seller-site.js";
import { SellingStateSchema } from "./selling.js";
import { type ShipTo, ShipToSchema } from "./ship-to.js";
import { ShipmentSchema } from "./shipment.js";

/**
 * When the product reaches the agent, and so when the money moves.
 *
 * `sync`: in the answer to the purchase, and the payment executes last, after
 * the merchant has delivered. `async`: later, by a separate call, with payment
 * at the moment of purchase. `ship`: a parcel the merchant hands to a carrier, with payment at the moment
 * of purchase; the order carries the buyer's address until the merchant takes
 * it on, or it ends without them.
 */
export const FulfillmentSchema = z
  .enum(["sync", "async", "ship"], {
    error: 'fulfillment is "sync", "async" or "ship" — or left out, which is "sync"',
  })
  .meta({
    description:
      'When the product reaches the agent, and so when the money moves. "sync" — in the answer to the purchase, payment last. "async" — later, by a separate call, payment at the moment of purchase. "ship" — a parcel the merchant hands to a carrier, payment at the moment of purchase; the purchase carries the address it goes to.',
  });

/** The longest a parcel's card may give its merchant to hand it to a carrier: thirty days. */
const SHIP_WITHIN_AT_MOST_SECONDS = 2_592_000;

/**
 * How the price and availability of this card are asked for at purchase.
 * `"handler"` is the one way: the question travels the same outgoing channel
 * as the orders to the merchant's price handler, registered with
 * `on('quote')`. A price hook at an address of the merchant's own is not
 * called, so a card naming one is refused rather than quietly selling at its
 * listed price.
 */
export const PriceCheckSchema = z.literal("handler", {
  error:
    "price_check is \"handler\": the price is asked of your own price handler, registered with on('quote') in the process that answers your orders. A price hook at an address of yours is not called yet, so a card cannot name one",
});

/**
 * The words for a required field a card left out, in place of the validation
 * library's "expected string, received undefined".
 */
const leftOut =
  (sentence: string) =>
  (issue: { readonly input?: unknown }): string | undefined =>
    issue.input === undefined ? sentence : undefined;

/**
 * The merchant's own key for the product, the one their database uses, with
 * its own sentence for a card that left it out.
 */
const MerchantItemIdSchema = z.preprocess((value, ctx) => {
  if (value === undefined) {
    ctx.addIssue({
      code: "custom",
      message:
        "a card names its merchant_item_id: your own key for the product, the one your database uses",
    });
    return z.NEVER;
  }
  return value;
}, IdentifierSchema);

/** The short line a catalog shows; how the card differs from its neighbours. */
const TitleSchema = z
  .string({ error: leftOut("a card names its title: the short line a catalog shows") })
  .regex(/\S/, "a title must not be empty or blank");

/**
 * The longest a listed word may be, and the most tags a listing keeps: the
 * discovery catalog's own limits, read off its code. Past them it drops the
 * value without telling anybody, so they are enforced here, where the merchant
 * is told.
 */
const LISTED_TEXT_MAX = 32;
const LISTED_TAGS_MAX = 5;

/**
 * A word the discovery catalog can render: printable ASCII only, which is what
 * the catalog's own check allows. A seller whose name is written in Cyrillic,
 * Greek or Arabic cannot be listed under it, and the name is refused rather
 * than listed mangled.
 */
const listedText = (what: string) =>
  z
    .string()
    .min(1, `a ${what} must not be empty`)
    .max(LISTED_TEXT_MAX, `a ${what} is at most ${LISTED_TEXT_MAX} characters`)
    .regex(/^[\x20-\x7e]*$/, `a ${what} is printable ASCII, which is all the listing carries`)
    // Blank and padded in one rule. A space at either end survives the listing
    // and makes two spellings of one word that look identical.
    .regex(/^\S(?:[\s\S]*\S)?$/, `a ${what} must not be blank or padded with spaces`);

/**
 * The name a merchant sells under, wherever a catalog names a seller rather
 * than a product. It belongs to the merchant, not to any one card; this schema
 * is the rule, applied wherever the name is written.
 */
export const ServiceNameSchema = listedText("service name")
  .superRefine((name, ctx) => {
    // Every agent reads the name on every card and order of the merchant's, so
    // it is held to the card's plain-text rule: markup and character references
    // are refused and named, not cleaned.
    for (const phrase of notPlainTextIn(name, "one line")) {
      ctx.addIssue({
        code: "custom",
        message: `this service name carries ${phrase}, and a service name is plain text, which an agent reads exactly as it is written`,
      });
    }
  })
  .meta({
    description:
      "The name a seller is listed under in a discovery catalog and shown to every agent beside their products. At most 32 characters of printable ASCII, because that is what the catalog carries; a name outside that is refused here rather than truncated there, where nobody would be told. It is plain text: HTML markup and character references such as &amp; are refused, and an ampersand written as text passes.",
  });

/**
 * The name as it is stored and read back: every rule a publish holds it to
 * except plain text. That rule is applied where the name is written, not where
 * it is read, so one stored name carrying markup cannot fail every card and
 * order of its merchant.
 */
const StoredServiceNameSchema = listedText("service name");

/**
 * Who sells, as an agent reads it beside a product and on an order: the name
 * the merchant sells under and the site of their shop. Both are the merchant's
 * own word and nothing checked either. Null means none given; a name is
 * missing only from an order whose merchant has since lost it.
 */
export const SellerSchema = z
  .strictObject({
    name: StoredServiceNameSchema.nullable(),
    site: SellerSiteSchema.nullable(),
  })
  .meta({
    description:
      "Who sells: the name the merchant sells under and the https address of their shop's own site, both as the merchant gave them. Agentify did not check either, so a name and a site can be anybody's. The site is where to take what an order cannot answer — a parcel that did not arrive, a return, the shop's terms. Either is null where the merchant has given none.",
  });

export type Seller = z.infer<typeof SellerSchema>;

/**
 * The words a merchant puts on one product so an agent searching a discovery
 * catalog can find it: at most five, because the catalog keeps the first five
 * and drops the rest without a word.
 */
export const TagsSchema = z
  .array(listedText("tag"))
  // Not an empty list: the catalog drops an empty list and a missing field
  // alike, so a card with no tags leaves the field out.
  .min(1, "a card that names no tags leaves the field out rather than sending an empty list")
  .max(LISTED_TAGS_MAX, `a card carries at most ${LISTED_TAGS_MAX} tags`)
  .refine(
    // The catalog folds tags together regardless of case and keeps the first,
    // without telling the merchant which survived.
    (tags) => new Set(tags.map((tag) => tag.toLowerCase())).size === tags.length,
    "two tags that differ only in case are one tag to the listing, so both cannot be published",
  )
  .meta({
    description:
      "Words describing this product for an agent searching a discovery catalog. Between 1 and 5 of them, each 1 to 32 characters of printable ASCII with no space at either end, and no two the same without regard to case — because that is what the catalog keeps, and it drops the rest in silence. A card with no tags leaves the field out.",
    // zod drops the case rule from the rendered document; this keeps at least
    // the identical pair refused by a generated client.
    uniqueItems: true,
  });

/**
 * The longest description a discovery catalog carries whole. Unlike the
 * listing name and tag limits, this one is taken from the catalog's written
 * documentation rather than from code of theirs that enforces it, so it is
 * honoured, not verified.
 */
const LISTED_DESCRIPTION_MAX = 500;

/**
 * What the buyer gets, what it is good for and what it does not include, read
 * by a program. It is the one field of prose that goes out to a discovery
 * catalog, so the catalog's limit is enforced here, at publication.
 *
 * The refusal states the actual length and whose ceiling it is. The length is
 * counted in UTF-16 units, the unit the ceiling is measured in, so an emoji
 * counts as two and the number the merchant is told is always the number they
 * were refused for.
 */
const DescriptionSchema = z
  .string({
    error: leftOut(
      "a card names its description: what the buyer gets, what it is good for, and what is not included",
    ),
  })
  .regex(/\S/, "a description must not be empty or blank")
  .max(LISTED_DESCRIPTION_MAX, {
    // zod reaches a length check only once the value is a string, so `input`
    // is always one here.
    error: (issue) =>
      `this description is ${String(issue.input).length} characters and a listing carries at` +
      ` most ${LISTED_DESCRIPTION_MAX} — the ceiling is the one the discovery catalog documents,` +
      " not ours and not the payment protocol's",
  });

/**
 * What the agent receives when the delivery goes through: at least one field,
 * and at least one that is not `required: false`, since a declaration that may
 * arrive empty tells the agent nothing about what it is paying for. The rule
 * is also written into the metadata as `minProperties`, because zod drops
 * refinements from the JSON Schema it renders.
 *
 * The published card and the agent's reading of it share this one rule, so
 * what the agent reads before paying is what the merchant is held to after.
 */
const declaringAResult = <Declaration extends z.ZodType<Record<string, FieldSpec>>>(
  declaration: Declaration,
) =>
  declaration
    .refine(
      // At least one field that actually arrives, not merely one field.
      (spec) => Object.values(spec).some((field) => field.required !== false),
      "a card declares at least one field of what the agent receives, and at least one of them arrives every time",
    )
    .meta({
      description:
        "What the agent receives on delivery. At least one field, and at least one of the fields is not marked required: false — a result that might be entirely absent promises nothing.",
      minProperties: 1,
    });

const DeclaredResultSchema = declaringAResult(ParamSpecSchema);

/**
 * A declaration as an agent reads it: each field open to attributes added
 * later, so a new attribute leaves the card readable to an agent built before
 * it.
 */
const ReadDeclarationSchema = z.record(ParamNameSchema, FieldSpecSchema.loose());

/**
 * The short forms a card may be written in at publication, and the one form
 * they all become.
 *
 * A price may be one string, `"5.00 USD"`; a declared field may be its type
 * word alone, `access_url: 'string'`; and `fulfillment` may be left out. Each
 * belongs to its field, so a card may mix short and long freely. They are
 * opened out into the canonical card while it is parsed, so everything stored,
 * read or projected is built from the one canonical shape, and a short form
 * neither widens nor narrows what a card may say.
 */

/** A price written as one string: the amount, one space, the currency code. */
const PRICE_WRITTEN_SHORT = /^(\S+) (\S+)$/;

/** What a card that names no price is told. */
const PRICE_LEFT_OUT =
  'a card names its price, the one an agent compares while choosing: the amount and the currency, as "5.00 USD" or { amount: "5.00", currency: "USD" }';

/** What a price in neither form is told; it shows both, since "5.00" or "USD" alone does not say which was meant. */
const PRICE_EXPECTED =
  'a price is either the amount and the currency as one string, "5.00 USD", or the two written out, { amount: "5.00", currency: "USD" }';

/**
 * A card's price: the two fields, or the one string that becomes them. The
 * string is opened out before `MoneySchema` runs rather than offered as a
 * union, because a union would answer a half-wrong price with "invalid input"
 * instead of naming the half that is wrong.
 */
const CardPriceSchema = z.preprocess((value, ctx) => {
  if (value === undefined) {
    ctx.addIssue({ code: "custom", message: PRICE_LEFT_OUT });
    return z.NEVER;
  }
  if (typeof value !== "string") return value;

  const written = PRICE_WRITTEN_SHORT.exec(value);

  if (written === null) {
    ctx.addIssue({ code: "custom", message: PRICE_EXPECTED });
    // The canonical check would only add "expected object, received string"
    // under this sentence; the rest of the card is still checked.
    return z.NEVER;
  }

  return { amount: written[1], currency: written[2] };
}, MoneySchema);

/** A record with names on it, as against an array, a null or a bare value. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A declaration with every field written out: `access_url: 'string'` becomes
 * `access_url: { type: 'string' }`, and anything else passes through for the
 * canonical schema to judge. It builds a new object with `Object.fromEntries`,
 * which defines rather than assigns, so the caller's object is untouched and a
 * key named `__proto__` cannot set a prototype here.
 */
const declarationWrittenOut = (value: unknown): unknown =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).map(([name, field]) => [
          name,
          typeof field === "string" ? { type: field } : field,
        ]),
      )
    : value;

/**
 * The same declaration, also accepting a field written as its type alone. It
 * takes the schema as an argument because the purchase parameters and the
 * delivery result are held to different rules.
 */
const writtenShort = <Declaration extends z.ZodType>(declaration: Declaration) =>
  z.preprocess(declarationWrittenOut, declaration);

const CardFieldsSchema = z
  .strictObject({
    /** The merchant's own key for this product, the one their database uses. */
    merchant_item_id: MerchantItemIdSchema,

    title: TitleSchema,

    description: DescriptionSchema,

    /**
     * The price in the catalog, what the agent compares when choosing; required
     * even on a card with a price check. Written as the two fields or as one
     * string, and always stored as the two fields.
     *
     * Publishing also holds it to the price rule in `price-rule.ts`, outside this
     * schema so that a stored card stays readable.
     */
    price: CardPriceSchema.meta({
      description: `Publishing refuses a price below ${SMALLEST_PRICE}, zero included, a price not in USD or USDC, and one written with fewer than two or more than six digits after the dot ("5.00", "0.015"), so that a price the catalog shows is one a payment can be taken at. On a "ship" card it is the goods without shipping or a tax that depends on the buyer's place: the price a purchase goes through at is the merchant's price handler's answer, which includes shipping to the buyer's place and that tax.`,
    }),

    /** What the agent has to supply to buy. Absent when the purchase needs no input. */
    params: writtenShort(ParamSpecSchema).optional(),

    /**
     * What the agent receives. Every card declares it except a parcel's, whose
     * mode fixes it: the record of the parcel's shipment.
     */
    result: writtenShort(DeclaredResultSchema).optional(),

    /**
     * Words for an agent searching a discovery catalog. Absent on a card whose
     * merchant named none, and never invented for them.
     */
    tags: TagsSchema.optional(),

    /**
     * When the product reaches the agent, and so when the money moves. A card
     * that names no mode is `sync`, and the default is filled in here so that
     * every reader of the card sees the word.
     */
    fulfillment: FulfillmentSchema.default("sync"),

    price_check: PriceCheckSchema.optional(),

    /** How long the merchant may take to deliver an order it has accepted. */
    fulfill_deadline_seconds: z.int().positive().optional(),

    /**
     * On a parcel's card, how long the merchant may take to hand it to a
     * carrier, counted from the charge, at most thirty days. It has its own name
     * because a delivery deadline would read as the time the parcel arrives.
     */
    ship_within_seconds: z.int().positive().max(SHIP_WITHIN_AT_MOST_SECONDS).optional(),
  })
  .meta({
    // Refinements keep publication errors specific; metadata carries the same mode rules to JSON Schema.
    allOf: [
      {
        if: { properties: { fulfillment: { const: "ship" } }, required: ["fulfillment"] },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema names its conditional branch "then".
        then: {
          required: ["ship_within_seconds", "price_check"],
          properties: {
            result: false,
            fulfill_deadline_seconds: false,
            params: { type: "object", not: { required: ["ship_to"] } },
          },
        },
        else: { required: ["result"], properties: { ship_within_seconds: false } },
      },
      {
        if: { properties: { fulfillment: { const: "sync" } }, required: ["fulfillment"] },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema names its conditional branch "then".
        then: { properties: { fulfill_deadline_seconds: false } },
      },
    ],
  } satisfies z.core.JSONSchema.BaseSchema);

/**
 * The rules between a card's fields. Every deadline is shown to the agent
 * before it pays, so a card may carry only the ones its own mode uses; a
 * synchronous card names none, since its wait is a budget the same for every
 * product.
 */
const cardRules = (card: z.output<typeof CardFieldsSchema>, ctx: z.RefinementCtx): void => {
  if (card.fulfillment === "ship") {
    parcelRules(card, ctx);
    return;
  }

  if (card.ship_within_seconds !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["ship_within_seconds"],
      message: `only a card with fulfillment "ship" hands its goods to a carrier and names a time to ship; this one is "${card.fulfillment}"`,
    });
  }

  if (card.result === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["result"],
      message:
        'result is required: a card declares what the agent receives, and only a parcel\'s, fulfillment "ship", leaves that to its mode',
    });
  }

  if (card.fulfillment === "sync" && card.fulfill_deadline_seconds !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["fulfill_deadline_seconds"],
      message:
        'a synchronous card delivers inside the system-wide response budget and sets no delivery deadline; "async" does',
    });
  }
};

/**
 * What a parcel's card is held to, beside what every card is. The time to ship
 * is required because it is the one promise the agent gets about when the
 * goods leave. A declared result is refused because the mode fixes it, and a
 * delivery deadline because it would read as the time the parcel arrives. The
 * price is asked of the merchant's handler, as shipping depends on where the
 * parcel goes, and the address travels in its own block rather than as a
 * parameter.
 */
const parcelRules = (card: z.output<typeof CardFieldsSchema>, ctx: z.RefinementCtx): void => {
  if (card.ship_within_seconds === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["ship_within_seconds"],
      message: `a parcel's card names ship_within_seconds, the time to hand it to a carrier counted from the charge, at most ${SHIP_WITHIN_AT_MOST_SECONDS} (thirty days)`,
    });
  }
  if (card.result !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["result"],
      message:
        "a parcel's card declares no result: its mode fixes what the agent receives, the record of the parcel's shipment",
    });
  }
  if (card.fulfill_deadline_seconds !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["fulfill_deadline_seconds"],
      message:
        "a parcel's card names the time to ship, ship_within_seconds, and no delivery deadline: under that name the number would read as the time the parcel arrives",
    });
  }
  if (card.price_check !== "handler") {
    ctx.addIssue({
      code: "custom",
      path: ["price_check"],
      message:
        "a parcel's price is asked of the merchant's own price handler, price_check: \"handler\", whose answer is the whole price with shipping and any tax for the buyer's place",
    });
  }
  if (card.params !== undefined && "ship_to" in card.params) {
    ctx.addIssue({
      code: "custom",
      path: ["params", "ship_to"],
      message:
        "a parcel's card asks for no ship_to among its parameters: the address travels in a block of its own beside them",
    });
  }
};

// The mode conditions are also rendered structurally through CardFieldsSchema's metadata.
const CARD_RULES_IN_WORDS =
  'fulfill_deadline_seconds is only allowed when fulfillment is "async" — a synchronous card delivers inside the system-wide response budget and names no deadline of its own. result is required on every card except one whose fulfillment is "ship". A "ship" card, a parcel, names ship_within_seconds and is the only card that may; it declares no result and no fulfill_deadline_seconds, its price_check is "handler", and it asks for no ship_to among its params, because the purchase carries the address in a block of its own.';

/**
 * One piece of a card's own words: where a finding about it points, what the
 * finding calls it, and whether it is one line.
 */
interface Words {
  readonly path: readonly string[];
  readonly text: string;
  readonly called: "title" | "description";
  readonly lines: TextLines;
}

/**
 * The words on a card that an agent reads: the title, the description, and the
 * title of each declared field. It reads whatever arrived, because the
 * plain-text rule runs beside the shape checks so that one publish reports
 * both; anything not where a card keeps its words is left to the shape check.
 */
const wordsOf = (card: unknown): Words[] => {
  if (!isRecord(card)) return [];

  const words: Words[] = [];
  if (typeof card.title === "string") {
    words.push({ path: ["title"], text: card.title, called: "title", lines: "one line" });
  }
  if (typeof card.description === "string") {
    words.push({
      path: ["description"],
      text: card.description,
      called: "description",
      lines: "several lines",
    });
  }
  for (const declaration of ["params", "result"] as const) {
    const fields = card[declaration];
    if (!isRecord(fields)) continue;
    for (const [name, field] of Object.entries(fields)) {
      if (isRecord(field) && typeof field.title === "string") {
        words.push({
          path: [declaration, name, "title"],
          text: field.title,
          called: "title",
          lines: "one line",
        });
      }
    }
  }
  return words;
};

/**
 * A finding for each kind of thing in the card's words that is not plain text
 * (see `plain-text.ts`), naming the field, what was found and where, so the
 * merchant can find it in their own editor.
 */
const plainWords = (card: unknown, ctx: z.RefinementCtx): void => {
  for (const words of wordsOf(card)) {
    const heldTo =
      words.lines === "one line"
        ? `a ${words.called} is plain text on one line`
        : `a ${words.called} is plain text`;
    for (const phrase of notPlainTextIn(words.text, words.lines)) {
      ctx.addIssue({
        code: "custom",
        path: [...words.path],
        message: `this ${words.called} carries ${phrase}, and ${heldTo}, which an agent reads exactly as it is written`,
      });
    }
  }
};

const PLAIN_TEXT_IN_WORDS =
  "The title, the description and the title of every declared field are plain text, which an agent reads exactly as it is written: a card is refused where one of them carries HTML markup (a tag, or the opening of a comment), an HTML character reference such as &amp; or &#8217;, or a control character, and a description alone may carry line feeds. An ampersand, a comparison or an arrow written as text passes.";

/**
 * The card as it is stored and as its merchant reads it back: every rule a
 * publish holds it to except plain text, which is applied when a card is
 * written. Held on reading, it would let one stored card carrying markup fail
 * the merchant's whole list and the catalog page it sits on.
 */
const StoredCardSchema = CardFieldsSchema.superRefine(cardRules).meta({
  description: `A product in the catalog, as it is stored and as its merchant reads it back. ${CARD_RULES_IN_WORDS} The requirement for at least one result field that arrives every time and case-insensitive tag uniqueness remain runtime checks described on their fields. A publish also holds the title, the description and each declared field's title to plain text; reading a card back does not, so a card stored before that rule is read back exactly as it was stored.`,
});

/**
 * A card as a merchant publishes it. The plain-text rule runs whatever else is
 * wrong, so markup is reported in the same answer as the rest; the rules
 * between fields run only once the shape is right.
 */
export const CardSchema = CardFieldsSchema.superRefine(cardRules)
  .superRefine(plainWords, { when: () => true })
  .meta({
    description: `A product in the catalog, as the merchant publishes it. ${CARD_RULES_IN_WORDS} ${PLAIN_TEXT_IN_WORDS} Plain text, case-insensitive tag uniqueness and the requirement for at least one result field that arrives every time remain runtime checks described here or on their fields. This document describes the canonical card, the form every card is stored and read back in, rather than all publication spellings. price may also be written at publication as one string, the amount and the currency code with a single space between them ("5.00 USD"). A field of params or result may be written as its type word alone (access_url: "string") where it carries no title and no required flag. fulfillment may be left out, and a card that leaves it out is "sync". Each of those is opened out into the form below as the card is accepted. The canonical form requires no short-form expansion, and a card read back is always in this form.`,
  });

export type Fulfillment = z.infer<typeof FulfillmentSchema>;
export type PriceCheck = z.infer<typeof PriceCheckSchema>;
export type Card = z.infer<typeof CardSchema>;

/**
 * What every card is written with at publication, whatever its mode. It is
 * written by hand because zod cannot infer it, but every field not named here
 * is taken from `Card`, so a field added to a card appears here too.
 */
interface CardInputFields
  extends Omit<
    Card,
    | "price"
    | "params"
    | "result"
    | "fulfillment"
    | "price_check"
    | "fulfill_deadline_seconds"
    | "ship_within_seconds"
  > {
  /** `{ amount, currency }`, or the two as one string: `'5.00 USD'`. */
  price: Money | string;
  /** Each field whole, or written as its type word alone: `email: 'string'`. */
  params?: ParamSpecInput;
}

/** A card whose goods are delivered to the agent, in the answer or later. */
interface DeliveredCardInput extends CardInputFields {
  /**
   * What the agent receives on delivery, each field whole or written as its
   * type word alone: `access_url: 'string'`.
   */
  result: ParamSpecInput;
  price_check?: PriceCheck;
  /** Only a parcel's card names a time to hand it to a carrier. */
  ship_within_seconds?: never;
}

/** A card paid for at the purchase and delivered later, by a separate call. */
interface AsyncCardInput extends DeliveredCardInput, Pick<Card, "fulfill_deadline_seconds"> {
  fulfillment: "async";
}

/** A parcel the merchant hands to a carrier, paid for at the purchase. */
interface ShipCardInput extends CardInputFields {
  fulfillment: "ship";
  /** What the agent receives is fixed by the mode: the record of the parcel's shipment. */
  result?: never;
  /** The price includes shipping to the buyer's place, so it is asked of the price handler. */
  price_check: "handler";
  /** How long the merchant may take to hand the parcel to a carrier, counted from the charge. */
  ship_within_seconds: number;
  /** A parcel names the time to ship instead, since a deadline would read as when it arrives. */
  fulfill_deadline_seconds?: never;
}

// Declared after the other modes on purpose: the compiler explains a card that
// fits none of them against the last one declared, and a card that names no
// mode is most likely this one, missing its result.
/** A card delivered in the answer to the purchase. */
interface SyncCardInput extends DeliveredCardInput {
  /** Left out, a card is delivered in the answer to the purchase. */
  fulfillment?: "sync";
  /** Delivered inside the response budget every card shares, so it names no deadline of its own. */
  fulfill_deadline_seconds?: never;
}

/**
 * A card as a merchant may write it for publication, before the short forms
 * are opened out. Nothing is ever read back in this shape; `Card` is what
 * everything else uses.
 *
 * It is one shape per mode, chosen by `fulfillment`, so the compiler refuses
 * what publishing would refuse between the mode and the other fields: a card
 * delivered to the agent declares a `result` and a parcel declares none, only
 * a parcel names `ship_within_seconds` and a parcel's `price_check` is
 * `"handler"`, and only an `"async"` card names `fulfill_deadline_seconds`. What a type
 * cannot say, such as the price rule, plain text, or a parcel asking for
 * `ship_to` among its parameters, is refused at publication and named in the
 * refusal.
 *
 * A `Card` read back is not split by mode, so it is not a `CardInput` as it
 * stands. Publication takes a card read back unchanged, but TypeScript code
 * republishes the card it holds, or asserts the read-back one's type.
 */
export type CardInput = SyncCardInput | AsyncCardInput | ShipCardInput;

/**
 * The check an agent's purchase parameters are held to, for this card. It and
 * `deliveryCheckFor` take the card rather than a direction, so a caller cannot
 * compile a card's result as a purchase by passing the wrong word.
 */
export const purchaseCheckFor = (card: Card): z.ZodType =>
  paramSpecToValidator(card.params ?? {}, "purchase");

/**
 * The check this card's delivery is held to: the goods its `result` declared,
 * or for a parcel its shipment.
 */
export const deliveryCheckFor = (card: Card): z.ZodType =>
  card.result === undefined ? ShipmentSchema : paramSpecToValidator(card.result, "delivery");

/**
 * A card as an agent reads it in a catalog: what Agentify says about a product
 * to somebody about to spend money.
 *
 * It differs from the published card on purpose. `id`, the catalog identifier
 * every purchase, receipt and status uses, replaces the merchant's own key.
 * `purchase_url` is added: the whole address the product is bought at.
 * `price_check` becomes the single flag `price_checked_at_purchase`, which says
 * the merchant is asked, not that they answer. `as_of` is added: when the price
 * shown was published, the only freshness claim a catalog makes. `tags` are
 * left out, since they serve discovery catalogs, not this one. `seller` is the
 * merchant's name and site as they gave them, unchecked.
 *
 * The document is open: fields and fulfillment modes may be added later, and
 * a reader ignores a field it does not know and passes over a card whose mode
 * it does not know.
 */
export const PublicCardSchema = z
  .looseObject({
    /** The catalog identifier, the one a purchase, a receipt and a status use. */
    id: IdentifierSchema,

    /**
     * Where this product is bought: the whole address a purchase is sent to,
     * scheme and host included, ready to call. It is the resource the payment
     * challenge names, built from the address the gateway is configured to
     * answer as, and held to the same rule as an order's `status_url`.
     */
    purchase_url: z
      .url()
      .regex(
        /^https?:\/\//,
        "a product's purchase address is a whole http or https address, not a path",
      ),

    title: TitleSchema,

    description: DescriptionSchema,

    /** The price in the catalog: what an agent compares when it is choosing. */
    price: MoneySchema.loose(),

    /** When the price above was published. */
    as_of: TimestampSchema,

    /** What the agent has to supply to buy. Absent when the purchase needs no input. */
    params: ReadDeclarationSchema.optional(),

    /**
     * What the agent receives. Absent on a parcel, whose mode fixes it: the
     * record of the parcel's shipment.
     */
    result: declaringAResult(ReadDeclarationSchema).optional(),

    /**
     * Whether the merchant is asked for this product's price and availability
     * at the moment of purchase, so that the sale may go through at a price
     * other than the one above.
     */
    price_checked_at_purchase: z.boolean(),

    /**
     * Who sells this product, in the merchant's own words and unchecked. It is
     * read with the catalog rather than copied onto the card at publishing, so
     * a merchant who changes their name or gives a site is found by it on every
     * card they already sell.
     */
    seller: SellerSchema.loose(),

    /**
     * How the product is sold. The known values are listed for a client to
     * switch over, and any other word is accepted too, since modes may be
     * added: keep a default arm, and pass over a card whose mode you do not
     * know. A declared field's type, inside params and result, stays a closed
     * list.
     */
    fulfillment: z.union([FulfillmentSchema, OpenWordSchema]),

    /** On "async": how long the merchant has to deliver, in seconds. */
    fulfill_deadline_seconds: z.int().positive().optional(),

    /**
     * On "ship": how long the merchant has to hand the parcel to a carrier,
     * counted from the charge, in seconds. When it leaves, not when it arrives.
     */
    ship_within_seconds: z.int().positive().optional(),
  })
  .meta({
    // `as_of` means something narrower here than the same name elsewhere in
    // this contract, so the description says so to readers of the export.
    description:
      'A product an agent can buy, projected from the card its merchant published. purchase_url is the whole address it is bought at, the resource its payment challenge names: a POST there with the JSON document {"params": {...}}, holding what params declares, and on a parcel the address it goes to under ship_to beside it, is answered first with an x402 version 2 payment challenge in the PAYMENT-REQUIRED header and, sent again with the payment, with the order. as_of is when the price shown here was published, and nothing more: on a card whose price is checked at purchase it says nothing about how fresh that check will be — elsewhere in this contract the same name means the moment a live answer was true. price_checked_at_purchase says the merchant is asked for a price at the moment of purchase, not that they answer; what happens when they are silent depends on the mode and belongs to the gateway. The number above is what an agent compares when choosing and may not be what the sale goes through at. Two rules hold beyond the shape: a synchronous product names no delivery deadline, because it is delivered inside a response budget that is the same for every product on the platform; and a parcel, fulfillment "ship", names ship_within_seconds — the time to hand it to a carrier counted from the charge, not the time it arrives — and no result, because what the agent receives is the record of its shipment, while every other product names a result. On a parcel the price shown is the goods without shipping or a tax that depends on the place, and the purchase goes through at the merchant\'s answer for the whole, shipping to the buyer\'s place and that tax included. seller is who sells, as the merchant gave it: Agentify did not check the name or the site. fulfillment is a word whose known values are listed beside it, and more may be added: a reader keeps a default arm, and a card whose mode it does not know is one to pass over, not a reason to stop reading the catalog. This document and every part inside it may also gain fields; a reader ignores the ones it does not know. The type of a declared field in params and result is a closed list, and a card with a type a reader does not know is one to pass over too.',
  });

export type PublicCard = z.infer<typeof PublicCardSchema>;

/**
 * A card as `publicCardOf` builds it: the card's own fields without the open
 * schema's index signature, and a mode this version knows. An unknown field
 * written straight into the returned object is a compile error; deeper parts,
 * and the tie between a deadline and its mode, are held by the gateway's check
 * before anything is sent.
 */
export type ProjectedCard = {
  [Field in keyof PublicCard as string extends Field ? never : Field]: PublicCard[Field];
} & { readonly fulfillment: Fulfillment };

/**
 * The card as an agent reads it, built from the card the merchant published.
 *
 * Each field that is copied is named, rather than the card copied and the
 * internal fields removed, so a field added to the published card never
 * reaches agents by default. The four things the card cannot know are passed
 * in: the catalog identifier, the address it is bought at, the moment its
 * price was published, and who sells it as their merchant stands now.
 */
export const publicCardOf = (
  card: Card,
  issued: {
    readonly id: string;
    readonly purchase_url: string;
    readonly as_of: string;
    readonly seller: Seller;
  },
): ProjectedCard => {
  const common = {
    id: issued.id,
    purchase_url: issued.purchase_url,
    seller: issued.seller,
    title: card.title,
    description: card.description,
    price: card.price,
    as_of: issued.as_of,
    ...(card.params === undefined ? {} : { params: card.params }),
    ...(card.result === undefined ? {} : { result: card.result }),
    price_checked_at_purchase: card.price_check !== undefined,
  };

  switch (card.fulfillment) {
    case "sync":
      return { ...common, fulfillment: "sync" };
    case "async":
      return {
        ...common,
        fulfillment: "async",
        ...(card.fulfill_deadline_seconds === undefined
          ? {}
          : { fulfill_deadline_seconds: card.fulfill_deadline_seconds }),
      };
    case "ship":
      return {
        ...common,
        fulfillment: "ship",
        ...(card.ship_within_seconds === undefined
          ? {}
          : { ship_within_seconds: card.ship_within_seconds }),
      };
  }
};

/**
 * One card as a discovery catalog reads it: the material an x402 payment
 * challenge is assembled from, by the protocol's own library at the edge. It
 * is built, like the agent's card, by naming each field that is copied.
 *
 * The card's title is not sent: the resource block has one field of prose,
 * and the description is the one a card writes for a program to read. The
 * examples are shapes rather than facts, each declared field holding a value
 * that stands for its type, because a card carries no example values and none
 * are invented; a test holds them to the card's own checks.
 */
export interface BazaarDeclaration {
  /** The resource block: what is being paid for, and who is selling it. */
  readonly resource: {
    /** The canonical address of this resource, exactly as it was given. */
    readonly url: string;
    readonly description: string;
    readonly mimeType: string;
    readonly serviceName?: string;
    readonly tags?: readonly string[];
  };
  /** An example purchase body, in the shape this gateway takes one. */
  readonly input: Record<string, unknown>;
  /** The JSON Schema that body is held to, derived from the card's `params`. */
  readonly inputSchema: Record<string, unknown>;
  /**
   * An example of what a paid purchase answers with: the order document, with
   * the goods the card's `result` declares under `delivered` where they come in
   * the answer, and otherwise an order under way with none.
   */
  readonly output: { readonly example: Record<string, unknown> };
}

/**
 * One declared field as a value standing for its type. A string is the word
 * `string`, not an empty one, because a delivered string must carry something
 * and the example must pass the card's own delivery check.
 */
const standInFor = (type: ParamType): unknown => {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
  }
};

/** A whole declaration as an example: every field, each one standing for a type. */
const exampleOf = (spec: ParamSpec): Record<string, unknown> =>
  Object.fromEntries(Object.entries(spec).map(([name, field]) => [name, standInFor(field.type)]));

/**
 * The JSON Schema a purchase body is held to, rendered from the very check the
 * gateway runs, without the `$schema` line, which is wrong for a schema about
 * to be nested inside another.
 */
const purchaseBodySchemaOf = (card: Card): Record<string, unknown> => {
  const { $schema, ...body } = z.toJSONSchema(
    z.strictObject({
      params: purchaseCheckFor(card),
      // A parcel's purchase carries the address it goes to beside its
      // parameters, and is refused without one.
      ...(card.fulfillment === "ship" ? { ship_to: ShipToSchema } : {}),
    }),
  );
  return body as Record<string, unknown>;
};

/** Where a parcel goes in a listing's example purchase: the address schema's own example. */
const LISTED_SHIP_TO: ShipTo = ShipToSchema.parse(
  (ShipToSchema.meta()?.examples as readonly unknown[] | undefined)?.[0],
);

/**
 * The instant a listing's examples stand on: the start of the clock, rather
 * than a date that looks like one something happened on.
 */
const LISTED_INSTANT = "1970-01-01T00:00:00Z";

/**
 * What every order document carries, in a listing's example output, written as
 * every other example here is: each field standing for what goes there.
 */
const LISTED_ORDER = {
  payment_status: "paid",
  transaction: "string",
  order_id: "string",
  status_url: "string",
  price: { amount: "string", currency: "string", at: LISTED_INSTANT, as_of: LISTED_INSTANT },
  test: false,
  seller: { name: "string", site: "string" },
};

/**
 * What a paid purchase of this card answers with: the order document the
 * status route also serves. Goods that come in the answer are under
 * `delivered`; on every other card the order is under way with none, and they
 * are collected at its `status_url`. A parcel's order names the instant it has
 * to be with a carrier by and no shipment yet.
 */
const listedAnswerOf = (card: Card): Record<string, unknown> => {
  switch (card.fulfillment) {
    case "sync":
      return { ...LISTED_ORDER, status: "delivered", delivered: exampleOf(card.result ?? {}) };
    case "ship":
      return {
        ...LISTED_ORDER,
        status: "in_progress",
        delivered: null,
        shipment: null,
        ship_by: LISTED_INSTANT,
      };
    case "async":
      return { ...LISTED_ORDER, status: "in_progress", delivered: null };
  }
};

/**
 * The card as a discovery catalog reads it. The two things a card cannot know
 * are passed in: the address this resource answers at, pinned by whoever runs
 * the gateway, and the name its seller is listed under. A seller with no name
 * and a card with no tags leave those fields out, since a catalog would render
 * an empty string or list.
 */
export const bazaarDeclarationOf = (
  card: Card,
  listed: { readonly url: string; readonly serviceName: string | null },
): BazaarDeclaration => ({
  resource: {
    url: listed.url,
    description: card.description,
    mimeType: "application/json",
    ...(listed.serviceName === null ? {} : { serviceName: listed.serviceName }),
    ...(card.tags === undefined ? {} : { tags: card.tags }),
  },
  input: {
    params: exampleOf(card.params ?? {}),
    ...(card.fulfillment === "ship" ? { ship_to: LISTED_SHIP_TO } : {}),
  },
  inputSchema: purchaseBodySchemaOf(card),
  output: { example: listedAnswerOf(card) },
});

/**
 * One card as the merchant who published it reads it back: the card whole,
 * with the catalog identifier and where it stands.
 *
 * `selling` is what a purchase of this card meets right now, and `paused` says
 * whether the pause is this card's own. They differ when the merchant has
 * stopped all selling: every card then reads `selling: "paused"`, and only
 * those with `paused: true` stay paused once selling resumes, so resuming a
 * card whose `paused` is already false changes nothing until then.
 */
export const MerchantCardSchema = z
  .strictObject({
    /** The catalog identifier, the one a purchase, a receipt and a status use. */
    id: IdentifierSchema,

    /** When this version of the card was published. */
    as_of: TimestampSchema,

    /**
     * The card exactly as its merchant published it, held to the rules of a
     * stored card rather than to the publish door's.
     */
    card: StoredCardSchema,

    /** What a purchase of this card meets right now. */
    selling: SellingStateSchema,

    /** Whether the pause is this card's own, rather than the whole catalog's. */
    paused: z.boolean(),
  })
  .meta({
    description:
      'One card as the merchant who published it reads it back: the card whole, the catalog identifier we issued for it, and where it stands. selling is what a purchase of this card meets right now and is the same word the order machine is given, so a card reading "paused" refuses new orders and lets the orders already accepted play out. paused says whether the pause is this card\'s own. The two differ when the merchant has stopped all selling: every card then reads selling "paused", and only the cards with paused true are still paused once the merchant starts selling again — so a resume on a card whose paused is already false changes nothing until all selling is resumed.',
  });

export type MerchantCard = z.infer<typeof MerchantCardSchema>;
