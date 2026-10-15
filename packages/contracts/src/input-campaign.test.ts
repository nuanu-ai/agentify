/** Bounded input checks against declared consumer rules; no gateway, database or remote I/O. */
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { OrderListQuerySchema, PurchaseRequestSchema, WorkerPollRequestSchema } from "./api.js";
import { CardSchema } from "./card.js";
import { HandlerAnswerSchema } from "./handler.js";
import { IssueKeyRequestSchema, SellerNameRequestSchema } from "./merchant.js";
import { QuoteResponseSchema } from "./quote.js";

const SEEDS = [0xa61015a1, 0xa61015a2] as const;
const CAP = 256 * 1024;
const card = JSON.parse(
  readFileSync(
    new URL("../../../apps/docs/examples/card/access-monthly.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;
const address = {
  name: "Agentify",
  line_one: "Jl. Raya Kediri, Beraban",
  city: "Tabanan",
  country: "ID",
  phone_number: "+62 000 0000 0000",
};
const price = { amount: "5.00", currency: "USD" };
const asOf = "2026-08-26T10:15:00Z";
const quote = { available: true, price, as_of: asOf };

interface Vector {
  readonly name: string;
  readonly input: unknown;
  readonly accepted: boolean;
}
const yes = (name: string, input: unknown): Vector => ({ name, input, accepted: true });
const no = (name: string, input: unknown): Vector => ({ name, input, accepted: false });
const without = (value: Record<string, unknown>, field: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== field));
const roots = (emptyAccepted = false): Vector[] => [
  no("document absent", undefined),
  no("null document", null),
  no("boolean document", false),
  no("number document", 1),
  no("string document", "document"),
  no("empty array document", []),
  no("nonempty array document", ["document"]),
  { name: "empty object document", input: {}, accepted: emptyAccepted },
];

// Expected verdicts are written from the contract's rules, never obtained by parsing a candidate.
const families: readonly { name: string; schema: ZodType; cases: Vector[] }[] = [
  {
    name: "card",
    schema: CardSchema,
    cases: [
      ...roots(),
      yes("canonical documentation card", card),
      yes("short price and result", {
        ...card,
        price: "5.00 USD",
        result: { access_url: "string" },
      }),
      ...["merchant_item_id", "title", "description", "price", "result"].map((field) =>
        no(`required ${field} absent`, without(card, field)),
      ),
      no("padded identifier", { ...card, merchant_item_id: " access-monthly" }),
      no("blank title", { ...card, title: " \t" }),
      no("blank description", { ...card, description: " " }),
      yes("description 499 units", { ...card, description: "x".repeat(499) }),
      yes("description 500 units", { ...card, description: "x".repeat(500) }),
      no("description 501 units", { ...card, description: "x".repeat(501) }),
      no("numeric price", { ...card, price: 5 }),
      // The format schema also reads stored cards. Admission price policy is a separate check.
      yes("zero is readable money", { ...card, price: { amount: "0.00", currency: "USD" } }),
      no("leading zero amount", { ...card, price: { amount: "01.00", currency: "USD" } }),
      yes("all scalar declaration types", {
        ...card,
        params: { text: "string", amount: "number", quantity: "integer", enabled: "boolean" },
      }),
      no("declared type absent", { ...card, params: { email: {} } }),
      no("unknown declared field attribute", {
        ...card,
        params: { email: { type: "string", extra: 1 } },
      }),
      no("empty result promises nothing", { ...card, result: {} }),
      yes("one tag", { ...card, tags: ["access"] }),
      yes("five tags", { ...card, tags: ["access", "monthly", "service", "digital", "link"] }),
      no("six tags", {
        ...card,
        tags: ["access", "monthly", "service", "digital", "link", "expiry"],
      }),
      yes("async deadline one second", {
        ...card,
        fulfillment: "async",
        fulfill_deadline_seconds: 1,
      }),
    ],
  },
  {
    name: "purchase",
    schema: PurchaseRequestSchema,
    cases: [
      ...roots(),
      yes("empty parameters", { params: {} }),
      no("parameters absent with address", { ship_to: address }),
      no("null parameters", { params: null }),
      no("string parameters", { params: "email" }),
      no("array parameters", { params: [] }),
      yes("scalar values await the card check", { params: { quantity: 1, enabled: false } }),
      yes("nested values await the card check", { params: { value: { child: 1 } } }),
      no("invalid parameter name", { params: { "email.address": "x" } }),
      yes("uppercase parameter name", { params: { Email: "x" } }),
      no("unknown outer field", { params: {}, extra: 1 }),
      yes("complete office address", { params: {}, ship_to: address }),
      no("null address", { params: {}, ship_to: null }),
      no("array address", { params: {}, ship_to: [] }),
      ...["name", "line_one", "city", "country", "phone_number"].map((field) =>
        no(`address ${field} absent`, { params: {}, ship_to: without(address, field) }),
      ),
      no("lowercase country", { params: {}, ship_to: { ...address, country: "id" } }),
      no("three-letter country", { params: {}, ship_to: { ...address, country: "IDN" } }),
      no("numeric country", { params: {}, ship_to: { ...address, country: 1 } }),
      yes("optional locality fields absent", {
        params: {},
        ship_to: { ...address, line_two: "Nuanu Creative City" },
      }),
      no("invalid state code", { params: {}, ship_to: { ...address, state: "ID-BA" } }),
      no("unknown address field", { params: {}, ship_to: { ...address, extra: "x" } }),
    ],
  },
  {
    name: "poll",
    schema: WorkerPollRequestSchema,
    cases: [
      ...roots(true),
      yes("zero wait", { wait_seconds: 0 }),
      yes("one second wait", { wait_seconds: 1 }),
      yes("safe integer wait", { wait_seconds: Number.MAX_SAFE_INTEGER }),
      yes("wait beyond 32-bit integer", { wait_seconds: 2 ** 31 }),
      no("null wait", { wait_seconds: null }),
      no("string wait", { wait_seconds: "1" }),
      no("negative wait", { wait_seconds: -1 }),
      no("fractional wait", { wait_seconds: 0.5 }),
      no("unsafe integer wait", { wait_seconds: Number.MAX_SAFE_INTEGER + 1 }),
      yes("one envelope requested", { max: 1 }),
      yes("two envelopes requested", { max: 2 }),
      yes("safe integer batch", { max: Number.MAX_SAFE_INTEGER }),
      no("zero batch", { max: 0 }),
      no("negative batch", { max: -1 }),
      no("fractional batch", { max: 0.5 }),
      no("null batch", { max: null }),
      no("string batch", { max: "1" }),
      no("unknown poll field", { extra: 1 }),
      yes("wait and batch", { wait_seconds: 0, max: 1 }),
      no("boolean wait", { wait_seconds: false }),
      no("boolean batch", { max: false }),
      no("array wait", { wait_seconds: [] }),
      no("object batch", { max: {} }),
      no("unsafe integer batch", { max: Number.MAX_SAFE_INTEGER + 1 }),
    ],
  },
  {
    name: "key issue",
    schema: IssueKeyRequestSchema,
    cases: [
      ...roots(),
      yes("one-character label", { label: "A" }),
      yes("label 100 units", { label: "A".repeat(100) }),
      yes("label 99 units", { label: "A".repeat(99) }),
      no("label 101 units", { label: "A".repeat(101) }),
      ...[
        "",
        " ",
        " leading",
        "trailing ",
        "\t",
        "A\tB",
        "A\nB",
        "\r",
        "\u0000",
        "\u007f",
        "\u0085",
        "\u2028",
        "\u2029",
      ].map((label, index) => no(`invalid label text ${index}`, { label })),
      no("numeric label", { label: 1 }),
      no("null label", { label: null }),
      no("object label", { label: {} }),
      no("array label", { label: [] }),
      yes("Cyrillic label", { label: "Обработка заказов" }),
      yes("emoji label", { label: "Orders 🛒" }),
      no("unknown key request field", { label: "Orders", extra: "x" }),
    ],
  },
  {
    name: "merchant settings",
    schema: SellerNameRequestSchema,
    cases: [
      ...roots(),
      yes("one-character seller", { seller_name: "A" }),
      yes("seller 31 units", { seller_name: "A".repeat(31) }),
      yes("seller 32 units", { seller_name: "A".repeat(32) }),
      no("seller 33 units", { seller_name: "A".repeat(33) }),
      no("empty seller", { seller_name: "" }),
      no("blank seller", { seller_name: " " }),
      no("padded seller", { seller_name: " Agentify" }),
      no("non-ASCII listing name", { seller_name: "Агент" }),
      no("numeric seller", { seller_name: 1 }),
      no("null seller", { seller_name: null }),
      yes("https shop origin", { seller_site: "https://agentify.ad" }),
      yes("name and site", { seller_name: "Agentify", seller_site: "https://agentify.ad" }),
      ...[
        "http://agentify.ad",
        "https://agentify.ad/",
        "https://agentify.ad/docs",
        "https://agentify.ad?q=1",
        "https://agentify.ad:443",
        "https://user@agentify.ad",
        "https://127.0.0.1",
        "https://agentify",
        "https://AGENTIFY.ad",
      ].map((seller_site, index) => no(`invalid shop origin ${index}`, { seller_site })),
      no("null site", { seller_site: null }),
      no("numeric site", { seller_site: 1 }),
      no("unknown settings field", { seller_name: "Agentify", extra: "x" }),
    ],
  },
  {
    name: "quote answer",
    schema: QuoteResponseSchema,
    cases: [
      ...roots(),
      yes("available with money and timestamp", quote),
      yes("unavailable with timestamp", { available: false, as_of: asOf }),
      no("availability absent", without(quote, "available")),
      no("available price absent", without(quote, "price")),
      no("answer timestamp absent", without(quote, "as_of")),
      no("unavailable answer carries price", { ...quote, available: false }),
      no("text availability", { ...quote, available: "true" }),
      no("numeric availability", { ...quote, available: 0 }),
      no("price amount absent", { ...quote, price: { currency: "USD" } }),
      no("price currency absent", { ...quote, price: { amount: "5.00" } }),
      no("numeric amount", { ...quote, price: { ...price, amount: 5 } }),
      no("leading zero amount", { ...quote, price: { ...price, amount: "05.00" } }),
      yes("zero remains readable money", { ...quote, price: { ...price, amount: "0.00" } }),
      yes("eighteen fractional digits", {
        ...quote,
        price: { ...price, amount: `5.${"0".repeat(18)}` },
      }),
      no("nineteen fractional digits", {
        ...quote,
        price: { ...price, amount: `5.${"0".repeat(19)}` },
      }),
      no("lowercase currency", { ...quote, price: { ...price, currency: "usd" } }),
      no("two-letter currency", { ...quote, price: { ...price, currency: "US" } }),
      no("nine-letter currency", { ...quote, price: { ...price, currency: "USDABCDEF" } }),
      yes("fractional timestamp", { ...quote, as_of: "2026-08-26T10:15:00.001Z" }),
      yes("timestamp with offset", { ...quote, as_of: "2026-08-26T13:15:00+03:00" }),
      no("timestamp without zone", { ...quote, as_of: "2026-08-26T10:15:00" }),
      no("invalid timestamp month", { ...quote, as_of: "2026-13-26T10:15:00Z" }),
      no("unknown available-answer field", { ...quote, extra: 1 }),
      no("unknown unavailable-answer field", { available: false, as_of: asOf, extra: 1 }),
    ],
  },
  {
    name: "handler answer",
    schema: HandlerAnswerSchema,
    cases: [
      ...roots(),
      yes("empty delivery awaits card check", { delivered: {} }),
      yes("scalar delivery fields", { delivered: { text: "x", count: 1, valid: false } }),
      no("null delivery", { delivered: null }),
      no("array delivery", { delivered: [] }),
      no("numeric delivery", { delivered: 1 }),
      no("invalid delivery field name", { delivered: { "access.url": "x" } }),
      yes("empty acceptance", { accepted: {} }),
      no("null acceptance", { accepted: null }),
      no("acceptance carries a field", { accepted: { eta_seconds: 1 } }),
      no("array acceptance", { accepted: [] }),
      yes("refusal with code and reason", {
        refused: { code: "out_of_stock", message: "No access remains" },
      }),
      no("refusal code absent", { refused: { message: "No access remains" } }),
      no("refusal message absent", { refused: { code: "out_of_stock" } }),
      no("null refusal code", { refused: { code: null, message: "No access remains" } }),
      no("null refusal message", { refused: { code: "out_of_stock", message: null } }),
      no("blank refusal code", { refused: { code: " ", message: "No access remains" } }),
      no("blank refusal message", { refused: { code: "out_of_stock", message: " " } }),
      yes("merchant-defined refusal code", {
        refused: { code: "subscription_limit", message: "No access remains" },
      }),
      no("two answers at once", { delivered: {}, accepted: {} }),
      no("three answers at once", {
        delivered: {},
        accepted: {},
        refused: { code: "x", message: "x" },
      }),
      no("unknown answer field", { accepted: {}, extra: 1 }),
      no("unknown answer branch", { delivery: {} }),
      yes("nested delivery awaits card check", { delivered: { value: { child: 1 } } }),
      no("unknown refusal field", { refused: { code: "x", message: "x", extra: 1 } }),
    ],
  },
  {
    name: "order query",
    schema: OrderListQuerySchema,
    cases: [
      ...roots(true),
      yes("true narrows orders", { open: "true" }),
      yes("false asks for all orders", { open: "false" }),
      no("unknown query field", { extra: "x" }),
      ...[
        null,
        true,
        false,
        1,
        0,
        "TRUE",
        "1",
        "",
        " true",
        ["true"],
        ["true", "false"],
        {},
        " ",
        "yes",
        "no",
        "undefined",
        "null",
        2,
      ].map((open, index) => no(`invalid open value ${index}`, { open })),
      no("true with unknown field", { open: "true", extra: "x" }),
      no("false with unknown field", { open: "false", extra: "x" }),
      no("unrelated query key", { limit: "10" }),
    ],
  },
];

interface Observation {
  readonly id: string;
  readonly seed: number;
  readonly family: string;
  readonly name: string;
  readonly input: unknown;
  readonly expected: string;
  readonly actual: string;
  readonly problems: readonly { path: readonly PropertyKey[]; message: string }[];
}
const observations: Observation[] = [];

// The seeds choose execution order only. The finite cases and their verdicts stay visible above.
const ordered = (cases: readonly Vector[], seed: number): Vector[] => {
  const result = [...cases];
  let state = seed;
  for (let i = result.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const at = state % (i + 1);
    [result[i], result[at]] = [result[at] as Vector, result[i] as Vector];
  }
  return result;
};

for (const [familyIndex, family] of families.entries()) {
  if (family.cases.length !== 32)
    throw new Error(`${family.name} has ${family.cases.length}, expected 32`);
  const seed = SEEDS[familyIndex % SEEDS.length] as number;
  describe(`campaign: ${family.name}`, () => {
    for (const [caseIndex, vector] of ordered(family.cases, seed ^ familyIndex).entries()) {
      const id = `schema-${familyIndex + 1}-${String(caseIndex + 1).padStart(2, "0")}`;
      it(`${id}: ${vector.name}`, () => {
        const encoded = JSON.stringify(vector.input);
        if (Buffer.byteLength(encoded ?? "") > CAP)
          throw new Error(`${id} exceeds the campaign input cap`);
        const parsed = family.schema.safeParse(vector.input);
        observations.push({
          id,
          seed,
          family: family.name,
          name: vector.name,
          input: vector.input === undefined ? { campaign_input: "undefined" } : vector.input,
          expected: vector.accepted ? "accepted" : "refused",
          actual: parsed.success ? "accepted" : "refused",
          problems: parsed.success
            ? []
            : parsed.error.issues.map(({ path, message }) => ({ path, message })),
        });
        expect(parsed.success, `${id}: ${vector.name}`).toBe(vector.accepted);
        if (!parsed.success) {
          expect(parsed.error.issues.length).toBeGreaterThan(0);
          for (const issue of parsed.error.issues) expect(issue.message).toMatch(/\S/);
        }
      });
    }
  });
}

afterAll(() => {
  const destination = process.env.API_CAMPAIGN_SCHEMA_EVIDENCE;
  if (destination !== undefined) {
    writeFileSync(
      destination,
      JSON.stringify({ seeds: SEEDS, count: observations.length, observations }, null, 2),
    );
  }
});
