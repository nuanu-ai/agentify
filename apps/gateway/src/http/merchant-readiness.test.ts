/**
 * What the publish door asks of a merchant, on each of the three surfaces.
 *
 * A merchant's engineer learns what their merchant lacks in one place: the
 * refusal of a publish. Nothing else on the public surface answers the
 * question in advance, so this refusal has to be complete and exact on every
 * surface — a finding the door forgot is a card published for a merchant who
 * cannot sell, and a finding the door invented is a merchant sent to set
 * something the surface does not need. Each case below takes one fact away
 * from a merchant who otherwise has everything, and publishes a card with
 * nothing wrong with it, so what comes back is the door's judgement of the
 * merchant and of nothing else.
 */

import { type Card, MERCHANT_FINDINGS, type MerchantFinding } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { grantLiveApproval } from "../app/merchants.js";
import { SANDBOX_FACILITATOR } from "../config.js";
import { ANNOUNCING, type Harness, harness, type Served, serve } from "../testing/harness.js";

const INVITATION = "the-code-from-the-invitation";
const WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

/** What each surface is configured with, as the deployment's own variables. */
const SURFACES = {
  sandbox: { PAYMENT_NETWORK: "eip155:84532", FACILITATOR_URL: SANDBOX_FACILITATOR },
  test: { PAYMENT_NETWORK: "eip155:84532", FACILITATOR_URL: "https://x402.org/facilitator" },
  live: {
    PAYMENT_NETWORK: "eip155:8453",
    FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
    CDP_API_KEY_ID: "key-id",
    CDP_API_KEY_SECRET: "key-secret",
    ...ANNOUNCING,
  },
} as const;
type Surface = keyof typeof SURFACES;

const CARD: Card = {
  merchant_item_id: "a-room",
  title: "A room",
  description: "A room sold by the merchant who published this card",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

let open: { harnessed: Harness; served: Served } | null = null;

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

const bearer = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` });

interface Holding {
  readonly name: boolean;
  readonly wallet: boolean;
  readonly approval: boolean;
}

/**
 * A merchant made through the registration door on this surface, holding what
 * the case says and nothing else, and a key of theirs.
 */
const aMerchant = async (surface: Surface, holding: Holding) => {
  const harnessed = await harness({ REGISTRATION_INVITATION: INVITATION, ...SURFACES[surface] });
  const served = await serve(harnessed);
  open = { harnessed, served };
  const made = await served.call("POST", "/v0/merchants", { body: { invitation: INVITATION } });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const { merchant_id: id, secret: key } = made.body as { merchant_id: string; secret: string };
  if (holding.name) {
    const named = await served.call("POST", "/v0/seller-name", {
      body: { seller_name: "Their own shop" },
      headers: bearer(key),
    });
    expect(named.status, JSON.stringify(named.body)).toBe(200);
  }
  if (holding.wallet) {
    const paid = await served.call("POST", "/v0/payout-wallet", {
      body: { payout_wallet: WALLET },
      headers: bearer(key),
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  }
  if (holding.approval) {
    await grantLiveApproval(harnessed.store, id, harnessed.now());
  }
  return { served, key };
};

interface Refusal {
  readonly message: string;
  readonly problems: readonly { path: string[]; code: string; message: string }[];
}

const publish = async (served: Served, key: string, card: unknown) =>
  served.call("POST", "/v0/catalog/publish", { body: card, headers: bearer(key) });

const THE_MERCHANT_S: ReadonlySet<string> = new Set(Object.values(MERCHANT_FINDINGS));

/** The findings about the merchant in a refusal, as a program would pick them out. */
const aboutTheMerchant = (refusal: Refusal): readonly string[] =>
  refusal.problems.filter((finding) => THE_MERCHANT_S.has(finding.code)).map((f) => f.code);

const EVERYTHING: Holding = { name: true, wallet: true, approval: true };

/** One fact taken away, and what each surface says about its absence. */
const CASES: readonly {
  readonly without: keyof Holding;
  readonly refused: Readonly<Record<Surface, readonly MerchantFinding[]>>;
}[] = [
  {
    without: "name",
    refused: {
      sandbox: [MERCHANT_FINDINGS.NO_SELLER_NAME],
      test: [MERCHANT_FINDINGS.NO_SELLER_NAME],
      live: [MERCHANT_FINDINGS.NO_SELLER_NAME],
    },
  },
  {
    without: "wallet",
    refused: {
      sandbox: [],
      test: [MERCHANT_FINDINGS.NO_PAYOUT_WALLET],
      live: [MERCHANT_FINDINGS.NO_PAYOUT_WALLET],
    },
  },
  {
    without: "approval",
    refused: { sandbox: [], test: [], live: [MERCHANT_FINDINGS.NO_OPERATOR_APPROVAL] },
  },
];

describe("what the publish door asks of a merchant", () => {
  for (const surface of Object.keys(SURFACES) as Surface[]) {
    it(`publishes for a merchant who has everything, on ${surface}`, async () => {
      const { served, key } = await aMerchant(surface, EVERYTHING);

      const published = await publish(served, key, CARD);

      expect(published.status, JSON.stringify(published.body)).toBe(200);
    });

    for (const { without, refused } of CASES) {
      const expected = refused[surface];
      it(`${expected.length === 0 ? "does not ask" : "refuses"} for the ${without}, on ${surface}`, async () => {
        const { served, key } = await aMerchant(surface, { ...EVERYTHING, [without]: false });

        const answered = await publish(served, key, CARD);

        if (expected.length === 0) {
          expect(answered.status, JSON.stringify(answered.body)).toBe(200);
          return;
        }
        expect(answered.status).toBe(422);
        const refusal = (answered.body as { error: Refusal }).error;
        expect(aboutTheMerchant(refusal)).toStrictEqual(expected);
        // About the merchant, so pointing at no field of the card, and the
        // only findings: the card itself has nothing wrong with it.
        expect(refusal.problems.map((finding) => finding.path)).toStrictEqual([[]]);
      });
    }
  }
});

describe("the one line a refusal is read by", () => {
  // `problems` is the answer a program reads; the message is what a person
  // reads in a log, and for a merchant who lacks something it used to be the
  // first finding cut off at a hundred and sixty letters, mid-sentence and
  // before it said how to fix it. Where the merchant is what stands in the
  // way, the line says which of their settings are missing, all of them and
  // only them, and says it whole.
  const NOTHING: Holding = { name: false, wallet: false, approval: false };

  it("names every missing merchant setting, whole", async () => {
    const { served, key } = await aMerchant("live", NOTHING);

    const refusal = ((await publish(served, key, CARD)).body as { error: Refusal }).error;

    expect(refusal.message).toMatch(/seller name/i);
    expect(refusal.message).toMatch(/payout wallet/i);
    expect(refusal.message).toMatch(/approv/i);
    expect(refusal.message).not.toMatch(/cut short/i);
    expect(aboutTheMerchant(refusal)).toHaveLength(3);
  });

  it("names only what is missing", async () => {
    const { served, key } = await aMerchant("test", { ...EVERYTHING, name: false });

    const { message } = ((await publish(served, key, CARD)).body as { error: Refusal }).error;

    expect(message).toMatch(/seller name/i);
    expect(message).not.toMatch(/wallet/i);
    expect(message).not.toMatch(/approv/i);
  });

  it("still points at the card's own findings beside the merchant's", async () => {
    const { served, key } = await aMerchant("test", NOTHING);

    const refusal = (
      (await publish(served, key, { ...CARD, price: { amount: "not a number", currency: "USD" } }))
        .body as { error: Refusal }
    ).error;

    expect(refusal.message).toMatch(/seller name/i);
    expect(refusal.message).toMatch(/payout wallet/i);
    expect(refusal.message).toContain("price");
    expect(refusal.problems.some((finding) => finding.path.includes("price"))).toBe(true);
  });

  it("says nothing about the merchant where the card alone is at fault", async () => {
    const { served, key } = await aMerchant("sandbox", { ...EVERYTHING, wallet: false });

    const refusal = (
      (await publish(served, key, { ...CARD, price: { amount: "not a number", currency: "USD" } }))
        .body as { error: Refusal }
    ).error;

    expect(aboutTheMerchant(refusal)).toStrictEqual([]);
    expect(refusal.message).toContain("price");
    expect(refusal.message).not.toMatch(/merchant has/i);
  });
});
