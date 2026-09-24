/**
 * Adding a product by hand: the button on the cards screen, the form, and the
 * reading of that form into a card.
 *
 * The cabinet can already publish a card on a merchant's behalf — the
 * WooCommerce import does it through the same `publishCard` call. What does not
 * exist yet is anybody to deliver an order for such a card: orders go to the
 * merchant's own handler (the SDK) or to the WooCommerce worker, and a merchant
 * who typed a card here has neither. So the whole block waits behind the one
 * switch below and is off until the backend can fulfil a hand-made card.
 *
 * The price check is not on the form: asking a price at purchase needs a
 * service of the merchant's own, which a merchant without code does not have.
 */
import type { SurfaceMode } from "@agentify/core";
import type { CardInput } from "@nuanu-ai/agentify-contracts";
import { CardSchema } from "@nuanu-ai/agentify-contracts";
import { escaped, page } from "./html.js";
import type { Viewer } from "./screens.js";

/** The one place the block is turned on for real: `true` once the backend can deliver a hand-made card. */
export const ADD_CARD_BY_HAND = false;

/**
 * Until then the block is a preview on the laptop stand (sandbox) only, so the
 * people building it can see it; on test and live it does not exist.
 */
export const addCardByHand = (mode: SurfaceMode): boolean => ADD_CARD_BY_HAND || mode === "sandbox";

/** What the merchant typed, field by field, kept to put back into the form. */
export type TypedCard = Readonly<Record<(typeof FIELDS)[number], string>>;

const FIELDS = [
  "title",
  "description",
  "merchant_item_id",
  "price_amount",
  "price_currency",
  "result",
  "params",
  "tags",
  "fulfillment",
  "fulfill_hours",
] as const;

/**
 * One sentence per field, said whatever the schema's own wording was. The
 * schema speaks to a developer; the person at this form needs to know which
 * box to change and what goes in it.
 */
const FIELD_PROBLEMS: Readonly<Record<string, string>> = {
  title: "Enter a product name.",
  description: "Add a description of up to 500 characters.",
  merchant_item_id: "Enter the product code you use in your own records.",
  price:
    'Write the price as a number with a dot, such as "5.00", and the currency in capitals, such as "USD".',
  result:
    "Enter at least one field the buyer receives, in Latin letters, separated by commas, such as access_url.",
  params:
    "Enter what you need from the buyer in Latin letters, separated by commas, or leave it empty.",
  tags: "Use up to five different tags in Latin letters, separated by commas.",
  fulfillment: "Choose when the buyer receives the product.",
  fulfill_deadline_seconds: "Enter the delivery time as a whole number of hours.",
};

const listed = (text: string): string[] =>
  text
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word !== "");

/** A list of names as a declaration where every field is text. */
const declared = (text: string): Record<string, "string"> =>
  Object.fromEntries(listed(text).map((name) => [name, "string" as const]));

export const typedFrom = (body: unknown): TypedCard => {
  const form = (body ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    FIELDS.map((field) => {
      const value = form[field];
      return [field, typeof value === "string" ? value.trim() : ""];
    }),
  ) as TypedCard;
};

/**
 * The card the form describes, or one sentence for each box that is wrong.
 *
 * Checked here with the contract's own schema before anything is sent, so the
 * merchant is told about every box at once and in words about boxes.
 */
export const cardFromForm = (
  typed: TypedCard,
): { readonly card: CardInput } | { readonly problems: readonly string[] } => {
  const later = typed.fulfillment === "async";
  const hours = Number(typed.fulfill_hours);
  const card: Record<string, unknown> = {
    merchant_item_id: typed.merchant_item_id,
    title: typed.title,
    description: typed.description,
    price: { amount: typed.price_amount, currency: typed.price_currency.toUpperCase() },
    result: declared(typed.result),
    fulfillment: later ? "async" : "sync",
  };
  if (listed(typed.params).length > 0) card.params = declared(typed.params);
  if (listed(typed.tags).length > 0) card.tags = listed(typed.tags);
  if (later && typed.fulfill_hours !== "") card.fulfill_deadline_seconds = hours * 3600;

  const parsed = CardSchema.safeParse(card);
  if (parsed.success) {
    return { card: card as CardInput };
  }
  return { problems: problemsFor(parsed.error.issues) };
};

/**
 * One sentence per box the findings name, in form order. A finding about no
 * box of this form — the seller's name not chosen yet, say — is passed on in
 * its own words, because dropping it would leave a refusal with no reason.
 */
export const problemsFor = (
  findings: ReadonlyArray<{ readonly path: readonly PropertyKey[]; readonly message: string }>,
): string[] => {
  const named = new Set(findings.map((finding) => String(finding.path[0] ?? "")));
  const boxes = Object.keys(FIELD_PROBLEMS).filter((field) => named.has(field));
  const elsewhere = findings
    .filter((finding) => !(String(finding.path[0] ?? "") in FIELD_PROBLEMS))
    .map((finding) => finding.message);
  return [...boxes.map((field) => FIELD_PROBLEMS[field] as string), ...elsewhere];
};

const EMPTY: TypedCard = typedFrom({ price_currency: "USD", fulfillment: "sync" });

const box = (
  field: keyof TypedCard,
  label: string,
  hint: string,
  typed: TypedCard,
  extra = "",
): string => `<div class="card-field">
      <label for="${field}">${escaped(label)}</label>
      <input id="${field}" name="${field}" type="text" value="${escaped(typed[field])}"${extra}>
      <p class="quiet">${escaped(hint)}</p>
    </div>`;

export const newCardScreen = (
  viewer: Viewer,
  typed: TypedCard = EMPTY,
  problems: readonly string[] = [],
): string => {
  const { base } = viewer;
  const later = typed.fulfillment === "async";
  const body = `
  <div class="lede">
    <div>
      <h1>Add a product</h1>
      <p>The buyer's agent sees this card exactly as you fill it in. The product goes on sale as soon as you publish it.</p>
    </div>
  </div>
  ${
    !ADD_CARD_BY_HAND
      ? `<div class="callout"><div class="what">Preview for the owner: this block is hidden on the live site.</div><div class="why">It turns on once Agentify can deliver a product without the seller's code. Saving here publishes the card on this stand, but nothing can deliver an order for it yet.</div></div>`
      : ""
  }
  <form class="card-form" method="post" action="${escaped(base)}/cards">
    ${box("title", "Product name", "The name shown in the catalog, such as “Monthly access”.", typed, " required")}
    ${box("merchant_item_id", "Product code", "The code you use for this product in your own records, such as access-monthly.", typed, " required")}
    <div class="card-field card-field-wide">
      <label for="description">Description</label>
      <textarea id="description" name="description" rows="4" maxlength="500" required>${escaped(typed.description)}</textarea>
      <p class="quiet">What the product is and what the buyer gets. At most 500 characters.</p>
    </div>
    <div class="card-field">
      <label for="price_amount">Price</label>
      <div class="card-price">
        <input id="price_amount" name="price_amount" type="text" inputmode="decimal" placeholder="5.00" value="${escaped(typed.price_amount)}" required>
        <input id="price_currency" name="price_currency" type="text" aria-label="Currency" value="${escaped(typed.price_currency)}" required>
      </div>
      <p class="quiet">The amount with a decimal point, such as 5.00, and the currency code.</p>
    </div>
    ${box("tags", "Tags", "Up to five words in Latin letters, separated by commas. Agents use them to find the product in search.", typed)}
    ${box("result", "What the buyer receives", "Field names in Latin letters, separated by commas, such as access_url.", typed, " required")}
    ${box("params", "What you need from the buyer", "Field names separated by commas, such as email. Leave empty if you need nothing.", typed)}
    <fieldset class="card-field">
      <legend>When the buyer receives it</legend>
      <label class="card-choice"><input type="radio" name="fulfillment" value="sync"${later ? "" : " checked"}> Immediately, in the purchase response</label>
      <label class="card-choice"><input type="radio" name="fulfillment" value="async"${later ? " checked" : ""}> Later, within the time set below</label>
    </fieldset>
    ${box("fulfill_hours", "Delivery time, in hours", "Only needed if the product is delivered later.", typed, ' inputmode="numeric"')}
    ${problems.map((problem) => `<p class="problem">${escaped(problem)}</p>`).join("")}
    <div class="card-actions">
      <button class="button button-primary" type="submit">Publish the card</button>
      <a class="button button-secondary" href="${escaped(base)}/cards">Cancel</a>
    </div>
  </form>
`;
  return page({
    mode: viewer.mode,
    base,
    who: viewer.who,
    confirmed: viewer.confirmed,
    tab: "cards",
    title: "Add a product",
    body,
  });
};
