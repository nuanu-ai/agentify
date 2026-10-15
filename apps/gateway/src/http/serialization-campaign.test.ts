/** Exercises accepted documents and parser refusals through a real loopback HTTP boundary. */

import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { Card, MerchantCardList } from "@nuanu-ai/agentify-contracts";
import { CardSchema, ErrorEnvelopeSchema } from "@nuanu-ai/agentify-contracts";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { type Harness, harness, type Served, serve } from "../testing/harness.js";
import { PAYMENT_REQUIRED_HEADER } from "./x402.js";

const SEEDS = [0xa61015a1, 0xa61015a2] as const;
const CAP = 256 * 1024;
const fixture = (name: string): Card =>
  JSON.parse(
    readFileSync(new URL(`../../../docs/examples/card/${name}.json`, import.meta.url), "utf8"),
  ) as Card;
const documented = [fixture("access-monthly"), fixture("access-monthly-params")];

interface Observation {
  readonly id: string;
  readonly seed: number;
  readonly expected: string;
  actual?: unknown;
  passed: boolean;
  inputBytes?: number;
  error?: string;
}
const observations: Observation[] = [];
let open: { harnessed: Harness; served: Served } | undefined;

const started = async () => {
  const harnessed = await harness();
  try {
    const served = await serve(harnessed);
    open = { harnessed, served };
    return { harnessed, served, headers: { authorization: `Bearer ${harnessed.merchant.key}` } };
  } catch (error) {
    await harnessed.stop();
    throw error;
  }
};

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = undefined;
});

const observe = async (observation: Observation, run: () => Promise<void>) => {
  observations.push(observation);
  try {
    await run();
    observation.passed = true;
  } catch (error) {
    observation.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
};

const withinCap = (input: unknown): number => {
  const bytes = Buffer.byteLength(JSON.stringify(input));
  if (bytes > CAP) throw new Error(`campaign input is ${bytes} bytes, above ${CAP}`);
  return bytes;
};

// This expected projection is written from the public promise, independently of publicCardOf.
const projected = (card: Card, id: string, harnessed: Harness) => ({
  id,
  seller: { name: harnessed.merchant.name, site: null },
  title: card.title,
  description: card.description,
  price: card.price,
  as_of: new Date(harnessed.now()).toISOString(),
  ...(card.params === undefined ? {} : { params: card.params }),
  result: card.result,
  price_checked_at_purchase: false,
  fulfillment: "sync",
});

describe("campaign: accepted documentation spellings stay usable over HTTP", () => {
  for (const [variant, base] of documented.entries()) {
    for (let mask = 0; mask < 32; mask += 1) {
      const id = `roundtrip-${variant + 1}-${String(mask + 1).padStart(2, "0")}`;
      const amount = ["5.00", "5.000", "5.0000", "5.000000"][mask >> 3] as string;
      const canonical: Card = {
        ...base,
        merchant_item_id: `access-monthly-campaign-${variant}-${mask}`,
        price: { amount, currency: "USD" },
        result: { access_url: { type: "string" }, expires_at: { type: "string" } },
        fulfillment: "sync",
      };
      const input: Record<string, unknown> = {
        ...canonical,
        ...(mask & 1 ? { price: `${amount} USD` } : {}),
        ...(mask & 2 ? { result: { access_url: "string", expires_at: "string" } } : {}),
      };
      if (mask & 4) delete input.fulfillment;
      const observation: Observation = {
        id,
        seed: SEEDS[variant] as number,
        expected:
          "canonical parse, publication, merchant readback, public projection and readable discovery agree",
        inputBytes: withinCap(input),
        passed: false,
      };
      it(`${id}: variant ${variant + 1}, spelling mask ${mask}`, async () => {
        await observe(observation, async () => {
          const { harnessed, served, headers } = await started();
          expect(CardSchema.parse(input)).toEqual(canonical);
          const published = await served.call("POST", "/v0/catalog/publish", {
            body: input,
            headers,
          });
          expect(published.status).toBe(200);
          const itemId = (published.body as { id: string }).id;
          const own = await served.call("GET", "/v0/cards", { headers });
          expect(own.status).toBe(200);
          expect(own.body).toEqual({
            selling: "open",
            cards: [
              {
                id: itemId,
                as_of: new Date(harnessed.now()).toISOString(),
                card: canonical,
                selling: "open",
                paused: false,
              },
            ],
          });
          const catalog = await served.call("GET", "/x402/catalog");
          expect(catalog.status).toBe(200);
          expect(catalog.body).toEqual({ items: [projected(canonical, itemId, harnessed)] });
          const probe = await served.call("GET", `/x402/${itemId}/purchase`);
          expect(probe.status).toBe(402);
          const header = probe.headers.get(PAYMENT_REQUIRED_HEADER) ?? "";
          const challenge = decodePaymentRequiredHeader(header);
          expect(challenge.resource.url).toBe(
            `${harnessed.runtime.config.publicBaseUrl}/x402/${itemId}/purchase`,
          );
          expect(challenge.accepts[0]?.amount).toBe("5000000");
          const declaration = challenge.extensions?.bazaar as {
            info: {
              input: { method: string; bodyType: string; body: unknown };
              output: { example: unknown };
            };
          };
          expect(declaration.info.input).toMatchObject({
            method: "POST",
            bodyType: "json",
            body: { params: variant === 0 ? {} : { email: "string" } },
          });
          expect(declaration.info.output.example).toEqual({
            access_url: "string",
            expires_at: "string",
          });
          expect(await harnessed.store.orders(harnessed.merchant.id)).toEqual([]);
          observation.actual = {
            publishStatus: published.status,
            merchantReadStatus: own.status,
            catalogStatus: catalog.status,
            probeStatus: probe.status,
            challengeBytes: Buffer.byteLength(header),
            canonicalCard: canonical,
            expectedAmountAtomicUnits: "5000000",
            probeCreatedOrders: 0,
          };
        });
      });
    }
  }
});

describe("campaign: lists carry every accepted card at the registered sizes", () => {
  for (const size of [1, 10, 100]) {
    for (const audience of ["public", "merchant"] as const) {
      const id = `list-${audience}-${size}`;
      const observation: Observation = {
        id,
        seed: SEEDS[0],
        expected: `${size} distinct accepted cards, with no omitted or changed content`,
        passed: false,
      };
      it(id, async () => {
        await observe(observation, async () => {
          const { harnessed, served, headers } = await started();
          const expected = new Map<string, Card>();
          for (let index = 0; index < size; index += 1) {
            const card: Card = {
              ...(documented[0] as Card),
              merchant_item_id: `access-monthly-list-${index}`,
            };
            withinCap(card);
            const published = await served.call("POST", "/v0/catalog/publish", {
              body: card,
              headers,
            });
            expect(published.status).toBe(200);
            expected.set((published.body as { id: string }).id, card);
          }
          const answered = await served.call(
            "GET",
            audience === "public" ? "/x402/catalog" : "/v0/cards",
            { headers },
          );
          expect(answered.status).toBe(200);
          let ids: string[];
          if (audience === "public") {
            const items = (answered.body as { items: { id: string }[] }).items;
            ids = items.map((item) => item.id);
            for (const item of items) {
              const card = expected.get(item.id);
              expect(card, `unexpected public card ${item.id}`).toBeDefined();
              expect(item).toEqual(projected(card as Card, item.id, harnessed));
            }
          } else {
            const own = answered.body as MerchantCardList;
            expect(own.selling).toBe("open");
            ids = own.cards.map((item) => item.id);
            for (const item of own.cards) {
              expect(item.card).toEqual(expected.get(item.id));
              expect(item.paused).toBe(false);
              expect(item.selling).toBe("open");
              expect(item.as_of).toBe(new Date(harnessed.now()).toISOString());
            }
          }
          expect(ids).toHaveLength(size);
          expect(new Set(ids).size).toBe(size);
          expect([...ids].sort()).toEqual([...expected.keys()].sort());
          observation.actual = {
            status: answered.status,
            count: ids.length,
            distinct: new Set(ids).size,
            identifiers: ids,
          };
        });
      });
    }
  }
});

const malformed = [
  { name: "unfinished object", bytes: "{" },
  { name: "trailing comma", bytes: '{"label":"Orders",}' },
  { name: "unquoted key", bytes: '{label:"Orders"}' },
  { name: "single quotes", bytes: "{'label':'Orders'}" },
  { name: "concatenated objects", bytes: "{}{}" },
  { name: "invalid escape", bytes: '{"label":"bad\\x20"}' },
];

describe("campaign: malformed JSON has a clear final refusal and accepts no write", () => {
  const paths = ["/v0/catalog/publish", "/v0/keys", "/v0/seller-name", "/v0/worker/poll"];
  for (const [routeIndex, path] of paths.entries()) {
    for (const [formIndex, form] of malformed.entries()) {
      const id = `json-${routeIndex + 1}-${formIndex + 1}`;
      const observation: Observation = {
        id,
        seed: SEEDS[1],
        expected: "400 malformed_body, retryable false, and merchant state preserved",
        inputBytes: Buffer.byteLength(form.bytes),
        passed: false,
      };
      it(`${id}: ${path}, ${form.name}`, async () => {
        await observe(observation, async () => {
          const { harnessed, served, headers } = await started();
          const snapshot = async () => ({
            cards: await harnessed.gateway.merchantCards(harnessed.merchant.id),
            seller: await harnessed.gateway.sellerName(harnessed.merchant.id),
            keys: (await harnessed.gateway.merchantKeys(harnessed.merchant.id)).map(
              ({ id, label, disabled_at }) => ({ id, label, disabled_at }),
            ),
            orders: await harnessed.store.orders(harnessed.merchant.id),
          });
          const before = await snapshot();
          const answered = await fetch(`${served.url}${path}`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: form.bytes,
          });
          const document = await answered.json();
          const after = await snapshot();
          expect(answered.status).toBe(400);
          expect(answered.headers.get("content-type")).toContain("application/json");
          expect(ErrorEnvelopeSchema.safeParse(document).success).toBe(true);
          expect(document).toEqual({
            error: {
              code: "malformed_body",
              message: expect.stringMatching(/\S/),
              retryable: false,
            },
          });
          expect(after).toEqual(before);
          observation.actual = {
            path,
            malformedForm: form.name,
            bytes: form.bytes,
            status: answered.status,
            error: document,
            statePreserved: isDeepStrictEqual(before, after),
          };
        });
      });
    }
  }
});

afterAll(() => {
  const destination = process.env.API_CAMPAIGN_HTTP_EVIDENCE;
  if (destination !== undefined) {
    writeFileSync(
      destination,
      JSON.stringify({ seeds: SEEDS, count: observations.length, observations }, null, 2),
    );
  }
});
