/**
 * The operator's one-time approval at the live publish door.
 *
 * A merchant may prove their address, choose a seller name and choose where
 * their money goes without the operator having admitted their products to the
 * shared live catalogue. The publish refusal is the useful boundary: it names
 * every missing prerequisite before writing a card, while the sandbox remains
 * a place a merchant can exercise the integration without this production
 * decision.
 */

import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { SANDBOX_FACILITATOR } from "../config.js";
import { type Harness, harness, type Served, serve } from "../testing/harness.js";

const INVITATION = "the-code-from-the-invitation";
const WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

const card = (merchantItemId: string): Card => ({
  merchant_item_id: merchantItemId,
  title: "A room",
  description: "A room sold by the merchant who published this card",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
});

let open: { harnessed: Harness; served: Served } | null = null;

const started = async (overrides: Record<string, string> = {}) => {
  const harnessed = await harness({ REGISTRATION_INVITATION: INVITATION, ...overrides });
  const served = await serve(harnessed);
  open = { harnessed, served };
  return open;
};

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

const bearer = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` });

const freshMerchant = async (served: Served): Promise<string> => {
  const made = await served.call("POST", "/v0/merchants", {
    body: { invitation: INVITATION },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return (made.body as { secret: string }).secret;
};

const name = async (served: Served, key: string): Promise<void> => {
  const named = await served.call("POST", "/v0/seller-name", {
    body: { seller_name: "Their own shop" },
    headers: bearer(key),
  });
  expect(named.status, JSON.stringify(named.body)).toBe(200);
};

const payTo = async (served: Served, key: string): Promise<void> => {
  const paid = await served.call("POST", "/v0/payout-wallet", {
    body: { payout_wallet: WALLET },
    headers: bearer(key),
  });
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
};

const publish = (served: Served, key: string, body: unknown) =>
  served.call("POST", "/v0/catalog/publish", { body, headers: bearer(key) });

describe("live publication before operator approval", () => {
  it("refuses an otherwise ready merchant and writes no card", async () => {
    const { served } = await started();
    const key = await freshMerchant(served);
    await name(served, key);
    await payTo(served, key);

    const refused = await publish(served, key, card("a-room"));

    expect(refused.status).toBe(422);
    const { problems } = (
      refused.body as { error: { problems: { code: string; path: string[] }[] } }
    ).error;
    expect(problems).toContainEqual({
      code: "no_operator_approval",
      path: [],
      message: expect.any(String),
    });

    const own = await served.call("GET", "/v0/cards", { headers: bearer(key) });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect((own.body as { cards: unknown[] }).cards).toStrictEqual([]);
  });

  it("reports every missing prerequisite beside an invalid card", async () => {
    const { served } = await started();
    const key = await freshMerchant(served);

    const refused = await publish(served, key, {
      ...card("another-room"),
      price: { amount: "not a number", currency: "USD" },
    });

    expect(refused.status).toBe(422);
    const { problems } = (
      refused.body as { error: { problems: { code: string; path: string[] }[] } }
    ).error;
    const codes = problems.map((problem) => problem.code);
    expect(codes).toContain("no_seller_name");
    expect(codes).toContain("no_payout_wallet");
    expect(codes).toContain("no_operator_approval");
    expect(problems.some((problem) => problem.path.includes("price"))).toBe(true);
  });

  it("does not require operator approval or a wallet in the sandbox", async () => {
    const { served } = await started({ FACILITATOR_URL: SANDBOX_FACILITATOR });
    const key = await freshMerchant(served);
    await name(served, key);

    const published = await publish(served, key, card("sandbox-room"));

    expect(published.status, JSON.stringify(published.body)).toBe(200);
  });
});
