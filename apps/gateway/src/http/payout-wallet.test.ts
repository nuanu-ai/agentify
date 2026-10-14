/**
 * The wallet a merchant's share is paid into, and the split a buyer's agent is
 * told to pay: a contract that pays that wallet the merchant's share and
 * Agentify its commission, recorded with the wallet and named in every payment
 * request from the record. Nothing can call a payment back. Only a signed-in
 * dashboard session sets the wallet, in-process; reading it, publishing and the
 * payment request an agent is sent all go through `serve`.
 *
 * A merchant with no wallet is refused at publish, where they can still be
 * told, rather than at the till. The address in a payment request must be the
 * publishing merchant's split, so those claims are tested with two merchants:
 * a gateway that paid every sale to one address would pass every
 * single-merchant assertion. The sandbox, with no chain and no money behind
 * it, pays a split of its configured placeholder where a merchant set none.
 */

import { type Card, PayoutWalletSchema } from "@nuanu-ai/agentify-contracts";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { afterEach, describe, expect, it } from "vitest";
import { SANDBOX_FACILITATOR } from "../config.js";
import { handEncoded } from "../split/fixture.js";
import { payoutSplitNetworkOf } from "../split/networks.js";
import { payoutSplitFor } from "../split/parameters.js";
import {
  buyOverHttp,
  drawEverything,
  type Harness,
  harness,
  loggedWhile,
  type Served,
  SPLIT_NETWORKS_WITH_A_FIXTURE_BASE,
  serve,
} from "../testing/harness.js";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER } from "./x402.js";

/** The address the gateway itself is configured with: the operator's, not a merchant's. */
const CONFIGURED_PAY_TO = "0x0000000000000000000000000000000000000001";

/** The session every wallet change here is made as, the way the dashboard makes one. */
const SIGNED_IN = { kind: "signed_in", email: "owner@example.com" } as const;

/**
 * Two distinct addresses in the checksum spelling a wallet shows, which is the
 * spelling the gateway stores and answers with. Both contain letters the
 * checksum capitalises: an all-digit address reads the same in any spelling and
 * would pin nothing.
 */
const A_WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const ANOTHER_WALLET = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";

const A_WALLET_IN_LOWER = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";

const cardFor = (merchantItemId: string, title: string): Card => ({
  merchant_item_id: merchantItemId,
  title,
  description: `${title}, sold by whoever published this card`,
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
});

let open: { harnessed: Harness; served: Served } | null = null;

const started = async (overrides: Record<string, string> = {}) => {
  const harnessed = await harness({ PAY_TO_ADDRESS: CONFIGURED_PAY_TO, ...overrides });
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

/** Where this merchant is paid right now, read back over the route. */
const payoutWallet = async (served: Served, key: string) => {
  const answered = await served.call("GET", "/v0/payout-wallet", { headers: bearer(key) });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return answered.body as { payout_wallet: string | null; pending: unknown };
};

/** Sets the wallet the way the dashboard's Settings screen does. */
const setPayoutWallet = (harnessed: Harness, merchantId: string, wallet: string) =>
  harnessed.gateway.setPayoutWallet(merchantId, wallet, SIGNED_IN);

/**
 * A merchant with no wallet and no name, registered the way the dashboard does
 * it, with a key for their own code: a real merchant between signing up and
 * setting either.
 */
const fresh = async (harnessed: Harness): Promise<{ merchantId: string; key: string }> => {
  const merchantId = await harnessed.gateway.registerMerchant();
  const issued = await harnessed.gateway.issueMerchantKey(
    merchantId,
    "the stock worker",
    SIGNED_IN,
  );
  return { merchantId, key: issued.secret };
};

/** One merchant ready to sell but for the wallet: named, and nothing else. */
const named = async (served: Served, key: string, name: string): Promise<void> => {
  const answered = await served.call("POST", "/v0/seller-name", {
    body: { seller_name: name },
    headers: bearer(key),
  });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
};

const publishing = (served: Served, key: string, card: Card) =>
  served.call("POST", "/v0/catalog/publish", { body: card, headers: bearer(key) });

const publish = async (served: Served, key: string, card: Card): Promise<string> => {
  const answered = await publishing(served, key, card);
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return (answered.body as { id: string }).id;
};

/** The address a buyer's agent is actually told to pay for one product. */
const payToInTheChallenge = async (served: Served, itemId: string): Promise<string | undefined> => {
  const answered = await served.call("GET", `/x402/${itemId}/purchase`);
  expect(answered.status, JSON.stringify(answered.body)).toBe(402);
  const challenge = decodePaymentRequiredHeader(
    answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
  );
  return challenge.accepts[0]?.payTo;
};

/** What the purchase's own first step, the POST that opens an order, tells an agent to pay. */
const payToWhenBuying = async (served: Served, itemId: string): Promise<string | undefined> => {
  const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
    body: { params: {} },
  });
  expect(answered.status, JSON.stringify(answered.body)).toBe(402);
  return decodePaymentRequiredHeader(answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "").accepts[0]
    ?.payTo;
};

/**
 * The address of the split recorded for this merchant and wallet. Found in the
 * registry by the address the rule gives, and refused unless the row there
 * names this merchant and wallet, so a test comparing with it compares with
 * the record and not with arithmetic alone.
 */
const recordedSplit = async (
  harnessed: Harness,
  merchantId: string,
  wallet: string,
): Promise<string> => {
  const computed = payoutSplitFor(harnessed.runtime.config.payoutSplit, merchantId, wallet);
  const row = await harnessed.store.payoutSplitAt(computed.address);
  expect(row, `no split is recorded for ${merchantId} at ${wallet}`).not.toBeNull();
  expect(row?.merchantId).toBe(merchantId);
  expect(row?.merchantWallet).toBe(wallet);
  return computed.address;
};

/** The split the sandbox pays for a merchant who set no wallet, never recorded. */
const placeholderSplit = (merchantId: string): string =>
  payoutSplitFor(
    payoutSplitNetworkOf(SPLIT_NETWORKS_WITH_A_FIXTURE_BASE, "eip155:84532"),
    merchantId,
    CONFIGURED_PAY_TO,
  ).address;

describe("the wallet a merchant is paid at", () => {
  it("reads back nothing for a merchant who has set none", async () => {
    // Null, not an empty string and not a 404: "there is none" must not read as
    // "I could not find you".
    const { served, harnessed } = await started();
    const { key } = await fresh(harnessed);

    expect(await payoutWallet(served, key)).toStrictEqual({ payout_wallet: null, pending: null });
  });

  it("sets a wallet and hands back what was written rather than what was sent", async () => {
    const { served, harnessed } = await started();

    const answered = await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);

    expect(answered).toStrictEqual({ payout_wallet: A_WALLET, pending: null });
    // Read again, so the answer above is shown to be the row and not an echo of
    // the request.
    expect(await payoutWallet(served, harnessed.merchant.key)).toStrictEqual({
      payout_wallet: A_WALLET,
      pending: null,
    });
  });

  it("takes the lower-case spelling too, and answers in the one a wallet shows", async () => {
    // Block explorers print the lower-case spelling. The answer is in the form a
    // wallet shows, because a merchant cannot tell the same address in another
    // spelling from a different address.
    const { harnessed } = await started();

    const answered = await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET_IN_LOWER);

    expect(answered).toStrictEqual({ payout_wallet: A_WALLET, pending: null });
    expect(A_WALLET_IN_LOWER).not.toBe(A_WALLET);
  });

  it("writes nothing for a value that is not an address, whoever skipped holding it", async () => {
    // The gateway checks again behind the dashboard. Capitals that disagree with
    // the checksum mean a character is wrong, and a wrong address may be
    // somebody else's valid one, which nothing downstream would notice.
    const { served, harnessed } = await started();
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);

    await expect(
      setPayoutWallet(
        harnessed,
        harnessed.merchant.id,
        "0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      ),
    ).rejects.toThrow();
    await expect(setPayoutWallet(harnessed, harnessed.merchant.id, "0x1234")).rejects.toThrow();

    // A refusal that had already written would be worse than no rule at all.
    expect(await payoutWallet(served, harnessed.merchant.key)).toStrictEqual({
      payout_wallet: A_WALLET,
      pending: null,
    });
  });

  it("changes a wallet that is already set, which is what a merchant wanted anyway", async () => {
    const { served, harnessed } = await started();
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);

    const moved = await setPayoutWallet(harnessed, harnessed.merchant.id, ANOTHER_WALLET);

    expect(moved).toStrictEqual({ payout_wallet: ANOTHER_WALLET, pending: null });
    expect(await payoutWallet(served, harnessed.merchant.key)).toStrictEqual({
      payout_wallet: ANOTHER_WALLET,
      pending: null,
    });
  });

  it("pays the merchant the change was made for and nobody else", async () => {
    // A write to every merchant would pass any single-merchant assertion.
    const { served, harnessed } = await started();
    const first = await harnessed.addMerchant("First shop");
    const second = await harnessed.addMerchant("Second shop");

    await setPayoutWallet(harnessed, first.id, A_WALLET);

    expect(await payoutWallet(served, first.key)).toStrictEqual({
      payout_wallet: A_WALLET,
      pending: null,
    });
    expect((await payoutWallet(served, second.key)).payout_wallet).not.toBe(A_WALLET);
  });

  it("reads it with any key of the merchant's, and with no key not at all", async () => {
    // Reading moves no money, and a merchant's own code may need it, for a
    // reconciliation or a check before selling.
    const { served, harnessed } = await started();
    const { merchantId, key } = await fresh(harnessed);
    await setPayoutWallet(harnessed, merchantId, A_WALLET);

    expect(await payoutWallet(served, key)).toStrictEqual({
      payout_wallet: A_WALLET,
      pending: null,
    });
    expect((await served.call("GET", "/v0/payout-wallet")).status).toBe(401);
  });
});

describe("publishing before a wallet has been set", () => {
  it("refuses a merchant with no wallet, and says where to set one", async () => {
    const { served, harnessed } = await started();
    const { key } = await fresh(harnessed);
    await named(served, key, "Their own shop");

    const refused = await publishing(served, key, cardFor("a-room", "A room"));

    expect(refused.status).toBe(422);
    const { problems } = (
      refused.body as { error: { problems: { code: string; message: string }[] } }
    ).error;
    // What is missing is not on the card, so the message must send the merchant
    // to the dashboard's settings, the only place the wallet is set.
    const said = problems.find((finding) => finding.code === "no_payout_wallet")?.message ?? "";
    expect(said).toMatch(/dashboard/i);
    expect(said).toMatch(/settings/i);
    expect(said).not.toContain("/v0/payout-wallet");
  });

  it("writes nothing, so the card is not there afterwards", async () => {
    const { served, harnessed } = await started();
    const { key } = await fresh(harnessed);
    await named(served, key, "Their own shop");

    await publishing(served, key, cardFor("a-room", "A room"));

    const own = await served.call("GET", "/v0/cards", { headers: bearer(key) });
    expect((own.body as { cards: unknown[] }).cards).toStrictEqual([]);
  });

  it("lets a merchant publish as soon as they set one", async () => {
    const { served, harnessed } = await started();
    const { merchantId, key } = await fresh(harnessed);
    await named(served, key, "Their own shop");
    expect((await publishing(served, key, cardFor("a-room", "A room"))).status).toBe(422);

    await setPayoutWallet(harnessed, merchantId, A_WALLET);

    const itemId = await publish(served, key, cardFor("a-room", "A room"));
    expect(await payToInTheChallenge(served, itemId)).toBe(
      await recordedSplit(harnessed, merchantId, A_WALLET),
    );
  });
});

describe("who an agent is told to pay", () => {
  it("names the recorded split of the publishing merchant's wallet, on the probe and on the purchase", async () => {
    // The commission rests on every payment going to the split: the merchant's
    // code, the agent and the facilitator all act on this one string, and the
    // wallet itself would be paid in full.
    const { served, harnessed } = await started();
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);
    const itemId = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));
    const split = (await harnessed.store.merchantById(harnessed.merchant.id))?.payoutWallet.split;

    expect(split?.merchantWallet).toBe(A_WALLET);
    expect(await payToInTheChallenge(served, itemId)).toBe(split?.address);
    expect(await payToWhenBuying(served, itemId)).toBe(split?.address);
    expect(await payToInTheChallenge(served, itemId)).not.toBe(A_WALLET);
  });

  it("tells an agent to pay the split a person can compute from the merchant and their wallet", async () => {
    // Computed outside this repository from the merchant's identifier, the
    // test chain and the wallet: a gateway salting with anything else (the
    // account, the seller's name, another chain) would name an address no
    // record of the rule could rebuild, and only a restart would notice.
    const { served, harnessed } = await started();
    const golden = handEncoded.splits[0];
    if (golden === undefined || golden.network !== "eip155:84532") {
      throw new Error("the hand-encoded vectors have no split on the test chain first");
    }
    await harnessed.store.addMerchant({ id: golden.merchantId, name: "A shop" }, harnessed.now());
    const { secret } = await harnessed.gateway.issueMerchantKey(
      golden.merchantId,
      "their worker",
      SIGNED_IN,
    );
    await named(served, secret, "A shop");
    await setPayoutWallet(harnessed, golden.merchantId, golden.merchantWallet);
    const itemId = await publish(served, secret, cardFor("a-room", "A room"));

    expect(harnessed.runtime.config.payoutSplit.commissionWallet).toBe(golden.commissionWallet);
    expect(await payToInTheChallenge(served, itemId)).toBe(golden.address);
  });

  it("asks for the full price, with the commission inside it, and charges it", async () => {
    // A challenge for the merchant's share alone would be a different charge,
    // and the merchant's books would not meet it.
    const { served, harnessed } = await started();
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);
    const itemId = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));

    const probed = await served.call("GET", `/x402/${itemId}/purchase`);
    expect(
      decodePaymentRequiredHeader(probed.headers.get(PAYMENT_REQUIRED_HEADER) ?? "").accepts[0]
        ?.amount,
    ).toBe("80000000");
    const bought = await buyOverHttp(harnessed, served, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
    expect(harnessed.facilitator.settles.at(-1)?.amount).toBe("80.00");
  });

  it("pays each card to its own merchant, with two merchants selling at once", async () => {
    // A gateway that paid both cards to one address, its own configured one or
    // the first merchant's, passes every other test in this file.
    const { served, harnessed } = await started();
    const first = await harnessed.addMerchant("First shop");
    const second = await harnessed.addMerchant("Second shop");
    await setPayoutWallet(harnessed, first.id, A_WALLET);
    await setPayoutWallet(harnessed, second.id, ANOTHER_WALLET);

    const theirs = await publish(served, first.key, cardFor("a-room", "A room"));
    const others = await publish(served, second.key, cardFor("a-desk", "A desk"));

    const theirSplit = await recordedSplit(harnessed, first.id, A_WALLET);
    const otherSplit = await recordedSplit(harnessed, second.id, ANOTHER_WALLET);
    expect(await payToInTheChallenge(served, theirs)).toBe(theirSplit);
    expect(await payToInTheChallenge(served, others)).toBe(otherSplit);
    expect(theirSplit).not.toBe(otherSplit);
    for (const neither of [CONFIGURED_PAY_TO, A_WALLET, ANOTHER_WALLET]) {
      expect(await payToInTheChallenge(served, theirs)).not.toBe(neither);
      expect(await payToInTheChallenge(served, others)).not.toBe(neither);
    }
  });

  it("keeps two merchants with one wallet on two splits, each paid their own", async () => {
    // One merchant's payout must not move another merchant's sales.
    const { served, harnessed } = await started();
    const first = await harnessed.addMerchant("First shop");
    const second = await harnessed.addMerchant("Second shop");
    await setPayoutWallet(harnessed, first.id, A_WALLET);
    await setPayoutWallet(harnessed, second.id, A_WALLET);

    const theirs = await publish(served, first.key, cardFor("a-room", "A room"));
    const others = await publish(served, second.key, cardFor("a-desk", "A desk"));

    expect(await payToInTheChallenge(served, theirs)).toBe(
      await recordedSplit(harnessed, first.id, A_WALLET),
    );
    expect(await payToInTheChallenge(served, others)).toBe(
      await recordedSplit(harnessed, second.id, A_WALLET),
    );
    expect(await payToInTheChallenge(served, theirs)).not.toBe(
      await payToInTheChallenge(served, others),
    );
  });

  it("follows a merchant who moves their wallet, with no republishing", async () => {
    // The challenge reads the address when asked rather than copying it onto
    // cards, so a merchant whose wallet is compromised moves it once for all.
    const { served, harnessed } = await started();
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);
    const itemId = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));

    await setPayoutWallet(harnessed, harnessed.merchant.id, ANOTHER_WALLET);

    expect(await payToInTheChallenge(served, itemId)).toBe(
      await recordedSplit(harnessed, harnessed.merchant.id, ANOTHER_WALLET),
    );
  });

  it("returns a merchant to the split of a wallet they had before, as first recorded", async () => {
    // No count in the salt: going back to a wallet names the split already
    // recorded for it, whose parameters stay as they were written.
    const { served, harnessed } = await started();
    const itemId = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);
    const first = await recordedSplit(harnessed, harnessed.merchant.id, A_WALLET);
    const firstRecordedAt = (await harnessed.store.payoutSplitAt(first))?.recordedAt;
    harnessed.advance(60_000);
    await setPayoutWallet(harnessed, harnessed.merchant.id, ANOTHER_WALLET);
    harnessed.advance(60_000);

    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);

    expect(await payToInTheChallenge(served, itemId)).toBe(first);
    expect((await harnessed.store.payoutSplitAt(first))?.recordedAt).toBe(firstRecordedAt);
    expect(await recordedSplit(harnessed, harnessed.merchant.id, ANOTHER_WALLET)).not.toBe(first);
  });

  it("pays a sandbox merchant with no wallet at the placeholder's split, computed and never recorded, in the sandbox alone", async () => {
    // The sandbox has no chain behind it, so the address is only a placeholder,
    // but a challenge has to name one, and it names a split as a real channel
    // would. Recording it would put a write on the buying path for a split
    // nothing ever settles to.
    const { served, harnessed } = await started({ FACILITATOR_URL: SANDBOX_FACILITATOR });
    const { merchantId, key } = await fresh(harnessed);
    await named(served, key, "Their own shop");
    const itemId = await publish(served, key, cardFor("a-room", "A room"));

    const placeholder = placeholderSplit(merchantId);
    expect(await payToInTheChallenge(served, itemId)).toBe(placeholder);
    expect(placeholder).not.toBe(CONFIGURED_PAY_TO);
    expect(await harnessed.store.payoutSplitAt(placeholder)).toBeNull();
    const bought = await buyOverHttp(harnessed, served, itemId, {
      merchantId,
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
  });

  it("pays a sandbox merchant who has set a wallet at their own split, not the placeholder's", async () => {
    // A sandbox merchant shown an address other than the one they set would be
    // misled about what happens when the card is sold for real.
    const { served, harnessed } = await started({ FACILITATOR_URL: SANDBOX_FACILITATOR });
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);
    const itemId = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));

    expect(await payToInTheChallenge(served, itemId)).toBe(
      await recordedSplit(harnessed, harnessed.merchant.id, A_WALLET),
    );
    expect(await payToInTheChallenge(served, itemId)).not.toBe(
      placeholderSplit(harnessed.merchant.id),
    );
  });
});

/**
 * A card whose merchant has nowhere to be paid. The publish door refuses one
 * where the money is real, so the row is written straight into the store. Such
 * cards still exist: one published in the sandbox becomes one the moment the
 * deployment is pointed at a facilitator that settles.
 */
const soldWithNowhereToPay = async (
  harnessed: Harness,
  served: Served,
  merchantItemId = "a-room",
): Promise<{ readonly itemId: string; readonly key: string; readonly merchantId: string }> => {
  const { merchantId, key } = await fresh(harnessed);
  await named(served, key, "A shop that set no wallet");
  const stored = await harnessed.store.publishCard(
    merchantId,
    cardFor(merchantItemId, "A room"),
    harnessed.now(),
  );
  return { itemId: stored.id, key, merchantId };
};

describe("a card whose merchant has nowhere to be paid", () => {
  it("tells an agent it is not on sale rather than falling over", async () => {
    // No challenge can be written: the operator's address must not stand in, or
    // the merchant's takings go to somebody else. The agent gets the off-sale
    // answer its client already reads, not a 500.
    const { served, harnessed } = await started();
    const { itemId } = await soldWithNowhereToPay(harnessed, served);

    const answered = await served.call("GET", `/x402/${itemId}/purchase`);

    expect(answered.status, JSON.stringify(answered.body)).toBe(409);
    expect((answered.body as { error: { code: string } }).error.code).toBe("not_selling");
  });

  it("opens no order that nobody could ever pay for", async () => {
    // An order written before the refusal could never be paid, closed or
    // collected, and would sit in the merchant's dashboard against a deadline.
    const { served, harnessed } = await started();
    const { itemId, merchantId } = await soldWithNowhereToPay(harnessed, served);

    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });

    expect(answered.status, JSON.stringify(answered.body)).toBe(409);
    expect((answered.body as { error: { code: string } }).error.code).toBe("not_selling");
    expect(await harnessed.gateway.orders(merchantId, undefined)).toStrictEqual([]);
  });

  it("is not in the catalog an agent walks", async () => {
    // Listed, it would be an offer every purchase of which is refused: the agent
    // chooses it over a competitor and finds out at the till.
    const { served, harnessed } = await started();
    const { itemId } = await soldWithNowhereToPay(harnessed, served);
    const sellable = await publish(served, harnessed.merchant.key, cardFor("a-desk", "A desk"));

    const listed = (await served.call("GET", "/x402/catalog")).body as { items: { id: string }[] };

    expect(listed.items.map((item) => item.id)).not.toContain(itemId);
    // Otherwise the assertion above would pass against an empty catalog.
    expect(listed.items.map((item) => item.id)).toContain(sellable);
  });

  it("says the same thing to its own merchant as it says to a buyer", async () => {
    // A dashboard showing the card as selling while every purchase is refused
    // would send the merchant looking at the card for the fault.
    const { served, harnessed } = await started();
    const { itemId, key } = await soldWithNowhereToPay(harnessed, served);

    const own = (await served.call("GET", "/v0/cards", { headers: bearer(key) })).body as {
      cards: { id: string; selling: string }[];
    };

    expect(own.cards.find((card) => card.id === itemId)?.selling).not.toBe("open");
  });

  it("sells in the sandbox, where there is no money to send anywhere", async () => {
    // A local stack must complete a purchase with no chain configured, so in
    // the sandbox a missing wallet is no reason to refuse.
    const { served, harnessed } = await started({ FACILITATOR_URL: SANDBOX_FACILITATOR });
    const { itemId, merchantId } = await soldWithNowhereToPay(harnessed, served);

    expect(await payToInTheChallenge(served, itemId)).toBe(placeholderSplit(merchantId));
    const listed = (await served.call("GET", "/x402/catalog")).body as { items: { id: string }[] };
    expect(listed.items.map((item) => item.id)).toContain(itemId);
  });

  it("sells again the moment their merchant says where the money goes", async () => {
    // Setting the address is the whole repair; nothing is republished.
    const { served, harnessed } = await started();
    const { itemId, merchantId } = await soldWithNowhereToPay(harnessed, served);
    expect((await served.call("GET", `/x402/${itemId}/purchase`)).status).toBe(409);

    await setPayoutWallet(harnessed, merchantId, A_WALLET);

    expect(await payToInTheChallenge(served, itemId)).toBe(
      await recordedSplit(harnessed, merchantId, A_WALLET),
    );
  });
});

describe("a wallet that moves while a sale is in flight", () => {
  it("charges what the payer signed, not the address set since", async () => {
    // A payment is verified before the order reaches the merchant and charged
    // after the goods come back, and the wallet may move in between. The buyer's
    // authorisation names one address, so a charge sent to another would be
    // refused after the goods went out.
    const { served, harnessed } = await started();
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);
    const itemId = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));

    const bought = await buyOverHttp(harnessed, served, itemId, {
      onOrder: async () => {
        await setPayoutWallet(harnessed, harnessed.merchant.id, ANOTHER_WALLET);
        return { delivered: { access_code: "SESAME" } };
      },
    });

    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
    const signedFor = await recordedSplit(harnessed, harnessed.merchant.id, A_WALLET);
    expect(harnessed.facilitator.verifies.at(-1)?.payTo).toBe(signedFor);
    expect(harnessed.facilitator.settles.at(-1)?.payTo).toBe(signedFor);
    // The move took effect: the next challenge names the new wallet's split.
    expect(await payToInTheChallenge(served, itemId)).toBe(
      await recordedSplit(harnessed, harnessed.merchant.id, ANOTHER_WALLET),
    );
  });

  it("asks about the payment against the address the challenge named", async () => {
    // Between challenge and payment nothing is in flight, so verification uses
    // the current address, and a payment made out to one the merchant has since
    // left is refused before anything happens. The refusal itself is tested in
    // `adapters/x402`; this pins which address verification carries.
    const { served, harnessed } = await started();
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);
    const itemId = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));
    expect(await payToInTheChallenge(served, itemId)).toBe(
      await recordedSplit(harnessed, harnessed.merchant.id, A_WALLET),
    );

    await setPayoutWallet(harnessed, harnessed.merchant.id, ANOTHER_WALLET);
    await buyOverHttp(harnessed, served, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });

    expect(harnessed.facilitator.verifies.at(-1)?.payTo).toBe(
      await recordedSplit(harnessed, harnessed.merchant.id, ANOTHER_WALLET),
    );
  });
});

describe("an address that cannot be a payout wallet", () => {
  /** A merchant's split and the network's contracts, which a merchant's share could never come back from. */
  const notWallets = async (harnessed: Harness) => {
    const network = harnessed.runtime.config.payoutSplit;
    const other = await harnessed.addMerchant("Another shop");
    return [
      [
        "the merchant's own split",
        await recordedSplit(harnessed, harnessed.merchant.id, harnessed.merchant.wallet),
        "payout_split",
      ],
      [
        "another merchant's split",
        await recordedSplit(harnessed, other.id, other.wallet),
        "payout_split",
      ],
      ["Agentify's commission wallet", network.commissionWallet, "commission_wallet"],
      ["the warehouse, in lower case", network.warehouse.toLowerCase(), "split_warehouse"],
      ["Multicall3", network.multicall3, "multicall3"],
    ] as const;
  };

  it("is refused, saying what it is, and nothing is written", async () => {
    // A split as a wallet pays the commission twice and needs two payouts, and
    // a payout contract as a wallet hands the merchant's share to whoever
    // calls it next. A merchant pasting the payout contract the screen showed
    // them is the likely way it happens.
    const { served, harnessed } = await started();
    const before = await payoutWallet(served, harnessed.merchant.key);
    const recorded = () =>
      harnessed.store.splitsToPayOutOn(
        harnessed.runtime.config.payoutSplit.network,
        harnessed.now(),
      );
    const cases = await notWallets(harnessed);
    const splitsBefore = await recorded();

    for (const [what, address, is] of cases) {
      expect(await setPayoutWallet(harnessed, harnessed.merchant.id, address), what).toStrictEqual({
        refused: "not_a_payout_wallet",
        is,
      });
    }
    expect(await payoutWallet(served, harnessed.merchant.key)).toStrictEqual(before);
    expect(await recorded()).toStrictEqual(splitsBefore);
  });

  it("is refused as a first wallet too", async () => {
    const { served, harnessed } = await started();
    const { merchantId, key } = await fresh(harnessed);

    for (const [what, address, is] of await notWallets(harnessed)) {
      expect(await setPayoutWallet(harnessed, merchantId, address), what).toStrictEqual({
        refused: "not_a_payout_wallet",
        is,
      });
    }
    expect(await payoutWallet(served, key)).toStrictEqual({ payout_wallet: null, pending: null });
  });
});

describe("the wallet document a merchant's code reads", () => {
  it("answers with the wallet, never the split, in the shape it always had", async () => {
    // `payout_wallet` now means where the merchant's share arrives. Code that
    // compares it with the wallet it saved must still agree, and a strict
    // reader built from the published package must still read it.
    const { served, harnessed } = await started();
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);
    const split = await recordedSplit(harnessed, harnessed.merchant.id, A_WALLET);

    const answered = await served.call("GET", "/v0/payout-wallet", {
      headers: bearer(harnessed.merchant.key),
    });

    expect(PayoutWalletSchema.strict().parse(answered.body)).toStrictEqual({
      payout_wallet: A_WALLET,
      pending: null,
    });
    expect(JSON.stringify(answered.body).toLowerCase()).not.toContain(split.toLowerCase());
  });
});

describe("a merchant whose wallet has no recorded split", () => {
  /**
   * A wallet written straight to the store with no split: a defect once the
   * start has recorded every split, which this must still refuse to sell for.
   */
  const withoutASplitHere = async (harnessed: Harness, served: Served) => {
    const { merchantId, key } = await fresh(harnessed);
    await named(served, key, "A shop whose split went missing");
    await harnessed.store.writeWalletWithoutSplit(merchantId, {
      address: A_WALLET,
      pending: null,
    });
    const stored = await harnessed.store.publishCard(
      merchantId,
      cardFor("a-room", "A room"),
      harnessed.now(),
    );
    return { merchantId, key, itemId: stored.id };
  };

  it("sells nothing, in the words for no wallet, and says so in the log", async () => {
    // A missing row is a defect. The safe outcome is no sale: never the
    // wallet itself, which skips the commission; never a split recomputed
    // here, whose parameters nothing recorded; never the operator's address.
    const { served, harnessed } = await started();
    const { merchantId, key, itemId } = await withoutASplitHere(harnessed, served);

    const answers: Awaited<ReturnType<Served["call"]>>[] = [];
    const logged = await loggedWhile(async () => {
      answers.push(await served.call("GET", `/x402/${itemId}/purchase`));
      answers.push(await served.call("POST", `/x402/${itemId}/purchase`, { body: { params: {} } }));
    });

    for (const answered of answers) {
      expect(answered.status, JSON.stringify(answered.body)).toBe(409);
      expect((answered.body as { error: { code: string } }).error.code).toBe("not_selling");
      expect(answered.headers.get(PAYMENT_REQUIRED_HEADER)).toBeNull();
    }
    expect(answers).toHaveLength(2);
    expect(await harnessed.gateway.orders(merchantId, undefined)).toStrictEqual([]);
    expect(logged).toContain(merchantId);
    expect(logged).toMatch(/no payout split is recorded/);

    const refused = await publishing(served, key, cardFor("a-desk", "A desk"));
    expect(refused.status).toBe(422);
    const { problems } = (refused.body as { error: { problems: { code: string }[] } }).error;
    expect(problems.map((problem) => problem.code)).toContain("no_payout_wallet");
  });

  it("says nothing of a missing split for a merchant whose split is recorded", async () => {
    // The line is how an operator finds the defect; written for every
    // merchant, it would bury the one it is about.
    const { served, harnessed } = await started();
    const itemId = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));

    const logged = await loggedWhile(async () => {
      expect((await served.call("GET", `/x402/${itemId}/purchase`)).status).toBe(402);
    });

    expect(logged).not.toMatch(/no payout split is recorded/);
  });

  it("sells nothing in the sandbox either, rather than at a split nothing recorded", async () => {
    // The placeholder stands in for a merchant with no wallet, never for a
    // merchant whose wallet lost its split.
    const { served, harnessed } = await started({ FACILITATOR_URL: SANDBOX_FACILITATOR });
    const { itemId } = await withoutASplitHere(harnessed, served);

    const probed = await served.call("GET", `/x402/${itemId}/purchase`);

    expect(probed.status, JSON.stringify(probed.body)).toBe(409);
  });
});

describe("the split a payment is checked against", () => {
  const asyncCard: Card = {
    ...cardFor("an-esim", "An eSIM"),
    fulfillment: "async",
    fulfill_deadline_seconds: 3_600,
  };

  it.each([
    ["a synchronous card", cardFor("a-room", "A room")],
    ["an asynchronous card", asyncCard],
  ])("is kept on the order and charged, for %s", async (_which, card) => {
    // The charge goes where the buyer's authorisation names; the mode decides
    // only when.
    const { served, harnessed } = await started();
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);
    const itemId = await publish(served, harnessed.merchant.key, card);
    const split = await recordedSplit(harnessed, harnessed.merchant.id, A_WALLET);

    const bought = await buyOverHttp(harnessed, served, itemId, {
      onOrder: () =>
        card.fulfillment === "sync" ? { delivered: { access_code: "SESAME" } } : { accepted: {} },
    });

    expect([200, 202], JSON.stringify(bought.body)).toContain(bought.status);
    const [order] = await harnessed.gateway.orders(harnessed.merchant.id, undefined);
    expect(harnessed.facilitator.verifies.at(-1)?.payTo).toBe(split);
    expect(order?.payTo).toBe(split);
    expect(harnessed.facilitator.settles.at(-1)?.payTo).toBe(split);
  });

  it("is told to nobody but the challenge", async () => {
    // The wire for merchant code and agents keeps its shape: a split address in
    // any other document is a field a strict reader refuses, and a document
    // naming it would have to be learned by everyone who reconciles payments.
    const { served, harnessed } = await started();
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);
    const split = (await recordedSplit(harnessed, harnessed.merchant.id, A_WALLET)).toLowerCase();
    const syncItem = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));
    const asyncItem = await publish(served, harnessed.merchant.key, asyncCard);
    const handed: unknown[] = [];

    const sync = await buyOverHttp(harnessed, served, syncItem, {
      onOrder: (order) => {
        handed.push(order);
        return { delivered: { access_code: "SESAME" } };
      },
    });
    const async = await buyOverHttp(harnessed, served, asyncItem, {
      onOrder: (order) => {
        handed.push(order);
        return { accepted: {} };
      },
    });
    const merchant = bearer(harnessed.merchant.key);
    const orderIds = (await harnessed.gateway.orders(harnessed.merchant.id, undefined)).map(
      (record) => record.order.id,
    );
    const documents: unknown[] = [
      sync.body,
      sync.headers.get(PAYMENT_RESPONSE_HEADER),
      async.body,
      async.headers.get(PAYMENT_RESPONSE_HEADER),
      handed,
      await drawEverything(harnessed),
      (await served.call("GET", "/v0/orders", { headers: merchant })).body,
      (await served.call("GET", "/v0/receipts", { headers: merchant })).body,
      (await served.call("GET", "/v0/payout-wallet", { headers: merchant })).body,
    ];
    for (const orderId of orderIds) {
      documents.push(
        (await served.call("GET", `/v0/orders/${orderId}`, { headers: merchant })).body,
      );
      documents.push((await served.call("GET", `/x402/orders/${orderId}/status`)).body);
    }

    expect(orderIds).toHaveLength(2);
    for (const document of documents) {
      const text = typeof document === "string" ? document : JSON.stringify(document);
      expect(text.toLowerCase()).not.toContain(split);
      // A header is base64; its decoded text is what a client reads.
      if (typeof document === "string") {
        expect(Buffer.from(document, "base64").toString("utf8").toLowerCase()).not.toContain(split);
      }
    }
  });
});
