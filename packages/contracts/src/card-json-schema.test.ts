import { readdirSync, readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { CardSchema, MerchantCardSchema } from "./card.js";
import { toJsonSchemas } from "./index.js";

const examples = new URL("../../../apps/docs/examples/card/", import.meta.url);
const example = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(name, examples), "utf8"));
const sync = CardSchema.parse(example("access-monthly.json"));
const { result: _result, ...withoutResult } = sync;
const parcel = {
  ...withoutResult,
  fulfillment: "ship",
  price_check: "handler",
  ship_within_seconds: 86_400,
};
const merchantCard = (card: unknown) => ({
  id: "itm_4d21bb",
  as_of: "2026-08-26T09:00:00Z",
  card,
  selling: "open",
  paused: false,
});

// Formats concern timestamps and URLs, outside the card-mode rules under test.
const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
const documents = toJsonSchemas();
const validateCard = ajv.compile(documents.card);
const exports = [
  { name: "card", validate: validateCard, wrap: (card: unknown) => card },
  { name: "merchant_card", validate: ajv.compile(documents.merchant_card), wrap: merchantCard },
  {
    name: "merchant_card_list",
    validate: ajv.compile(documents.merchant_card_list),
    wrap: (card: unknown) => ({ selling: "open", cards: [merchantCard(card)] }),
  },
];

describe.each(exports)("$name JSON Schema card modes", ({ validate, wrap }) => {
  it.each([
    ["sync", sync],
    ["sync with a price handler", { ...sync, price_check: "handler" }],
    ["async without a deadline", { ...sync, fulfillment: "async" }],
    ["async with a deadline", { ...sync, fulfillment: "async", fulfill_deadline_seconds: 900 }],
    ["ship", parcel],
    ["ship at the maximum shipping time", { ...parcel, ship_within_seconds: 2_592_000 }],
    ["ship with purchase parameters", { ...parcel, params: sync.result }],
    ["sync with a ship_to parameter", { ...sync, params: { ship_to: { type: "string" } } }],
    [
      "async with a ship_to parameter",
      { ...sync, fulfillment: "async", params: { ship_to: { type: "string" } } },
    ],
  ])("accepts %s just as the runtime does", (_name, card) => {
    expect(CardSchema.safeParse(card).success).toBe(true);
    expect(MerchantCardSchema.safeParse(merchantCard(card)).success).toBe(true);
    expect(validate(wrap(card)), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    ["sync without result", withoutResult, "result"],
    ["async without result", { ...withoutResult, fulfillment: "async" }, "result"],
    ["confirm", { ...sync, fulfillment: "confirm" }, "fulfillment"],
    [
      "sync confirmation deadline",
      { ...sync, confirm_deadline_seconds: 30 },
      "confirm_deadline_seconds",
    ],
    [
      "async confirmation deadline",
      { ...sync, fulfillment: "async", confirm_deadline_seconds: 30 },
      "confirm_deadline_seconds",
    ],
    [
      "ship confirmation deadline",
      { ...parcel, confirm_deadline_seconds: 30 },
      "confirm_deadline_seconds",
    ],
    [
      "sync delivery deadline",
      { ...sync, fulfill_deadline_seconds: 900 },
      "fulfill_deadline_seconds",
    ],
    ["sync shipping deadline", { ...sync, ship_within_seconds: 900 }, "ship_within_seconds"],
    [
      "async shipping deadline",
      { ...sync, fulfillment: "async", ship_within_seconds: 900 },
      "ship_within_seconds",
    ],
    ["ship declared result", { ...parcel, result: sync.result }, "result"],
    ["ship with another price check", { ...parcel, price_check: "none" }, "price_check"],
    [
      "ship after the maximum shipping time",
      { ...parcel, ship_within_seconds: 2_592_001 },
      "ship_within_seconds",
    ],
    [
      "ship delivery deadline",
      { ...parcel, fulfill_deadline_seconds: 900 },
      "fulfill_deadline_seconds",
    ],
    [
      "ship address as a parameter",
      { ...parcel, params: { ship_to: { type: "string" } } },
      "params",
    ],
  ])("refuses %s just as the runtime does", (_name, card, field) => {
    const published = CardSchema.safeParse(card);
    expect(published.success).toBe(false);
    if (!published.success) {
      expect(published.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
    }
    expect(MerchantCardSchema.safeParse(merchantCard(card)).success).toBe(false);
    expect(validate(wrap(card)), JSON.stringify(validate.errors)).toBe(false);
    if (field === "result" && !Object.hasOwn(card, field)) {
      expect(
        validate.errors?.some(
          (error) => error.keyword === "required" && error.params.missingProperty === field,
        ),
      ).toBe(true);
    }
  });

  it.each(["ship_within_seconds", "price_check"])("names a parcel's missing %s", (field) => {
    const card: Record<string, unknown> = { ...parcel };
    delete card[field];
    const published = CardSchema.safeParse(card);
    expect(published.success).toBe(false);
    if (!published.success) {
      expect(published.error.issues.some((issue) => issue.path[0] === field)).toBe(true);
    }
    expect(validate(wrap(card))).toBe(false);
    expect(
      validate.errors?.some(
        (error) => error.keyword === "required" && error.params.missingProperty === field,
      ),
    ).toBe(true);
  });

  it.each(["merchant_item_id", "title", "description", "price", "fulfillment"])(
    "names a canonical card's missing %s",
    (field) => {
      const card: Record<string, unknown> = { ...sync };
      delete card[field];
      expect(validate(wrap(card))).toBe(false);
      expect(
        validate.errors?.some(
          (error) => error.keyword === "required" && error.params.missingProperty === field,
        ),
      ).toBe(true);
    },
  );
});

it("validates each documentation card after publication normalizes its short forms and default mode", () => {
  for (const name of readdirSync(examples)) {
    const card = CardSchema.parse(example(name));
    expect(validateCard(card), `${name}: ${JSON.stringify(validateCard.errors)}`).toBe(true);
  }
  const { fulfillment: _fulfillment, ...defaultSync } = sync;
  expect(CardSchema.parse(defaultSync).fulfillment).toBe("sync");
  expect(validateCard(CardSchema.parse(defaultSync))).toBe(true);
});

it("keeps a stored card's legacy markup readable while refusing it at publication", () => {
  const card = { ...sync, title: "<b>One month of access to the service</b>" };
  expect(CardSchema.safeParse(card).success).toBe(false);
  expect(MerchantCardSchema.parse(merchantCard(card)).card.title).toBe(card.title);
  for (const { validate, wrap } of exports.slice(1)) {
    expect(validate(wrap(card)), JSON.stringify(validate.errors)).toBe(true);
  }
});
