/**
 * A payout wallet change on the live deployment. The payout address is the one
 * setting whose change redirects money, and only a dashboard session reaches
 * it, so the wait guards against a session left signed in on somebody else's
 * device or stolen: a replacement is announced to every account naming the
 * merchant before anything is written, and takes effect forty-eight hours
 * later.
 *
 * The dashboard is not in this file: the harness records what the gateway asked
 * it to announce and answers as each test tells it to. Time is the harness's
 * clock; forty-eight hours pass because a test says so.
 */

import { type Card, PayoutWalletSchema } from "@nuanu-ai/agentify-contracts";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { payoutSplitFor } from "../split/parameters.js";
import {
  buyOverHttp,
  type Harness,
  harness,
  loggedWhile,
  type Served,
  serve,
} from "../testing/harness.js";
import { PAYMENT_REQUIRED_HEADER } from "./x402.js";

const HOURS = 60 * 60 * 1_000;
const THE_WAIT = 48 * HOURS;

/**
 * The session every change here is asked from, and what every message names:
 * the account it is signed in as. Whoever holds a session is not something the
 * gateway can know, which is why it names the session's account and nobody
 * behind it.
 */
const SIGNED_IN = { kind: "signed_in", email: "owner@example.com" } as const;

/** What makes a harness live: Base mainnet, its one facilitator, and the dashboard to announce through. */
const LIVE = {
  PAYMENT_NETWORK: "eip155:8453",
  FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  CDP_API_KEY_ID: "key-id",
  CDP_API_KEY_SECRET: "key-secret",
};

/** Two addresses with letters in them, written the way a wallet shows them. */
const A_WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const ANOTHER_WALLET = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";

let open: { harnessed: Harness; served: Served } | null = null;

const started = async (overrides: Record<string, string> = LIVE) => {
  const harnessed = await harness(overrides);
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

interface WalletAnswer {
  readonly payout_wallet: string | null;
  readonly pending: { readonly payout_wallet: string; readonly takes_effect_at: string } | null;
}

const walletOf = async (served: Served, key: string): Promise<WalletAnswer> => {
  const answered = await served.call("GET", "/v0/payout-wallet", { headers: bearer(key) });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return answered.body as WalletAnswer;
};

/** A change asked for the way the dashboard's Settings screen asks: the answer, or the refusal. */
const asking = (harnessed: Harness, wallet: string, merchantId = harnessed.merchant.id) =>
  harnessed.gateway.setPayoutWallet(merchantId, wallet, SIGNED_IN);

/** A change that is expected to be taken, and the wallet as it then stands. */
const ask = async (
  harnessed: Harness,
  wallet: string,
  merchantId = harnessed.merchant.id,
): Promise<WalletAnswer> => {
  const answered = await asking(harnessed, wallet, merchantId);
  if (typeof answered === "string" || "refused" in answered) {
    throw new Error(`the change was refused: ${JSON.stringify(answered)}`);
  }
  return answered;
};

const at = (instant: number): string => new Date(instant).toISOString();

/** This merchant's split of this wallet on the gateway's network, as the rule computes it. */
const splitOf = (harnessed: Harness, wallet: string, merchantId = harnessed.merchant.id) =>
  payoutSplitFor(harnessed.runtime.config.payoutSplit, merchantId, wallet);

/** The split recorded at the address the rule gives this merchant and wallet, or null. */
const recordedSplitOf = (harnessed: Harness, wallet: string, merchantId = harnessed.merchant.id) =>
  harnessed.store.payoutSplitAt(splitOf(harnessed, wallet, merchantId).address);

/** Every split the journal says was recorded while `during` ran, parsed back from its line. */
const journalled = async (during: () => Promise<unknown>) => {
  const logged = await loggedWhile(during);
  return [...logged.matchAll(/payout split recorded: (\{.*\})/g)].map(
    (line) => JSON.parse(line[1] ?? "") as Record<string, unknown>,
  );
};

const card: Card = {
  merchant_item_id: "a-room",
  title: "A room",
  description: "A room, sold by whoever published this card",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

/** The address an agent is told to pay for this merchant's card, right now. */
const payToNow = async (served: Served, itemId: string) => {
  const answered = await served.call("GET", `/x402/${itemId}/purchase`);
  expect(answered.status, JSON.stringify(answered.body)).toBe(402);
  return decodePaymentRequiredHeader(answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "").accepts[0]
    ?.payTo;
};

const published = async (served: Served, key: string): Promise<string> => {
  const answered = await served.call("POST", "/v0/catalog/publish", {
    body: card,
    headers: bearer(key),
  });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return (answered.body as { id: string }).id;
};

/** The label and identifier the harness's merchant's own key is listed under. */
const theMerchantsKey = async (harnessed: Harness) => {
  const key = await harnessed.gateway.keyBehind(harnessed.merchant.key);
  if (key === null) {
    throw new Error("the harness's merchant has no key the door opens");
  }
  return { kind: "merchant_code" as const, id: key.id, label: key.label };
};

describe("the first address a merchant sets", () => {
  /** A merchant with no address yet, made the way the dashboard makes one. */
  const aNewMerchant = (harnessed: Harness): Promise<string> =>
    harnessed.gateway.registerMerchant();

  it("applies at once, or a new merchant could not start selling, and is announced afterwards", async () => {
    // The message is owed for every address set on the live site, the first
    // included: a session that is not the owner's could set it, and the
    // message is how the owner learns of it.
    const { harnessed } = await started();
    const merchantId = await aNewMerchant(harnessed);

    expect(await ask(harnessed, A_WALLET, merchantId)).toStrictEqual({
      payout_wallet: A_WALLET,
      pending: null,
    });
    // The message is the merchant's record of the address buyers pay, which
    // the checksum's check by eye does not cover, so it names the split as
    // recorded.
    const recorded = await recordedSplitOf(harnessed, A_WALLET, merchantId);
    expect(recorded?.merchantWallet).toBe(A_WALLET);
    expect(harnessed.announcer.announced).toStrictEqual([
      {
        kind: "wallet_set",
        merchant_id: merchantId,
        to: A_WALLET,
        to_split: recorded?.address,
        asked_with: SIGNED_IN,
      },
    ]);
  });

  it.each([
    ["mail is down", "not_handed_over" as const],
    ["nobody is told", "nobody_to_tell" as const],
  ])("applies all the same when %s, because it replaces nothing", async (_why, outcome) => {
    const { harnessed } = await started();
    const merchantId = await aNewMerchant(harnessed);
    harnessed.announcer.answer = outcome;

    expect(await ask(harnessed, A_WALLET, merchantId)).toStrictEqual({
      payout_wallet: A_WALLET,
      pending: null,
    });
  });

  it("never waits on its message", async () => {
    const { harnessed } = await started();
    const merchantId = await aNewMerchant(harnessed);
    harnessed.announcer.answer = () => new Promise(() => undefined);

    expect(await ask(harnessed, A_WALLET, merchantId)).toStrictEqual({
      payout_wallet: A_WALLET,
      pending: null,
    });
  });

  it("is announced to nobody on the test channel", async () => {
    const { harnessed } = await started({ PAYMENT_NETWORK: "eip155:84532" });
    const merchantId = await aNewMerchant(harnessed);

    await ask(harnessed, A_WALLET, merchantId);

    expect(harnessed.announcer.announced).toStrictEqual([]);
  });
});

describe("a replacement on the live deployment", () => {
  it("waits forty-eight hours, and payment requests name the address paid now until then", async () => {
    // The promise the whole wait is for: a session that is not the owner's
    // cannot move a merchant's money today. Until the moment is reached, every
    // agent asking to pay is told the old address.
    const { served, harnessed } = await started();
    const itemId = await published(served, harnessed.merchant.key);
    const asked = harnessed.now();

    const answered = await ask(harnessed, A_WALLET);

    expect(answered).toStrictEqual({
      payout_wallet: harnessed.merchant.wallet,
      pending: { payout_wallet: A_WALLET, takes_effect_at: at(asked + THE_WAIT) },
    });
    expect(await walletOf(served, harnessed.merchant.key)).toStrictEqual(answered);
    const paidNow = (await harnessed.store.merchantById(harnessed.merchant.id))?.payoutWallet;
    expect(paidNow?.split?.merchantWallet).toBe(harnessed.merchant.wallet);
    expect(await payToNow(served, itemId)).toBe(paidNow?.split?.address);

    harnessed.advance(THE_WAIT - 1);
    expect(await payToNow(served, itemId)).toBe(paidNow?.split?.address);

    // Nothing is written when the moment comes, so the split named from then
    // on is the one recorded with the change.
    harnessed.advance(1);
    expect(paidNow?.pending?.split?.merchantWallet).toBe(A_WALLET);
    expect(await payToNow(served, itemId)).toBe(paidNow?.pending?.split?.address);
    expect(await walletOf(served, harnessed.merchant.key)).toStrictEqual({
      payout_wallet: A_WALLET,
      pending: null,
    });
  });

  it("answers the merchant's code with the wallets, never their splits, while a change waits", async () => {
    // `payout_wallet` means where the merchant's share arrives, so a strict
    // reader of the published package reads it as it always did.
    const { served, harnessed } = await started();
    await ask(harnessed, A_WALLET);

    const answered = await served.call("GET", "/v0/payout-wallet", {
      headers: bearer(harnessed.merchant.key),
    });

    const document = PayoutWalletSchema.strict().parse(answered.body);
    expect(document.payout_wallet).toBe(harnessed.merchant.wallet);
    expect(document.pending?.payout_wallet).toBe(A_WALLET);
    for (const split of [
      splitOf(harnessed, harnessed.merchant.wallet),
      splitOf(harnessed, A_WALLET),
    ]) {
      expect(JSON.stringify(answered.body).toLowerCase()).not.toContain(
        split.address.toLowerCase(),
      );
    }
  });

  it("is where a payment made once the wait is over is checked and settled", async () => {
    // The challenge is not the only reader. A payment is verified against the
    // address its merchant is paid at when it arrives, and a sale made after
    // the moment has to be checked against the new address the agent was told
    // to pay — checked against the old one, the payment layer would refuse a
    // payment made out exactly as the challenge said.
    const { served, harnessed } = await started();
    const itemId = await published(served, harnessed.merchant.key);
    await ask(harnessed, A_WALLET);
    harnessed.advance(THE_WAIT);

    const bought = await buyOverHttp(harnessed, served, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });

    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
    const recorded = await recordedSplitOf(harnessed, A_WALLET);
    expect(harnessed.facilitator.verifies.at(-1)?.payTo).toBe(recorded?.address);
    expect(harnessed.facilitator.settles.at(-1)?.payTo).toBe(recorded?.address);
  });

  it("checks a payment against the split of the wallet in force when it arrives, whatever the challenge named", async () => {
    // Between the challenge and the payment the waiting wallet's moment can
    // come; a payment made out to the old split is a different purchase. The
    // refusal itself is the payment layer's edge (`adapters/x402`); this pins
    // which split verification carries.
    const { served, harnessed } = await started();
    const itemId = await published(served, harnessed.merchant.key);
    await ask(harnessed, A_WALLET);
    const challenged = await payToNow(served, itemId);
    harnessed.advance(THE_WAIT);

    await buyOverHttp(harnessed, served, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });

    expect(challenged).toBe(splitOf(harnessed, harnessed.merchant.wallet).address);
    expect(harnessed.facilitator.verifies.at(-1)?.payTo).toBe(
      (await recordedSplitOf(harnessed, A_WALLET))?.address,
    );
  });

  it("checks a payment against the split in force when it arrives, though its order opened before the moment", async () => {
    // A merchant often leaves a wallet because its key leaked. Checked
    // against the split in force when the order opened, every order that
    // straddles the moment would be paid to the wallet they left.
    const { served, harnessed } = await started();
    const itemId = await published(served, harnessed.merchant.key);
    await ask(harnessed, A_WALLET);
    harnessed.advance(THE_WAIT - 1_000);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error(`no price was offered: ${offered.step}`);
    harnessed.advance(2_000);

    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    expect(harnessed.facilitator.verifies.at(-1)?.payTo).toBe(
      (await recordedSplitOf(harnessed, A_WALLET))?.address,
    );
  });

  it("charges the split verified before the moment, even when the charge comes after it", async () => {
    // In the synchronous mode the charge comes after the goods. Sent to the
    // split that took effect meanwhile, it would be refused after the goods
    // went out, since the buyer signed for the other.
    const { served, harnessed } = await started();
    const itemId = await published(served, harnessed.merchant.key);
    await ask(harnessed, A_WALLET);
    harnessed.advance(THE_WAIT - 1_000);

    const bought = await buyOverHttp(harnessed, served, itemId, {
      onOrder: () => {
        harnessed.advance(2_000);
        return { delivered: { access_code: "SESAME" } };
      },
    });

    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
    const signedFor = (await recordedSplitOf(harnessed, harnessed.merchant.wallet))?.address;
    expect(harnessed.facilitator.verifies.at(-1)?.payTo).toBe(signedFor);
    expect(harnessed.facilitator.settles.at(-1)?.payTo).toBe(signedFor);
    expect(await payToNow(served, itemId)).toBe(
      (await recordedSplitOf(harnessed, A_WALLET))?.address,
    );
  });

  it("is announced before it is recorded, saying what changes and when", async () => {
    const { served, harnessed } = await started();
    const asked = harnessed.now();
    let recordedWhileAnnouncing: WalletAnswer | null = null;
    harnessed.announcer.answer = async () => {
      // What the merchant's own caller would read while the message is still
      // being handed over: nothing yet, because nothing is written first.
      recordedWhileAnnouncing = await walletOf(served, harnessed.merchant.key);
      return "handed_over";
    };

    await ask(harnessed, A_WALLET);

    expect(recordedWhileAnnouncing).toStrictEqual({
      payout_wallet: harnessed.merchant.wallet,
      pending: null,
    });
    expect(harnessed.announcer.announced).toStrictEqual([
      {
        kind: "wallet_change",
        merchant_id: harnessed.merchant.id,
        from: harnessed.merchant.wallet,
        from_split: splitOf(harnessed, harnessed.merchant.wallet).address,
        to: A_WALLET,
        to_split: splitOf(harnessed, A_WALLET).address,
        not_before: at(asked + THE_WAIT),
        asked_with: SIGNED_IN,
      },
    ]);
    // The splits the message named are the ones recorded once it was handed
    // over: the one buyers pay now, and the one they pay once the change
    // applies.
    expect((await recordedSplitOf(harnessed, A_WALLET))?.address).toBe(
      splitOf(harnessed, A_WALLET).address,
    );
    expect(
      (await harnessed.store.merchantById(harnessed.merchant.id))?.payoutWallet.split?.address,
    ).toBe(splitOf(harnessed, harnessed.merchant.wallet).address);
  });

  it("records nothing of a change whose message could not go out, not even its split", async () => {
    const { harnessed } = await started();
    harnessed.announcer.answer = "not_handed_over";

    expect(await asking(harnessed, A_WALLET)).toBe("not_announced");

    expect(await recordedSplitOf(harnessed, A_WALLET)).toBeNull();
  });

  it("counts the forty-eight hours from the moment every message was handed over", async () => {
    // The message cannot know when it will have been handed over, which is why
    // it says "not before". What is recorded is counted from after, so the
    // change never takes effect earlier than any message said.
    const { harnessed } = await started();
    const asked = harnessed.now();
    harnessed.announcer.answer = async () => {
      harnessed.advance(5 * 60 * 1_000);
      return "handed_over";
    };

    const answered = await ask(harnessed, A_WALLET);

    expect(answered.pending?.takes_effect_at).toBe(at(asked + 5 * 60 * 1_000 + THE_WAIT));
    expect((harnessed.announcer.announced[0] as { not_before: string }).not_before).toBe(
      at(asked + THE_WAIT),
    );
  });
});

describe("asking again", () => {
  it("for the address already waiting changes nothing, sends nothing and restarts no clock", async () => {
    // A retry after a dropped connection. It has to be safe, and it has to
    // answer with the change that is waiting, or the caller reads the old
    // address back and takes its own write for a failure.
    const { harnessed } = await started();
    const first = await ask(harnessed, A_WALLET);
    harnessed.advance(HOURS);

    let again: WalletAnswer | undefined;
    const written = await journalled(async () => {
      again = await ask(harnessed, A_WALLET.toLowerCase());
    });

    expect(again).toStrictEqual(first);
    expect(harnessed.announcer.announced).toHaveLength(1);
    // Its split was recorded with the first ask, and the retry records none.
    expect(written).toStrictEqual([]);
    expect(await recordedSplitOf(harnessed, A_WALLET)).not.toBeNull();
  });

  it("for a different address replaces the waiting change and starts the wait again", async () => {
    const { served, harnessed } = await started();
    await ask(harnessed, A_WALLET);
    harnessed.advance(HOURS);
    const replaced = harnessed.now();

    const answered = await ask(harnessed, ANOTHER_WALLET);

    expect(answered).toStrictEqual({
      payout_wallet: harnessed.merchant.wallet,
      pending: { payout_wallet: ANOTHER_WALLET, takes_effect_at: at(replaced + THE_WAIT) },
    });
    expect(harnessed.announcer.announced).toHaveLength(2);
    expect(harnessed.announcer.announced[1]).toMatchObject({
      kind: "wallet_change",
      from: harnessed.merchant.wallet,
      to: ANOTHER_WALLET,
    });

    // And the first change never takes effect: its moment passes and the
    // money is still paid where it was.
    harnessed.advance(THE_WAIT - HOURS);
    expect((await walletOf(served, harnessed.merchant.key)).payout_wallet).toBe(
      harnessed.merchant.wallet,
    );
  });

  it("keeps every waiting split it recorded and names only the one in force", async () => {
    // A replacement replaced again, and a cancel, change which split a
    // payment names, never what is recorded: money a stray transfer sent to
    // any of them is still somebody's.
    const { served, harnessed } = await started();
    const itemId = await published(served, harnessed.merchant.key);
    const S1 = splitOf(harnessed, harnessed.merchant.wallet).address;
    await ask(harnessed, A_WALLET);
    harnessed.advance(HOURS);
    await ask(harnessed, ANOTHER_WALLET);

    expect(await recordedSplitOf(harnessed, harnessed.merchant.wallet)).not.toBeNull();
    expect(await recordedSplitOf(harnessed, A_WALLET)).not.toBeNull();
    expect(await recordedSplitOf(harnessed, ANOTHER_WALLET)).not.toBeNull();
    expect(await payToNow(served, itemId)).toBe(S1);
    harnessed.advance(THE_WAIT);
    expect(await payToNow(served, itemId)).toBe(splitOf(harnessed, ANOTHER_WALLET).address);
  });

  it("names the kept split again after a cancel, and records nothing new for it", async () => {
    const { served, harnessed } = await started();
    const itemId = await published(served, harnessed.merchant.key);
    await ask(harnessed, A_WALLET);

    const written = await journalled(() => ask(harnessed, harnessed.merchant.wallet));
    harnessed.advance(THE_WAIT);

    expect(written).toStrictEqual([]);
    expect(await recordedSplitOf(harnessed, A_WALLET)).not.toBeNull();
    expect(await payToNow(served, itemId)).toBe(
      splitOf(harnessed, harnessed.merchant.wallet).address,
    );
  });

  it("for the address paid now cancels the waiting change, and says so", async () => {
    const { served, harnessed } = await started();
    const itemId = await published(served, harnessed.merchant.key);
    await ask(harnessed, A_WALLET);

    const cancelled = await ask(harnessed, harnessed.merchant.wallet);

    expect(cancelled).toStrictEqual({
      payout_wallet: harnessed.merchant.wallet,
      pending: null,
    });
    expect(harnessed.announcer.announced[1]).toStrictEqual({
      kind: "wallet_change_cancelled",
      merchant_id: harnessed.merchant.id,
      kept: harnessed.merchant.wallet,
      kept_split: (await recordedSplitOf(harnessed, harnessed.merchant.wallet))?.address,
      cancelled: A_WALLET,
      asked_with: SIGNED_IN,
    });
    harnessed.advance(THE_WAIT);
    expect(await payToNow(served, itemId)).toBe(
      (await recordedSplitOf(harnessed, harnessed.merchant.wallet))?.address,
    );
    expect(await recordedSplitOf(harnessed, A_WALLET)).not.toBeNull();
  });

  it("cancels even while mail is down, because a cancel moves money nowhere new", async () => {
    const { harnessed } = await started();
    await ask(harnessed, A_WALLET);
    harnessed.announcer.answer = "not_handed_over";

    expect(await ask(harnessed, harnessed.merchant.wallet)).toStrictEqual({
      payout_wallet: harnessed.merchant.wallet,
      pending: null,
    });
  });

  it("for the address paid now with nothing waiting changes nothing and sends nothing", async () => {
    const { harnessed } = await started();

    expect(await ask(harnessed, harnessed.merchant.wallet)).toStrictEqual({
      payout_wallet: harnessed.merchant.wallet,
      pending: null,
    });
    expect(harnessed.announcer.announced).toStrictEqual([]);
  });
});

describe("a change that could not be announced", () => {
  // Two answers, and in each nothing is written: the wallet paid now and
  // whatever was already waiting are exactly as they were. The words a person
  // reads for each are the dashboard's, and its own suite holds them.
  it.each([
    ["nobody_to_tell", "nobody_to_tell"],
    ["not_handed_over", "not_announced"],
  ] as const)(
    "is refused when the dashboard answers %s, and nothing is recorded",
    async (outcome, refusal) => {
      const { served, harnessed } = await started();
      await ask(harnessed, A_WALLET);
      const before = await walletOf(served, harnessed.merchant.key);
      harnessed.announcer.answer = outcome;

      expect(await asking(harnessed, ANOTHER_WALLET)).toBe(refusal);
      expect(await walletOf(served, harnessed.merchant.key)).toStrictEqual(before);
    },
  );

  it("is refused as not announced when telling throws", async () => {
    // The dashboard tells in the gateway's own process, so a failure is a throw
    // from our own code: reading the addresses, or a defect before one message
    // or between two. That is "not every message was handed over, and some may
    // have been", which is what this refusal says.
    const { served, harnessed } = await started();
    await ask(harnessed, A_WALLET);
    const before = await walletOf(served, harnessed.merchant.key);
    harnessed.announcer.answer = async () => {
      throw new Error("the addresses could not be read");
    };

    expect(await asking(harnessed, ANOTHER_WALLET)).toBe("not_announced");
    expect(await walletOf(served, harnessed.merchant.key)).toStrictEqual(before);
  });
  it("is refused as not announced when telling does not finish within twenty seconds, and nothing is recorded", async () => {
    // The dashboard's page waits thirty seconds for this answer, so the gateway
    // gives one before that: a page that stopped waiting first would tell a
    // person the gateway did not answer while their change went on to be
    // recorded. A telling held up by the mail provider or the database is cut
    // off at twenty seconds, and its messages may still go out after.
    const { served, harnessed } = await started();
    await ask(harnessed, A_WALLET);
    const before = await walletOf(served, harnessed.merchant.key);
    harnessed.announcer.answer = () => new Promise(() => {});

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const asked = asking(harnessed, ANOTHER_WALLET);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await Promise.race([asked, Promise.resolve("still waiting")])).toBe("not_announced");
    } finally {
      vi.useRealTimers();
    }
    expect(await walletOf(served, harnessed.merchant.key)).toStrictEqual(before);
  });
});

describe("two changes for one merchant at once", () => {
  it("records the one announced last and refuses the other in words, writing nothing over it", async () => {
    // The first is still being announced when the second is asked for, and
    // the second is announced and recorded first. Written blindly, the first
    // would land on top of it and the waiting address would be one whose
    // message went out before the one the merchant just read.
    const { served, harnessed } = await started();
    let nested = false;
    harnessed.announcer.answer = async () => {
      if (!nested) {
        nested = true;
        // Another session at the same merchant.
        await harnessed.gateway.setPayoutWallet(harnessed.merchant.id, ANOTHER_WALLET, {
          kind: "signed_in",
          email: "partner@example.com",
        });
      }
      return "handed_over";
    };

    // Its message did go out, and the refusal is the one that says so.
    expect(await asking(harnessed, A_WALLET)).toBe("raced_after_announcing");
    expect((await walletOf(served, harnessed.merchant.key)).pending?.payout_wallet).toBe(
      ANOTHER_WALLET,
    );
    // The change recorded is the one whose split exists; the losing change's
    // message went out, but its split was never recorded and nothing names it.
    expect(await recordedSplitOf(harnessed, ANOTHER_WALLET)).not.toBeNull();
    expect(await recordedSplitOf(harnessed, A_WALLET)).toBeNull();
    harnessed.advance(THE_WAIT);
    const itemId = await published(served, harnessed.merchant.key);
    expect(await payToNow(served, itemId)).toBe(splitOf(harnessed, ANOTHER_WALLET).address);
  });

  it("answers a retry that arrives while the first ask is still announced with the same waiting change", async () => {
    // "Asking again is safe" is a promise to a caller whose connection dropped
    // while the gateway was waiting on the dashboard — up to twenty seconds. The
    // retry is announced and recorded first; the first ask then finds the row
    // moved, and what moved it is exactly the change it asked for.
    const { harnessed } = await started();
    const retry: { answered?: Awaited<ReturnType<typeof asking>> } = {};
    let retrying = false;
    harnessed.announcer.answer = async () => {
      if (!retrying) {
        retrying = true;
        retry.answered = await asking(harnessed, A_WALLET);
      }
      return "handed_over";
    };

    const first = await ask(harnessed, A_WALLET);

    expect(retry.answered).toStrictEqual(first);
    expect(first.pending?.payout_wallet).toBe(A_WALLET);
  });

  it("lets a cancel win over a change still being announced, and refuses the change", async () => {
    const { served, harnessed } = await started();
    await ask(harnessed, A_WALLET);
    const cancel: { answered?: WalletAnswer } = {};
    let cancelling = false;
    harnessed.announcer.answer = async (announcement) => {
      if (announcement.kind === "wallet_change" && !cancelling) {
        cancelling = true;
        cancel.answered = await ask(harnessed, harnessed.merchant.wallet);
      }
      return "handed_over";
    };

    const refused = await asking(harnessed, ANOTHER_WALLET);

    expect(cancel.answered).toStrictEqual({
      payout_wallet: harnessed.merchant.wallet,
      pending: null,
    });
    expect(refused).toBe("raced_after_announcing");
    expect((await walletOf(served, harnessed.merchant.key)).pending).toBeNull();
  });

  it("refuses a cancel that a recorded change overtook, without claiming a message", async () => {
    const { served, harnessed } = await started();
    await ask(harnessed, A_WALLET);
    const writing = harnessed.store.setPayoutWallet.bind(harnessed.store);
    let overtaken = false;
    harnessed.store.setPayoutWallet = async (id, expected, next, when) => {
      if (!overtaken) {
        overtaken = true;
        await writing(
          id,
          expected,
          {
            address: harnessed.merchant.wallet,
            split: splitOf(harnessed, harnessed.merchant.wallet),
            pending: {
              address: ANOTHER_WALLET,
              takesEffectAt: when + 48 * HOURS,
              split: splitOf(harnessed, ANOTHER_WALLET),
            },
          },
          when,
        );
      }
      return await writing(id, expected, next, when);
    };

    // A cancel is written before it is announced, so no message about it went
    // out, and the refusal is the one that claims none.
    expect(await asking(harnessed, harnessed.merchant.wallet)).toBe("raced");
    expect((await walletOf(served, harnessed.merchant.key)).pending?.payout_wallet).toBe(
      ANOTHER_WALLET,
    );
  });

  it("refuses a raced first address without claiming a message that was never sent", async () => {
    // A first address is written before anything is announced, so when
    // another write lands first there is no message about it anywhere, and a
    // refusal that said there might be would send its reader looking for one.
    const { harnessed } = await started();
    const merchantId = await harnessed.gateway.registerMerchant();
    const writing = harnessed.store.setPayoutWallet.bind(harnessed.store);
    let overtaken = false;
    harnessed.store.setPayoutWallet = async (id, expected, next, when) => {
      if (!overtaken) {
        overtaken = true;
        await writing(
          id,
          expected,
          { address: ANOTHER_WALLET, split: splitOf(harnessed, ANOTHER_WALLET, id), pending: null },
          when,
        );
      }
      return await writing(id, expected, next, when);
    };

    expect(await asking(harnessed, A_WALLET, merchantId)).toBe("raced");
    expect((await harnessed.gateway.payoutWallet(merchantId)).payout_wallet).toBe(ANOTHER_WALLET);
  });
});

describe("a deployment where no money is real", () => {
  it.each([
    ["the test channel", { PAYMENT_NETWORK: "eip155:84532" }],
    ["a sandbox", { FACILITATOR_URL: "sandbox:scripted" }],
  ])("applies a replacement at once on %s and announces nothing", async (_where, overrides) => {
    const { harnessed } = await started(overrides);

    expect(await ask(harnessed, A_WALLET)).toStrictEqual({
      payout_wallet: A_WALLET,
      pending: null,
    });
    expect(harnessed.announcer.announced).toStrictEqual([]);
  });

  it("announces no new key either", async () => {
    const { served, harnessed } = await started({ PAYMENT_NETWORK: "eip155:84532" });

    const issued = await served.call("POST", "/v0/keys", {
      body: { label: "the stock worker" },
      headers: bearer(harnessed.merchant.key),
    });

    expect(issued.status).toBe(200);
    expect(harnessed.announcer.announced).toStrictEqual([]);
  });
});

describe("a new key on the live deployment", () => {
  it("is announced, naming the key issued and the key that asked", async () => {
    const { served, harnessed } = await started();

    const issued = await served.call("POST", "/v0/keys", {
      body: { label: "the stock worker" },
      headers: bearer(harnessed.merchant.key),
    });

    expect(issued.status).toBe(200);
    const { key } = issued.body as { key: { id: string; label: string } };
    expect(harnessed.announcer.announced).toStrictEqual([
      {
        kind: "key_issued",
        merchant_id: harnessed.merchant.id,
        key: { id: key.id, label: "the stock worker" },
        asked_with: await theMerchantsKey(harnessed),
      },
    ]);
  });

  it.each([
    ["nobody to tell", "nobody_to_tell" as const],
    ["mail down", "not_handed_over" as const],
  ])("is issued all the same with %s", async (_why, outcome) => {
    // A key moves no money, and a merchant must not be kept from one — their
    // first above all — because mail is down.
    const { served, harnessed } = await started();
    harnessed.announcer.answer = outcome;

    const issued = await served.call("POST", "/v0/keys", {
      body: { label: "the stock worker" },
      headers: bearer(harnessed.merchant.key),
    });

    expect(issued.status).toBe(200);
    expect((issued.body as { secret: string }).secret).toMatch(/^csk_live_/);
  });

  it("never waits on its message", async () => {
    const { served, harnessed } = await started();
    harnessed.announcer.answer = () => new Promise(() => undefined);

    const issued = await served.call("POST", "/v0/keys", {
      body: { label: "the stock worker" },
      headers: bearer(harnessed.merchant.key),
    });

    expect(issued.status).toBe(200);
  });

  it("is refused at the door with a label longer than one line of a hundred characters", async () => {
    // Nothing is issued and nothing is announced, so a key cannot be named in
    // a way that makes the message about it impossible to send.
    const { served, harnessed } = await started();

    for (const label of ["k".repeat(8 * 1024), "the stock worker\nhttps://example.com/login"]) {
      const refused = await served.call("POST", "/v0/keys", {
        body: { label },
        headers: bearer(harnessed.merchant.key),
      });
      expect(refused.status).toBe(400);
    }
    expect(harnessed.announcer.announced).toStrictEqual([]);
  });

  it("names a key made elsewhere by one line of at most a hundred characters", async () => {
    // A key made elsewhere can carry any label. When it issues another key, the
    // announcement names it all the same, as one line a message can carry,
    // rather than failing to announce because of how a key was named.
    const { served, harnessed } = await started();
    const long = `the stock\nworker ${"k".repeat(200)}`;
    const key = await harnessed.addKey(harnessed.merchant.id, long);

    const issued = await served.call("POST", "/v0/keys", {
      body: { label: "the price desk" },
      headers: bearer(key),
    });

    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const [announced] = harnessed.announcer.announced;
    expect(announced?.kind).toBe("key_issued");
    const named = announced?.kind === "key_issued" ? announced.asked_with : null;
    expect(named?.kind).toBe("merchant_code");
    const label = named?.kind === "merchant_code" ? named.label : "";
    expect(label).not.toMatch(/[\r\n\t]/);
    expect(label.length).toBeLessThanOrEqual(101);
    expect(label.startsWith("the stock worker kkk")).toBe(true);
  });
});

describe("a new key issued from a session in the dashboard", () => {
  it("names the account it was issued from", async () => {
    // No key is on a call from the dashboard, and what the gateway knows of it
    // is the account the session is signed in as, so that is what the message
    // names: an account at the merchant can tell whose session asked.
    const { harnessed } = await started();

    const issued = await harnessed.gateway.issueMerchantKey(
      harnessed.merchant.id,
      "the stock worker",
      SIGNED_IN,
    );

    expect(harnessed.announcer.announced).toStrictEqual([
      {
        kind: "key_issued",
        merchant_id: harnessed.merchant.id,
        key: { id: issued.key.id, label: "the stock worker" },
        asked_with: SIGNED_IN,
      },
    ]);
  });
});

describe("an address that cannot be a payout wallet, on the live deployment", () => {
  /** What a merchant could paste from the payout screen, or the commission's own wallets. */
  const notWallets = (harnessed: Harness) => {
    const network = harnessed.runtime.config.payoutSplit;
    const networks = Object.values(harnessed.runtime.config.payoutSplitNetworks);
    return [
      ["Multicall3", network.multicall3, "multicall3"],
      ["the warehouse, in lower case", network.warehouse.toLowerCase(), "split_warehouse"],
      ...networks.map(
        (each) =>
          [
            `${each.network}'s commission wallet`,
            each.commissionWallet,
            "commission_wallet",
          ] as const,
      ),
      [
        "the merchant's own split",
        splitOf(harnessed, harnessed.merchant.wallet).address,
        "payout_split",
      ],
    ] as const;
  };

  it("is refused as a replacement before any message goes out, and nothing is recorded", async () => {
    // Announced, a replacement pointing at Multicall3 would apply in two days
    // and every withdrawal of the merchant's share would land where anyone
    // takes it with one call.
    const { served, harnessed } = await started();
    const before = await walletOf(served, harnessed.merchant.key);

    for (const [what, address, is] of notWallets(harnessed)) {
      expect(await asking(harnessed, address), what).toStrictEqual({
        refused: "not_a_payout_wallet",
        is,
      });
    }

    expect(harnessed.announcer.announced).toStrictEqual([]);
    expect(await walletOf(served, harnessed.merchant.key)).toStrictEqual(before);
  });

  it("is refused as a first wallet before anything is written or announced", async () => {
    const { harnessed } = await started();
    const merchantId = await harnessed.gateway.registerMerchant();

    for (const [what, address, is] of notWallets(harnessed)) {
      expect(await asking(harnessed, address, merchantId), what).toStrictEqual({
        refused: "not_a_payout_wallet",
        is,
      });
    }

    expect(harnessed.announcer.announced).toStrictEqual([]);
    expect((await harnessed.gateway.payoutWallet(merchantId)).payout_wallet).toBeNull();
  });
});

describe("the journal of recorded splits", () => {
  it("writes down every split recorded for the first time, with everything needed to rebuild it", async () => {
    // Until a split's first payout its parameters are nowhere but its row. A
    // database restored from a copy older than the row loses them, and the
    // journal is what they are entered again from.
    const { harnessed } = await started();
    const merchantId = await harnessed.gateway.registerMerchant();

    const lines = await journalled(async () => {
      await ask(harnessed, A_WALLET, merchantId);
      await ask(harnessed, ANOTHER_WALLET, merchantId);
    });

    const expected = [
      splitOf(harnessed, A_WALLET, merchantId),
      splitOf(harnessed, ANOTHER_WALLET, merchantId),
    ];
    expect(lines).toHaveLength(2);
    for (const [index, line] of lines.entries()) {
      const split = expected[index];
      // Every parameter the factory takes, read back from the line alone.
      const rebuilt = payoutSplitFor(
        {
          ...harnessed.runtime.config.payoutSplit,
          commissionWallet: String(line.commissionWallet),
          factory: String(line.factory),
          commissionAllocation: Number(line.commissionAllocation),
          totalAllocation: Number(line.totalAllocation),
          network: String(line.network),
        },
        String(line.merchantId),
        String(line.merchantWallet),
      );
      expect(line).toMatchObject({ ...split, recordedAt: harnessed.now() });
      expect(rebuilt).toStrictEqual(split);
      expect(line.salt).toBe(split?.salt);
      expect(line.owner).toBe(split?.owner);
      expect(line.distributionIncentive).toBe(0);
    }
  });
});

describe("the splits a payout covers", () => {
  it("names a merchant's split in force, the one waiting, and every one that can hold money, and the operator every merchant's", async () => {
    // The payout screen pays out what can hold money: the split buyers pay
    // now and every split a payment was checked against, which still gets
    // late settlements after the merchant moves on. A split that only waited
    // holds nothing until it is in force.
    const { served, harnessed } = await started();
    const itemId = await published(served, harnessed.merchant.key);
    const first = splitOf(harnessed, harnessed.merchant.wallet).address;
    await buyOverHttp(harnessed, served, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    harnessed.advance(1_000);
    const other = await harnessed.addMerchant("Another shop");
    harnessed.advance(1_000);
    await ask(harnessed, A_WALLET);

    const waiting = await harnessed.gateway.payoutSplitsOf(harnessed.merchant.id);
    expect(waiting.inForce?.address).toBe(first);
    expect(waiting.pending?.address).toBe(splitOf(harnessed, A_WALLET).address);
    expect(waiting.toPayOut.map((split) => split.address)).toStrictEqual([first]);

    harnessed.advance(THE_WAIT);
    const moved = await harnessed.gateway.payoutSplitsOf(harnessed.merchant.id);
    expect(moved.inForce?.address).toBe(splitOf(harnessed, A_WALLET).address);
    expect(moved.pending).toBeNull();
    expect(moved.toPayOut.map((split) => split.address)).toStrictEqual([
      first,
      splitOf(harnessed, A_WALLET).address,
    ]);
    expect((await harnessed.gateway.splitsToPayOut()).map((split) => split.address)).toStrictEqual([
      first,
      splitOf(harnessed, other.wallet, other.id).address,
      splitOf(harnessed, A_WALLET).address,
    ]);
  });
});
