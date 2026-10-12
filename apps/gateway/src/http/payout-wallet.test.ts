/**
 * The wallet a merchant's sales are paid into. A buyer's agent pays this
 * address directly, and nothing can call the payment back. Only a signed-in
 * dashboard session sets it, in-process; reading it, publishing and the payment
 * request an agent is sent all go through `serve`.
 *
 * A merchant with no wallet is refused at publish, where they can still be
 * told, rather than at the till. The address in a payment request must be the
 * publishing merchant's, so those claims are tested with two merchants: a
 * gateway that paid every sale to one address would pass every single-merchant
 * assertion. The sandbox, with no chain and no money behind it, is exempt.
 */

import type { Card } from "@nuanu-ai/agentify-contracts";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { afterEach, describe, expect, it } from "vitest";
import { SANDBOX_FACILITATOR } from "../config.js";
import { buyOverHttp, type Harness, harness, type Served, serve } from "../testing/harness.js";
import { PAYMENT_REQUIRED_HEADER } from "./x402.js";

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
    expect(await payToInTheChallenge(served, itemId)).toBe(A_WALLET);
  });
});

describe("who an agent is told to pay", () => {
  it("names the wallet of the merchant who published the card", async () => {
    const { served, harnessed } = await started();
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);
    const itemId = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));

    expect(await payToInTheChallenge(served, itemId)).toBe(A_WALLET);
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

    expect(await payToInTheChallenge(served, theirs)).toBe(A_WALLET);
    expect(await payToInTheChallenge(served, others)).toBe(ANOTHER_WALLET);
    expect(await payToInTheChallenge(served, theirs)).not.toBe(CONFIGURED_PAY_TO);
    expect(await payToInTheChallenge(served, others)).not.toBe(CONFIGURED_PAY_TO);
  });

  it("follows a merchant who moves their wallet, with no republishing", async () => {
    // The challenge reads the address when asked rather than copying it onto
    // cards, so a merchant whose wallet is compromised moves it once for all.
    const { served, harnessed } = await started();
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);
    const itemId = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));

    await setPayoutWallet(harnessed, harnessed.merchant.id, ANOTHER_WALLET);

    expect(await payToInTheChallenge(served, itemId)).toBe(ANOTHER_WALLET);
  });

  it("stands the configured address in for a merchant with none, in the sandbox alone", async () => {
    // The sandbox has no chain behind it, so the address is only a placeholder,
    // but a challenge has to name one.
    const { served, harnessed } = await started({ FACILITATOR_URL: SANDBOX_FACILITATOR });
    const { key } = await fresh(harnessed);
    await named(served, key, "Their own shop");
    const itemId = await publish(served, key, cardFor("a-room", "A room"));

    expect(await payToInTheChallenge(served, itemId)).toBe(CONFIGURED_PAY_TO);
  });

  it("pays a sandbox merchant who has set a wallet at their own, not the placeholder", async () => {
    // A sandbox merchant shown an address other than the one they set would be
    // misled about what happens when the card is sold for real.
    const { served, harnessed } = await started({ FACILITATOR_URL: SANDBOX_FACILITATOR });
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);
    const itemId = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));

    expect(await payToInTheChallenge(served, itemId)).toBe(A_WALLET);
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
    const { itemId } = await soldWithNowhereToPay(harnessed, served);

    expect(await payToInTheChallenge(served, itemId)).toBe(CONFIGURED_PAY_TO);
    const listed = (await served.call("GET", "/x402/catalog")).body as { items: { id: string }[] };
    expect(listed.items.map((item) => item.id)).toContain(itemId);
  });

  it("sells again the moment their merchant says where the money goes", async () => {
    // Setting the address is the whole repair; nothing is republished.
    const { served, harnessed } = await started();
    const { itemId, merchantId } = await soldWithNowhereToPay(harnessed, served);
    expect((await served.call("GET", `/x402/${itemId}/purchase`)).status).toBe(409);

    await setPayoutWallet(harnessed, merchantId, A_WALLET);

    expect(await payToInTheChallenge(served, itemId)).toBe(A_WALLET);
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
    expect(harnessed.facilitator.verifies.at(-1)?.payTo).toBe(A_WALLET);
    expect(harnessed.facilitator.settles.at(-1)?.payTo).toBe(A_WALLET);
    // The move took effect: the next challenge names the new wallet.
    expect(await payToInTheChallenge(served, itemId)).toBe(ANOTHER_WALLET);
  });

  it("asks about the payment against the address the challenge named", async () => {
    // Between challenge and payment nothing is in flight, so verification uses
    // the current address, and a payment made out to one the merchant has since
    // left is refused before anything happens. The refusal itself is tested in
    // `adapters/x402`; this pins which address verification carries.
    const { served, harnessed } = await started();
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);
    const itemId = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));
    expect(await payToInTheChallenge(served, itemId)).toBe(A_WALLET);

    await setPayoutWallet(harnessed, harnessed.merchant.id, ANOTHER_WALLET);
    await buyOverHttp(harnessed, served, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });

    expect(harnessed.facilitator.verifies.at(-1)?.payTo).toBe(ANOTHER_WALLET);
  });
});
