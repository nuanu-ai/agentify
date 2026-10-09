/**
 * The wallet a merchant's sales are paid into.
 *
 * It is the second thing a merchant sets about themselves rather than about a
 * card, and it is the one with money on it: the address a merchant writes here
 * is the address a buyer's agent is told to pay, directly, with nothing of ours
 * in between and nothing afterwards that can call the payment back. It is set
 * the one way it can be, by a person signed in to the dashboard, which calls
 * the gateway inside the process (ADR-0019, ADR-0030); everything else here —
 * reading it, publishing, the payment request an agent is sent — goes through
 * `serve`, so the door, the mounting loop and the flows all run.
 *
 * Two rules are what this file exists for, and both cost somebody money when
 * they are wrong. A card published by a merchant with no wallet would be offered
 * for sale with nowhere for the money to go — refused at the publish, where
 * somebody can still be told, rather than at the till. And the address in a
 * payment request has to be the address of the merchant who published that
 * card: two merchants are seeded wherever that is the claim, because one proves
 * nothing at all — a gateway that paid every sale to one address would satisfy
 * every assertion a single merchant can make about their own.
 *
 * The sandbox is the one place none of it holds, and it is asserted here too.
 * There is no chain behind it and no money in it, and a local stack that could
 * not sell without an address on a chain would be a stack nobody can bring up.
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
 * Two addresses that are addresses, and are not each other, written the way the
 * wallets they came out of would show them.
 *
 * That is the spelling everything here stores and answers with, so it is the
 * spelling the assertions are written in. Both have letters that the checksum
 * capitalises, deliberately: an address of all digits would read back
 * identically whatever the canon was, and would pin nothing.
 */
const A_WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const ANOTHER_WALLET = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";

/** The same address as the first, written the other way one may be written. */
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
 * A merchant with no wallet and no name, made the only way one comes to exist
 * outside the harness: by registering in the dashboard, with a key for their
 * own code issued from there. This is the state a real merchant is in between
 * signing up and setting either.
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
    // Null is the answer, not an empty string and not a 404. A merchant with no
    // wallet exists and has a settings page to draw, and the shape it draws
    // from has to say "there is none" in a way nobody can mistake for "I could
    // not find you".
    const { served, harnessed } = await started();
    const { key } = await fresh(harnessed);

    expect(await payoutWallet(served, key)).toStrictEqual({ payout_wallet: null, pending: null });
  });

  it("sets a wallet and hands back what was written rather than what was sent", async () => {
    const { served, harnessed } = await started();

    const answered = await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);

    expect(answered).toStrictEqual({ payout_wallet: A_WALLET, pending: null });
    // And it is there on the next call, which is what makes the answer above a
    // read of the row rather than an echo of the request.
    expect(await payoutWallet(served, harnessed.merchant.key)).toStrictEqual({
      payout_wallet: A_WALLET,
      pending: null,
    });
  });

  it("takes the lower-case spelling too, and answers in the one a wallet shows", async () => {
    // The other accepted spelling: a block explorer prints it, and half the
    // tooling in this world hands it to somebody. It is one address, so it is
    // answered with in the one form anything behind the door holds — the one a
    // wallet shows. A merchant pastes forty characters out of their wallet and
    // then looks at a settings screen: shown the same address in another
    // spelling, they cannot tell it from a different address without going
    // character by character, and nobody does that.
    const { harnessed } = await started();

    const answered = await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET_IN_LOWER);

    expect(answered).toStrictEqual({ payout_wallet: A_WALLET, pending: null });
    expect(A_WALLET_IN_LOWER).not.toBe(A_WALLET);
  });

  it("writes nothing for a value that is not an address, whoever skipped holding it", async () => {
    // The dashboard holds what a person typed to the address rule before it
    // asks, and says what is wrong in words; this is the gateway's own hold
    // behind it. An address whose capitals disagree with its digits has a
    // character wrong, and an address that is wrong is another good address
    // belonging to somebody else, which nothing downstream would ever notice.
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

    // And the wallet they had is still theirs: a refusal that had already
    // written would be worse than no rule at all.
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
    // Seeded with two, because one proves nothing: a write that put the
    // address onto every merchant would pass every assertion one merchant can
    // make about their own.
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
    // Reading moves no money, and a merchant's own code has good reason to
    // know where the takings go: a reconciliation, a check before selling.
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
    // The rule this half of the file exists for. A card published with no
    // address behind it is a product offered for sale with nowhere for the
    // money from it to go.
    const { served, harnessed } = await started();
    const { key } = await fresh(harnessed);
    await named(served, key, "Their own shop");

    const refused = await publishing(served, key, cardFor("a-room", "A room"));

    expect(refused.status).toBe(422);
    const { problems } = (
      refused.body as { error: { problems: { code: string; message: string }[] } }
    ).error;
    // The words have to tell them what to do next. What is missing is not on
    // the card at all, so a merchant told "something is missing" would go
    // through the fields of a card looking for a field that is not there.
    // The wallet is set in the dashboard and nowhere else, so that is where the
    // words send them.
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
    // The road out of the refusal, walked end to end. A rule a merchant cannot
    // get past is not a rule, it is a wall.
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
    // The whole claim of this feature in one test. Two merchants, two
    // addresses, two cards: a gateway that paid both to one address — its own
    // configured one, or the first merchant it found — passes every other test
    // in this file and fails this one.
    const { served, harnessed } = await started();
    const first = await harnessed.addMerchant("First shop");
    const second = await harnessed.addMerchant("Second shop");
    await setPayoutWallet(harnessed, first.id, A_WALLET);
    await setPayoutWallet(harnessed, second.id, ANOTHER_WALLET);

    const theirs = await publish(served, first.key, cardFor("a-room", "A room"));
    const others = await publish(served, second.key, cardFor("a-desk", "A desk"));

    expect(await payToInTheChallenge(served, theirs)).toBe(A_WALLET);
    expect(await payToInTheChallenge(served, others)).toBe(ANOTHER_WALLET);
    // And neither of them is the address the gateway itself was configured
    // with, which is the operator's and not any merchant's.
    expect(await payToInTheChallenge(served, theirs)).not.toBe(CONFIGURED_PAY_TO);
    expect(await payToInTheChallenge(served, others)).not.toBe(CONFIGURED_PAY_TO);
  });

  it("follows a merchant who moves their wallet, with no republishing", async () => {
    // The challenge reads the address at the moment it is asked for rather than
    // copying it onto each card as it is published. A merchant whose wallet was
    // compromised moves it once and every card of theirs moves with it.
    const { served, harnessed } = await started();
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);
    const itemId = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));

    await setPayoutWallet(harnessed, harnessed.merchant.id, ANOTHER_WALLET);

    expect(await payToInTheChallenge(served, itemId)).toBe(ANOTHER_WALLET);
  });

  it("stands the configured address in for a merchant with none, in the sandbox alone", async () => {
    // What the sandbox pays to. There is no chain behind it, so the address is
    // a placeholder rather than a destination — but a challenge has to name
    // one, and the deployment's own configured address is the only one there is
    // when the merchant has set none.
    const { served, harnessed } = await started({ FACILITATOR_URL: SANDBOX_FACILITATOR });
    const { key } = await fresh(harnessed);
    await named(served, key, "Their own shop");
    const itemId = await publish(served, key, cardFor("a-room", "A room"));

    expect(await payToInTheChallenge(served, itemId)).toBe(CONFIGURED_PAY_TO);
  });

  it("pays a sandbox merchant who has set a wallet at their own, not the placeholder", async () => {
    // The placeholder stands in where there is nothing, and nowhere else. A
    // merchant testing against a sandbox who sets an address and is shown a
    // different one in the challenge has been told something untrue about what
    // will happen when the same card is sold for real.
    const { served, harnessed } = await started({ FACILITATOR_URL: SANDBOX_FACILITATOR });
    await setPayoutWallet(harnessed, harnessed.merchant.id, A_WALLET);
    const itemId = await publish(served, harnessed.merchant.key, cardFor("a-room", "A room"));

    expect(await payToInTheChallenge(served, itemId)).toBe(A_WALLET);
  });
});

/**
 * One card in the catalog whose merchant has nowhere to be paid.
 *
 * The publish door refuses to make one where the money is real, so the row is
 * written straight into the store — which is how one comes to exist in the
 * world. A card published while the gateway was in the sandbox, where no
 * address is asked for, is one of these the moment the deployment is pointed at
 * a facilitator that settles; so is every merchant who was there before the
 * column was, whom the migration left with nothing in it. What is under test is
 * what the buying surface does when it finds one, not the road it took to get
 * there.
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
    // A challenge for this card cannot be written at all: there is no address
    // to name in it, and standing the operator's own in would send a merchant's
    // takings to somebody else. The agent gets the word a card that is off sale
    // gets — which is the truth, and which its client already knows how to
    // read — instead of a five hundred out of the middle of the gateway.
    const { served, harnessed } = await started();
    const { itemId } = await soldWithNowhereToPay(harnessed, served);

    const answered = await served.call("GET", `/x402/${itemId}/purchase`);

    expect(answered.status, JSON.stringify(answered.body)).toBe(409);
    expect((answered.body as { error: { code: string } }).error.code).toBe("not_selling");
  });

  it("opens no order that nobody could ever pay for", async () => {
    // The half that costs more than a status code. A purchase used to write the
    // order first and fail afterwards, which left a row nobody could pay, nobody
    // could close and nothing would ever collect — on the merchant's own stream,
    // in their dashboard, against a deadline.
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
    // A catalog is an offer, and an entry every purchase of which comes back
    // refused is an offer we would not honour: the agent budgets against it,
    // chooses it over a competitor, and finds out at the till.
    const { served, harnessed } = await started();
    const { itemId } = await soldWithNowhereToPay(harnessed, served);
    const sellable = await publish(served, harnessed.merchant.key, cardFor("a-desk", "A desk"));

    const listed = (await served.call("GET", "/x402/catalog")).body as { items: { id: string }[] };

    expect(listed.items.map((item) => item.id)).not.toContain(itemId);
    // The other half, or the assertion above would pass against a catalog that
    // had stopped listing anything at all.
    expect(listed.items.map((item) => item.id)).toContain(sellable);
  });

  it("says the same thing to its own merchant as it says to a buyer", async () => {
    // One word about whether a card sells, and everybody who asks gets it. A
    // dashboard that showed a card as selling while every purchase of it came
    // back refused would send its merchant looking at the card for the fault.
    const { served, harnessed } = await started();
    const { itemId, key } = await soldWithNowhereToPay(harnessed, served);

    const own = (await served.call("GET", "/v0/cards", { headers: bearer(key) })).body as {
      cards: { id: string; selling: string }[];
    };

    expect(own.cards.find((card) => card.id === itemId)?.selling).not.toBe("open");
  });

  it("sells in the sandbox, where there is no money to send anywhere", async () => {
    // The safe direction, and the reason this is not simply "no wallet, no
    // sale". A local stack has to come up and complete a purchase with nothing
    // configured about a chain: there is nothing to send, so there is nothing
    // to be missing an address for.
    const { served, harnessed } = await started({ FACILITATOR_URL: SANDBOX_FACILITATOR });
    const { itemId } = await soldWithNowhereToPay(harnessed, served);

    expect(await payToInTheChallenge(served, itemId)).toBe(CONFIGURED_PAY_TO);
    const listed = (await served.call("GET", "/x402/catalog")).body as { items: { id: string }[] };
    expect(listed.items.map((item) => item.id)).toContain(itemId);
  });

  it("sells again the moment their merchant says where the money goes", async () => {
    // A rule a merchant cannot get out of is a wall. Setting the address is the
    // whole of the repair, and it takes no republishing.
    const { served, harnessed } = await started();
    const { itemId, merchantId } = await soldWithNowhereToPay(harnessed, served);
    expect((await served.call("GET", `/x402/${itemId}/purchase`)).status).toBe(409);

    await setPayoutWallet(harnessed, merchantId, A_WALLET);

    expect(await payToInTheChallenge(served, itemId)).toBe(A_WALLET);
  });
});

describe("a wallet that moves while a sale is in flight", () => {
  it("charges what the payer signed, not the address set since", async () => {
    // The window is the sale itself. A payment is verified before the order
    // goes to the merchant and charged after the goods come back, and a wallet
    // may be moved in between — this merchant moves theirs while fulfilling,
    // which is the ordinary way it happens rather than a contrivance. The
    // authorisation the buyer signed names one address, so a charge sent
    // against another is refused by the payment layer after the goods have
    // already gone out: the merchant has delivered and cannot be paid.
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
    // And the move was real: the next agent to ask is invited to the new one.
    expect(await payToInTheChallenge(served, itemId)).toBe(ANOTHER_WALLET);
  });

  it("asks about the payment against the address the challenge named", async () => {
    // The other window, and the safe direction in it. Between the challenge and
    // the payment nothing of ours is in flight, so the address a payment is
    // checked against is read at the verification and is the current one: a
    // payment made out to an address the merchant has since moved off is asked
    // about against the new one and refused there, before anything happens.
    // (The refusal itself is the real payment layer's — `adapters/x402` — and
    // is exercised in its own suite; what this pins is which address the
    // question carries.)
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
