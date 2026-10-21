/**
 * The product analytics the catalog, the selling switches and the merchant's
 * setup record, read off the memory store that every fact is written to. The
 * analytics team counts each of these events as one result of one explicit
 * operation, so the promises are as much about what is not recorded (a
 * republish, a setting saved again unchanged, a repeated grant) as about what
 * is. What only a real database can show, a race and a rollback, is in the
 * Postgres adapter's own suite.
 */

import type { Card } from "@nuanu-ai/agentify-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsEvent } from "../analytics/events.js";
import { type Harness, harness, type Served, serve } from "../testing/harness.js";
import { grantLiveApproval } from "./merchants.js";

/** Where the money is not real and a wallet change applies at once. */
const TEST = { PAYMENT_NETWORK: "eip155:84532", FACILITATOR_URL: "https://x402.org/facilitator" };
/** Base mainnet, where a wallet change waits and the operator admits a merchant. */
const LIVE = {
  PAYMENT_NETWORK: "eip155:8453",
  FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  CDP_API_KEY_ID: "key-id",
  CDP_API_KEY_SECRET: "key-secret",
};

const SIGNED_IN = { kind: "signed_in", email: "owner@example.com" } as const;

/** Two addresses with letters in them, written the way a wallet shows them. */
const A_WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const ANOTHER_WALLET = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";

const cardFor = (merchantItemId: string, title = "A room for the night"): Card => ({
  merchant_item_id: merchantItemId,
  title,
  description: `${title}, as its merchant describes it`,
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
});

const parcelFor = (merchantItemId: string): Card => ({
  merchant_item_id: merchantItemId,
  title: "Coffee beans, one kilogram",
  description: "Roasted this week and sent by courier.",
  price: { amount: "18.00", currency: "USD" },
  fulfillment: "ship",
  ship_within_seconds: 172_800,
  price_check: "handler",
});

let open: { harnessed: Harness; served: Served } | null = null;

const started = async (overrides: Record<string, string> = TEST) => {
  const harnessed = await harness(overrides);
  const served = await serve(harnessed);
  open = { harnessed, served };
  return open;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

const bearer = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` });

/** What `work` settles with, or "still waiting" once a second has passed without it. */
const within = async <T>(work: Promise<T>): Promise<T | "still waiting"> =>
  await Promise.race([
    work,
    new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 1_000)),
  ]);

/** A record of analytics that never ends, one that throws, and one that rejects. */
const RECORDINGS_GONE_WRONG: readonly [string, () => Promise<void>][] = [
  ["never ends", () => new Promise<void>(() => undefined)],
  [
    "throws",
    () => {
      throw new Error("the outbox broke");
    },
  ],
  ["rejects", async () => await Promise.reject(new Error("the outbox broke"))],
];

/** The events of one name the store has recorded so far, oldest first. */
const recorded = <Name extends AnalyticsEvent["name"]>(
  harnessed: Harness,
  name: Name,
): Extract<AnalyticsEvent, { name: Name }>[] =>
  harnessed.store.recordedAnalytics
    .map(({ event }) => event)
    .filter((event): event is Extract<AnalyticsEvent, { name: Name }> => event.name === name);

/** The setup results of one step, oldest first. */
const setupOf = (harnessed: Harness, step: string) =>
  recorded(harnessed, "agc_setup_result").filter((event) => event.fields.step === step);

const keyOf = (harnessed: Harness) => ({ kind: "key", keyId: harnessed.merchant.keyId }) as const;

describe("the result of publishing a card", () => {
  it("records one completed publication naming the new card, and none when the card is published again", async () => {
    const { harnessed } = await started();
    const merchant = harnessed.merchant.id;

    const first = await harnessed.gateway.publishCard(
      merchant,
      cardFor("room-101"),
      "api",
      keyOf(harnessed),
    );
    const again = await harnessed.gateway.publishCard(
      merchant,
      cardFor("room-101", "A room for the night, dearer"),
      "api",
      keyOf(harnessed),
    );

    expect(first.ok && again.ok && first.id === again.id).toBe(true);
    expect(recorded(harnessed, "agc_card_publish_result")).toStrictEqual([
      {
        name: "agc_card_publish_result",
        actor: "merchant_worker",
        source: "gateway",
        refs: { merchant, item: first.ok ? first.id : "" },
        fields: { integration: "api", outcome: "completed" },
      },
    ]);
  });

  it("records a publication through the merchant's key over the API as the merchant's code", async () => {
    const { harnessed, served } = await started();

    const answered = await served.call("POST", "/v0/catalog/publish", {
      body: cardFor("room-202"),
      headers: bearer(harnessed.merchant.key),
    });

    expect(answered.status).toBe(200);
    expect(recorded(harnessed, "agc_card_publish_result")).toMatchObject([
      { actor: "merchant_worker", source: "gateway", fields: { outcome: "completed" } },
    ]);
  });

  it("records one blocked result for a refused publication, with the reason of its first finding, and writes no card", async () => {
    const { harnessed } = await started();
    // A merchant with nothing set and a card with nothing in it: several
    // findings, one attempt, so one result, and the merchant's are first.
    const merchant = await harnessed.gateway.registerMerchant();

    const refused = await harnessed.gateway.publishCard(merchant, {}, "api", keyOf(harnessed));

    expect(refused.ok).toBe(false);
    expect(refused.ok ? [] : refused.error.problems.length).toBeGreaterThan(1);
    expect(await harnessed.store.cards(merchant)).toStrictEqual([]);
    expect(recorded(harnessed, "agc_card_publish_result")).toStrictEqual([
      {
        name: "agc_card_publish_result",
        actor: "merchant_worker",
        source: "gateway",
        refs: { merchant },
        fields: { integration: "api", outcome: "blocked", reason_code: "profile_missing" },
      },
    ]);
  });

  it("names each refusal by what stands in the card's way", async () => {
    const { harnessed } = await started();
    const named = await harnessed.gateway.registerMerchant();
    await harnessed.gateway.setSellerName(named, { seller_name: "A shop with no wallet" });
    const merchant = harnessed.merchant.id;
    await harnessed.store.publishCard(merchant, cardFor("mug-1"), harnessed.now(), "woocommerce");

    const reasons: [string, () => Promise<unknown>][] = [
      ["wallet_missing", () => harnessed.gateway.publishCard(named, cardFor("room-1"))],
      ["seller_site_missing", () => harnessed.gateway.publishCard(merchant, parcelFor("beans"))],
      [
        "invalid_input",
        () => harnessed.gateway.publishCard(merchant, { ...cardFor("room-2"), price: "free" }),
      ],
      [
        "integration_mismatch",
        () => harnessed.gateway.publishCard(merchant, cardFor("room-3"), "woocommerce"),
      ],
      ["integration_mismatch", () => harnessed.gateway.publishCard(merchant, cardFor("mug-1"))],
    ];
    for (const [, publish] of reasons) await publish();

    expect(
      recorded(harnessed, "agc_card_publish_result").map((event) => event.fields.reason_code),
    ).toStrictEqual(reasons.map(([reason]) => reason));
  });

  it("records the refusals only the live channel makes: no operator approval, and a parcel", async () => {
    const { harnessed } = await started(LIVE);
    const unapproved = await harnessed.gateway.registerMerchant();
    await harnessed.gateway.setSellerName(unapproved, { seller_name: "A shop not yet admitted" });
    await harnessed.gateway.setPayoutWallet(unapproved, A_WALLET, SIGNED_IN);
    const merchant = harnessed.merchant.id;
    await harnessed.gateway.setSellerName(merchant, { seller_site: "https://shop.example.com" });

    await harnessed.gateway.publishCard(unapproved, cardFor("room-1"));
    await harnessed.gateway.publishCard(merchant, parcelFor("beans"));

    expect(
      recorded(harnessed, "agc_card_publish_result").map((event) => event.fields.reason_code),
    ).toStrictEqual(["approval_required", "unsupported_channel"]);
  });

  it("records a publication whose write failed as failed, and still throws the failure", async () => {
    const { harnessed } = await started();
    vi.spyOn(harnessed.store, "publishCard").mockRejectedValueOnce(
      new Error("the database went away"),
    );

    await expect(
      harnessed.gateway.publishCard(harnessed.merchant.id, cardFor("room-1")),
    ).rejects.toThrow("the database went away");

    expect(recorded(harnessed, "agc_card_publish_result")).toStrictEqual([
      {
        name: "agc_card_publish_result",
        actor: "unknown",
        source: "gateway",
        refs: { merchant: harnessed.merchant.id },
        fields: { integration: "api", outcome: "failed", reason_code: "internal_error" },
      },
    ]);
  });
});

describe("a refusal whose recording goes wrong", () => {
  // Stand-ins rather than spies: a spy settles what its stand-in returns, so a
  // rejection nobody else caught would never be seen as one.
  const rejected: unknown[] = [];
  const rejection = (reason: unknown) => rejected.push(reason);
  /** Every rejection nothing caught, once what the test started has settled. */
  const leftUncaught = async (): Promise<unknown[]> => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return rejected;
  };
  beforeEach(() => {
    rejected.length = 0;
    process.on("unhandledRejection", rejection);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.off("unhandledRejection", rejection);
  });

  for (const [wrong, recording] of RECORDINGS_GONE_WRONG) {
    it(`answers a refused publication at once when recording it ${wrong}`, async () => {
      const { harnessed } = await started();
      harnessed.store.recordAnalytics = recording;
      const merchant = await harnessed.gateway.registerMerchant();

      const refused = await within(harnessed.gateway.publishCard(merchant, {}, "api"));

      expect(refused).toMatchObject({ ok: false });
      expect(await leftUncaught()).toStrictEqual([]);
    });

    it(`throws a failed publication's own failure at once when recording it ${wrong}`, async () => {
      const { harnessed } = await started();
      harnessed.store.recordAnalytics = recording;
      vi.spyOn(harnessed.store, "publishCard").mockRejectedValueOnce(
        new Error("the database went away"),
      );

      const failed = await within(
        harnessed.gateway.publishCard(harnessed.merchant.id, cardFor("room-1")).then(
          () => "published",
          (thrown: unknown) => (thrown instanceof Error ? thrown.message : "not an error"),
        ),
      );

      expect(failed).toBe("the database went away");
      expect(await leftUncaught()).toStrictEqual([]);
    });

    it(`answers a body the API refused with its 400 at once when recording it ${wrong}`, async () => {
      const { harnessed, served } = await started();
      harnessed.gateway.setupRefused = recording;

      const refused = await within(
        served.call("POST", "/v0/seller-name", {
          body: { seller_name: "é".repeat(40) },
          headers: bearer(harnessed.merchant.key),
        }),
      );

      expect(refused).toMatchObject({ status: 400, body: { error: { code: "malformed_body" } } });
      expect(await leftUncaught()).toStrictEqual([]);
    });
  }
});

describe("a card or a merchant taken off sale and put back", () => {
  it("records each change of a card once, and nothing for a pause or a resume that changes nothing", async () => {
    const { harnessed, served } = await started();
    const merchant = harnessed.merchant.id;
    const published = await harnessed.gateway.publishCard(merchant, cardFor("room-1"));
    const item = published.ok ? published.id : "";
    const press = (path: string) =>
      served.call("POST", `/v0/cards/${item}/${path}`, { headers: bearer(harnessed.merchant.key) });

    await press("pause");
    await press("pause");
    await press("resume");
    await press("resume");

    const change = (to: "paused" | "resumed") => ({
      name: "agc_selling_changed",
      actor: "merchant_worker",
      source: "gateway",
      refs: { merchant, item },
      fields: { entity: "card", change: to },
    });
    expect(recorded(harnessed, "agc_selling_changed")).toStrictEqual([
      change("paused"),
      change("resumed"),
    ]);
  });

  it("records nothing for a card that is not this merchant's", async () => {
    const { harnessed } = await started();
    const other = await harnessed.addMerchant();
    const theirs = await harnessed.gateway.publishCard(other.id, cardFor("room-1"));

    const answered = await harnessed.gateway.setCardPaused(
      harnessed.merchant.id,
      theirs.ok ? theirs.id : "",
      true,
      SIGNED_IN,
    );

    expect(answered).toBeNull();
    expect(recorded(harnessed, "agc_selling_changed")).toStrictEqual([]);
  });

  it("records each change of the merchant's selling once, as asked in the dashboard", async () => {
    const { harnessed } = await started();
    const merchant = harnessed.merchant.id;

    await harnessed.gateway.setSelling(merchant, "paused", SIGNED_IN);
    await harnessed.gateway.setSelling(merchant, "paused", SIGNED_IN);
    await harnessed.gateway.setSelling(merchant, "open", SIGNED_IN);
    await harnessed.gateway.setSelling(merchant, "open", SIGNED_IN);

    const change = (to: "paused" | "resumed") => ({
      name: "agc_selling_changed",
      actor: "human",
      source: "dashboard",
      refs: { merchant },
      fields: { entity: "merchant", change: to },
    });
    expect(recorded(harnessed, "agc_selling_changed")).toStrictEqual([
      change("paused"),
      change("resumed"),
    ]);
  });

  it("records the pause a switch back to the merchant's code makes, so their resume follows a pause", async () => {
    const { harnessed } = await started();
    const merchant = harnessed.merchant.id;
    await harnessed.gateway.publishCard(merchant, cardFor("room-1"));
    await harnessed.gateway.sellThrough(merchant, "woocommerce", SIGNED_IN);

    const switched = await harnessed.gateway.sellThrough(merchant, "api", SIGNED_IN);
    await harnessed.gateway.setSelling(merchant, "open", SIGNED_IN);

    expect(switched).toStrictEqual({ switched: true, sellingPaused: true });
    expect(recorded(harnessed, "agc_selling_changed")).toStrictEqual(
      (["paused", "resumed"] as const).map((change) => ({
        name: "agc_selling_changed",
        actor: "human",
        source: "dashboard",
        refs: { merchant },
        fields: { entity: "merchant", change },
      })),
    );
  });

  it("records nothing for a departed merchant's refused resume", async () => {
    const { harnessed } = await started();
    await harnessed.store.setSelling(harnessed.merchant.id, "departed");

    const refused = await harnessed.gateway.setSelling(harnessed.merchant.id, "open", SIGNED_IN);

    expect(refused.ok).toBe(false);
    expect(recorded(harnessed, "agc_selling_changed")).toStrictEqual([]);
  });
});

describe("the merchant's setup", () => {
  it("records a seller name and a shop's site when saved, and nothing when saved again unchanged", async () => {
    const { harnessed } = await started();
    const merchant = harnessed.merchant.id;

    await harnessed.gateway.setSellerName(
      merchant,
      { seller_name: "A new name", seller_site: "https://shop.example.com" },
      SIGNED_IN,
    );
    await harnessed.gateway.setSellerName(
      merchant,
      { seller_name: "A new name", seller_site: "https://shop.example.com" },
      SIGNED_IN,
    );

    const saved = (step: "seller_name" | "seller_site") => ({
      name: "agc_setup_result",
      actor: "human",
      source: "dashboard",
      refs: { merchant },
      fields: { step, integration: "none", outcome: "completed" },
    });
    expect(recorded(harnessed, "agc_setup_result")).toStrictEqual([
      saved("seller_name"),
      saved("seller_site"),
    ]);
  });

  it("records a seller name refused at the API as blocked, for the step it asked for, and saves nothing", async () => {
    const { harnessed, served } = await started();

    const refused = await served.call("POST", "/v0/seller-name", {
      body: { seller_name: "é".repeat(40) },
      headers: bearer(harnessed.merchant.key),
    });

    expect(refused.status).toBe(400);
    expect((await harnessed.gateway.sellerName(harnessed.merchant.id)).seller_name).toBe(
      "The merchant",
    );
    expect(recorded(harnessed, "agc_setup_result")).toStrictEqual([
      {
        name: "agc_setup_result",
        actor: "merchant_worker",
        source: "gateway",
        refs: { merchant: harnessed.merchant.id },
        fields: {
          step: "seller_name",
          integration: "none",
          outcome: "blocked",
          reason_code: "invalid_input",
        },
      },
    ]);
  });

  it("records a key issued as the API's setup step, and a key refused at the API as blocked", async () => {
    const { harnessed, served } = await started();
    const merchant = harnessed.merchant.id;

    await harnessed.gateway.issueMerchantKey(merchant, "the warehouse worker", SIGNED_IN);
    const refused = await served.call("POST", "/v0/keys", {
      body: { label: "" },
      headers: bearer(harnessed.merchant.key),
    });

    expect(refused.status).toBe(400);
    expect(setupOf(harnessed, "api_key")).toStrictEqual([
      {
        name: "agc_setup_result",
        actor: "human",
        source: "dashboard",
        refs: { merchant },
        fields: { step: "api_key", integration: "api", outcome: "completed" },
      },
      {
        name: "agc_setup_result",
        actor: "merchant_worker",
        source: "gateway",
        refs: { merchant },
        fields: {
          step: "api_key",
          integration: "api",
          outcome: "blocked",
          reason_code: "invalid_input",
        },
      },
    ]);
  });

  it("records a payout wallet saved, nothing for the same wallet again, and a refused one as blocked", async () => {
    const { harnessed } = await started();
    const merchant = harnessed.merchant.id;

    await harnessed.gateway.setPayoutWallet(merchant, A_WALLET, SIGNED_IN);
    await harnessed.gateway.setPayoutWallet(merchant, A_WALLET.toLowerCase(), SIGNED_IN);
    const refused = await harnessed.gateway.setPayoutWallet(
      merchant,
      "0x0000000000000000000000000000000000000000",
      SIGNED_IN,
    );

    expect(refused).toMatchObject({ refused: "not_a_payout_wallet" });
    expect(setupOf(harnessed, "payout_wallet").map((event) => event.fields)).toStrictEqual([
      { step: "payout_wallet", integration: "none", outcome: "completed" },
      {
        step: "payout_wallet",
        integration: "none",
        outcome: "blocked",
        reason_code: "invalid_input",
      },
    ]);
  });

  it("records a live replacement wallet as pending, nothing when it is asked for again, and its cancel as completed", async () => {
    const { harnessed } = await started(LIVE);
    const merchant = await harnessed.gateway.registerMerchant();

    await harnessed.gateway.setPayoutWallet(merchant, A_WALLET, SIGNED_IN);
    await harnessed.gateway.setPayoutWallet(merchant, A_WALLET, SIGNED_IN);
    await harnessed.gateway.setPayoutWallet(merchant, ANOTHER_WALLET, SIGNED_IN);
    await harnessed.gateway.setPayoutWallet(merchant, ANOTHER_WALLET, SIGNED_IN);
    await harnessed.gateway.setPayoutWallet(merchant, A_WALLET, SIGNED_IN);

    expect(
      setupOf(harnessed, "payout_wallet").map((event) => [event.refs, event.fields.outcome]),
    ).toStrictEqual([
      [{ merchant }, "completed"],
      [{ merchant }, "pending"],
      [{ merchant }, "completed"],
    ]);
  });

  it("records a live replacement that could not be announced as failed, and writes nothing", async () => {
    const { harnessed } = await started(LIVE);
    const merchant = await harnessed.gateway.registerMerchant();
    await harnessed.gateway.setPayoutWallet(merchant, A_WALLET, SIGNED_IN);
    harnessed.announcer.answer = "not_handed_over";

    const refused = await harnessed.gateway.setPayoutWallet(merchant, ANOTHER_WALLET, SIGNED_IN);

    expect(refused).toBe("not_announced");
    expect((await harnessed.gateway.payoutWallet(merchant)).pending).toBeNull();
    expect(setupOf(harnessed, "payout_wallet").map((event) => event.fields)).toStrictEqual([
      { step: "payout_wallet", integration: "none", outcome: "completed" },
      {
        step: "payout_wallet",
        integration: "none",
        outcome: "failed",
        reason_code: "dependency_unavailable",
      },
    ]);
  });

  it("records the operator's first grant of live sales, and nothing for a grant repeated", async () => {
    const { harnessed } = await started(LIVE);
    const merchant = await harnessed.gateway.registerMerchant();

    await grantLiveApproval(harnessed.store, merchant, harnessed.now());
    await grantLiveApproval(harnessed.store, merchant, harnessed.now() + 1_000);

    expect(
      setupOf(harnessed, "live_approval").filter((event) => event.refs?.merchant === merchant),
    ).toStrictEqual([
      {
        name: "agc_setup_result",
        actor: "operator",
        source: "dashboard",
        refs: { merchant },
        fields: { step: "live_approval", integration: "none", outcome: "completed" },
      },
    ]);
  });
});
