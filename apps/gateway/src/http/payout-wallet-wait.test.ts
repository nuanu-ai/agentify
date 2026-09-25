/**
 * A payout wallet change on the live deployment: announced first, then waited
 * on (ADR-0019), over the real HTTP surface.
 *
 * The address a merchant is paid at is the one setting whose change redirects
 * money, and only the cabinet's own key reaches it, so what it guards against
 * is a session: one left signed in on somebody else's device, or one somebody
 * stole. So on the live deployment a replacement is told to every account
 * naming the merchant before anything is written, and it takes effect
 * forty-eight hours after that. Everything here is what a caller holding a key
 * sees, and what an agent is told to pay while the wait runs.
 *
 * The cabinet is not in this file. The harness records what the gateway asked
 * it to say and answers as a test tells it to, so each of the cabinet's answers
 * — every message handed over, nobody to tell, a message refused, no answer at
 * all — is a case here, and what the cabinet does with a request is the
 * cabinet's own suite.
 *
 * Time is the harness's clock and nothing else: forty-eight hours pass because
 * a test says so.
 */

import type { Card } from "@nuanu-ai/agentify-contracts";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { afterEach, describe, expect, it } from "vitest";
import type { Announcement } from "../announcements.js";
import {
  ANNOUNCING,
  buyOverHttp,
  type Harness,
  harness,
  type Served,
  serve,
} from "../testing/harness.js";
import { PAYMENT_REQUIRED_HEADER } from "./x402.js";

const HOURS = 60 * 60 * 1_000;
const THE_WAIT = 48 * HOURS;

const INVITATION = "the-code-from-the-invitation";

/** What makes a harness live: Base mainnet, its one facilitator, and the cabinet to announce through. */
const LIVE = {
  PAYMENT_NETWORK: "eip155:8453",
  FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  CDP_API_KEY_ID: "key-id",
  CDP_API_KEY_SECRET: "key-secret",
  ...ANNOUNCING,
};

/** Two addresses with letters in them, written the way a wallet shows them. */
const A_WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const ANOTHER_WALLET = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";

let open: { harnessed: Harness; served: Served } | null = null;

const started = async (overrides: Record<string, string> = LIVE) => {
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

interface WalletAnswer {
  readonly payout_wallet: string | null;
  readonly pending: { readonly payout_wallet: string; readonly takes_effect_at: string } | null;
}

const walletOf = async (served: Served, key: string): Promise<WalletAnswer> => {
  const answered = await served.call("GET", "/v0/payout-wallet", { headers: bearer(key) });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return answered.body as WalletAnswer;
};

const asking = (served: Served, key: string, wallet: string) =>
  served.call("POST", "/v0/payout-wallet", {
    body: { payout_wallet: wallet },
    headers: bearer(key),
  });

const ask = async (served: Served, key: string, wallet: string): Promise<WalletAnswer> => {
  const answered = await asking(served, key, wallet);
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  return answered.body as WalletAnswer;
};

const refusalOf = (body: unknown) =>
  (body as { error: { code: string; message: string; retryable: boolean } }).error;

/**
 * Whether a refusal tells its reader a message about the change may be in an
 * inbox. It is a claim about the merchant's own mailbox, so it has to be true
 * when it is made and absent when nothing can have been sent.
 */
const claimsAMessage = (body: unknown): boolean => /message/i.test(refusalOf(body).message);

const at = (instant: number): string => new Date(instant).toISOString();

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
  /** A merchant with no address yet, and the cabinet key registering gave it. */
  const aNewMerchant = async (served: Served): Promise<string> => {
    const registered = await served.call("POST", "/v0/merchants", {
      body: { invitation: INVITATION },
    });
    return (registered.body as { secret: string }).secret;
  };

  it("applies at once, or a new merchant could not start selling, and is announced afterwards", async () => {
    // The message is owed for every address set on the live site, the first
    // included: a session that is not the owner's could set it, and the
    // message is how the owner learns of it.
    const { served, harnessed } = await started();
    const key = await aNewMerchant(served);

    expect(await ask(served, key, A_WALLET)).toStrictEqual({
      payout_wallet: A_WALLET,
      pending: null,
    });
    const [announced] = harnessed.announcer.announced;
    expect(announced).toMatchObject({
      kind: "wallet_set",
      to: A_WALLET,
      asked_with: { kind: "cabinet" },
    });
  });

  it.each([
    ["mail is down", "not_handed_over" as const],
    ["nobody is told", "nobody_to_tell" as const],
  ])("applies all the same when %s, because it replaces nothing", async (_why, outcome) => {
    const { served, harnessed } = await started();
    const key = await aNewMerchant(served);
    harnessed.announcer.answer = outcome;

    expect(await ask(served, key, A_WALLET)).toStrictEqual({
      payout_wallet: A_WALLET,
      pending: null,
    });
  });

  it("never waits on its message", async () => {
    const { served, harnessed } = await started();
    const key = await aNewMerchant(served);
    harnessed.announcer.answer = () => new Promise(() => undefined);

    expect((await asking(served, key, A_WALLET)).status).toBe(200);
  });

  it("is announced to nobody on the test channel", async () => {
    const { served, harnessed } = await started({
      PAYMENT_NETWORK: "eip155:84532",
      REGISTRATION_INVITATION: INVITATION,
    });
    const key = await aNewMerchant(served);

    await ask(served, key, A_WALLET);

    expect(harnessed.announcer.announced).toStrictEqual([]);
  });
});

describe("a replacement on the live deployment", () => {
  it("is refused to a key of the merchant's own code before anybody is told", async () => {
    // A key that cannot make the change must not be able to send messages
    // about one either, so the refusal comes before the announcement.
    const { served, harnessed } = await started();
    const before = await walletOf(served, harnessed.merchant.key);

    const refused = await asking(served, harnessed.merchant.key, A_WALLET);

    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refusalOf(refused.body).code).toBe("not_a_cabinet_key");
    expect(harnessed.announcer.announced).toStrictEqual([]);
    expect(await walletOf(served, harnessed.merchant.key)).toStrictEqual(before);
  });

  it("waits forty-eight hours, and payment requests name the address paid now until then", async () => {
    // The promise the whole wait is for: a session that is not the owner's
    // cannot move a merchant's money today. Until the moment is reached, every agent asking
    // to pay is told the old address.
    const { served, harnessed } = await started();
    const cabinet = await harnessed.addCabinetKey(harnessed.merchant.id);
    const itemId = await published(served, harnessed.merchant.key);
    const asked = harnessed.now();

    const answered = await ask(served, cabinet, A_WALLET);

    expect(answered).toStrictEqual({
      payout_wallet: harnessed.merchant.wallet,
      pending: { payout_wallet: A_WALLET, takes_effect_at: at(asked + THE_WAIT) },
    });
    expect(await walletOf(served, harnessed.merchant.key)).toStrictEqual(answered);
    expect(await payToNow(served, itemId)).toBe(harnessed.merchant.wallet);

    harnessed.advance(THE_WAIT - 1);
    expect(await payToNow(served, itemId)).toBe(harnessed.merchant.wallet);

    harnessed.advance(1);
    expect(await payToNow(served, itemId)).toBe(A_WALLET);
    expect(await walletOf(served, harnessed.merchant.key)).toStrictEqual({
      payout_wallet: A_WALLET,
      pending: null,
    });
  });

  it("is where a payment made once the wait is over is checked and settled", async () => {
    // The challenge is not the only reader. A payment is verified against the
    // address its merchant is paid at when it arrives, and a sale made after
    // the moment has to be checked against the new address the agent was told
    // to pay — checked against the old one, the payment layer would refuse a
    // payment made out exactly as the challenge said.
    const { served, harnessed } = await started();
    const cabinet = await harnessed.addCabinetKey(harnessed.merchant.id);
    const itemId = await published(served, harnessed.merchant.key);
    await ask(served, cabinet, A_WALLET);
    harnessed.advance(THE_WAIT);

    const bought = await buyOverHttp(harnessed, served, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });

    expect(bought.status, JSON.stringify(bought.body)).toBe(200);
    expect(harnessed.facilitator.verifies.at(-1)?.payTo).toBe(A_WALLET);
    expect(harnessed.facilitator.settles.at(-1)?.payTo).toBe(A_WALLET);
  });

  it("is announced before it is recorded, saying what changes, when, and which key asked", async () => {
    const { served, harnessed } = await started();
    const cabinet = await harnessed.addCabinetKey(harnessed.merchant.id);
    const asked = harnessed.now();
    let recordedWhileAnnouncing: WalletAnswer | null = null;
    harnessed.announcer.answer = async () => {
      // What the merchant's own caller would read while the message is still
      // being handed over: nothing yet, because nothing is written first.
      recordedWhileAnnouncing = await walletOf(served, harnessed.merchant.key);
      return "handed_over";
    };

    await ask(served, cabinet, A_WALLET);

    expect(recordedWhileAnnouncing).toStrictEqual({
      payout_wallet: harnessed.merchant.wallet,
      pending: null,
    });
    expect(harnessed.announcer.announced).toStrictEqual([
      {
        kind: "wallet_change",
        merchant_id: harnessed.merchant.id,
        from: harnessed.merchant.wallet,
        to: A_WALLET,
        not_before: at(asked + THE_WAIT),
        asked_with: { kind: "cabinet" },
      },
    ]);
  });

  it("counts the forty-eight hours from the moment every message was handed over", async () => {
    // The message cannot know when it will have been handed over, which is why
    // it says "not before". What is recorded is counted from after, so the
    // change never takes effect earlier than any message said.
    const { served, harnessed } = await started();
    const cabinet = await harnessed.addCabinetKey(harnessed.merchant.id);
    const asked = harnessed.now();
    harnessed.announcer.answer = async () => {
      harnessed.advance(5 * 60 * 1_000);
      return "handed_over";
    };

    const answered = await ask(served, cabinet, A_WALLET);

    expect(answered.pending?.takes_effect_at).toBe(at(asked + 5 * 60 * 1_000 + THE_WAIT));
    expect((harnessed.announcer.announced[0] as { not_before: string }).not_before).toBe(
      at(asked + THE_WAIT),
    );
  });

  it("names the cabinet as the key that asked, when a person signed in to it asked", async () => {
    const { served, harnessed } = await started();
    const registered = await served.call("POST", "/v0/merchants", {
      body: { invitation: INVITATION },
    });
    const cabinetKey = (registered.body as { secret: string }).secret;
    await ask(served, cabinetKey, A_WALLET);

    await ask(served, cabinetKey, ANOTHER_WALLET);

    expect(
      harnessed.announcer.announced
        .filter((one) => one.kind === "wallet_change")
        .map((one) => (one as Announcement).asked_with),
    ).toStrictEqual([{ kind: "cabinet" }]);
  });
});

describe("asking again", () => {
  it("for the address already waiting changes nothing, sends nothing and restarts no clock", async () => {
    // A retry after a dropped connection. It has to be safe, and it has to
    // answer with the change that is waiting, or the caller reads the old
    // address back and takes its own write for a failure.
    const { served, harnessed } = await started();
    const cabinet = await harnessed.addCabinetKey(harnessed.merchant.id);
    const first = await ask(served, cabinet, A_WALLET);
    harnessed.advance(HOURS);

    const again = await ask(served, cabinet, A_WALLET.toLowerCase());

    expect(again).toStrictEqual(first);
    expect(harnessed.announcer.announced).toHaveLength(1);
  });

  it("for a different address replaces the waiting change and starts the wait again", async () => {
    const { served, harnessed } = await started();
    const cabinet = await harnessed.addCabinetKey(harnessed.merchant.id);
    await ask(served, cabinet, A_WALLET);
    harnessed.advance(HOURS);
    const replaced = harnessed.now();

    const answered = await ask(served, cabinet, ANOTHER_WALLET);

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

  it("for the address paid now cancels the waiting change, and says so", async () => {
    const { served, harnessed } = await started();
    const cabinet = await harnessed.addCabinetKey(harnessed.merchant.id);
    const itemId = await published(served, harnessed.merchant.key);
    await ask(served, cabinet, A_WALLET);

    const cancelled = await ask(served, cabinet, harnessed.merchant.wallet);

    expect(cancelled).toStrictEqual({
      payout_wallet: harnessed.merchant.wallet,
      pending: null,
    });
    expect(harnessed.announcer.announced[1]).toStrictEqual({
      kind: "wallet_change_cancelled",
      merchant_id: harnessed.merchant.id,
      kept: harnessed.merchant.wallet,
      cancelled: A_WALLET,
      asked_with: { kind: "cabinet" },
    });
    harnessed.advance(THE_WAIT);
    expect(await payToNow(served, itemId)).toBe(harnessed.merchant.wallet);
  });

  it("cancels even while mail is down, because a cancel moves money nowhere new", async () => {
    const { served, harnessed } = await started();
    const cabinet = await harnessed.addCabinetKey(harnessed.merchant.id);
    await ask(served, cabinet, A_WALLET);
    harnessed.announcer.answer = "not_handed_over";

    expect(await ask(served, cabinet, harnessed.merchant.wallet)).toStrictEqual({
      payout_wallet: harnessed.merchant.wallet,
      pending: null,
    });
  });

  it("for the address paid now with nothing waiting changes nothing and sends nothing", async () => {
    const { served, harnessed } = await started();
    const cabinet = await harnessed.addCabinetKey(harnessed.merchant.id);

    expect(await ask(served, cabinet, harnessed.merchant.wallet)).toStrictEqual({
      payout_wallet: harnessed.merchant.wallet,
      pending: null,
    });
    expect(harnessed.announcer.announced).toStrictEqual([]);
  });
});

describe("a change that could not be announced", () => {
  // Three cases, three codes, and in every one nothing is written: the wallet
  // paid now and whatever was already waiting are exactly as they were.
  it.each([
    ["nobody_to_tell", 409, "wallet_change_nobody_to_tell"],
    ["not_handed_over", 503, "wallet_change_not_announced"],
    ["unconfirmed", 503, "wallet_change_unconfirmed"],
  ] as const)(
    "is refused when the cabinet answers %s, and nothing is recorded",
    async (outcome, status, code) => {
      const { served, harnessed } = await started();
      const cabinet = await harnessed.addCabinetKey(harnessed.merchant.id);
      await ask(served, cabinet, A_WALLET);
      const before = await walletOf(served, harnessed.merchant.key);
      harnessed.announcer.answer = outcome;

      const refused = await asking(served, cabinet, ANOTHER_WALLET);

      expect(refused.status, JSON.stringify(refused.body)).toBe(status);
      expect(refusalOf(refused.body).code).toBe(code);
      expect(refusalOf(refused.body).retryable).toBe(false);
      expect(await walletOf(served, harnessed.merchant.key)).toStrictEqual(before);
    },
  );

  it("is refused as not announced when the cabinet turned the request away before telling anybody", async () => {
    // A listener that refused the request — the wrong secret, a body it would
    // not read — told nobody, so the refusal must not say an account may have
    // been told.
    const { served, harnessed } = await started();
    const cabinet = await harnessed.addCabinetKey(harnessed.merchant.id);
    await ask(served, cabinet, A_WALLET);
    const before = await walletOf(served, harnessed.merchant.key);
    harnessed.announcer.answer = "refused_by_cabinet";

    const refused = await asking(served, cabinet, ANOTHER_WALLET);

    expect(refused.status).toBe(503);
    expect(refusalOf(refused.body).code).toBe("wallet_change_not_announced");
    expect(refusalOf(refused.body).message).not.toMatch(/may (still )?have/i);
    expect(await walletOf(served, harnessed.merchant.key)).toStrictEqual(before);
  });

  it("is refused when the cabinet cannot be reached at all, which reads as no answer", async () => {
    const { served, harnessed } = await started();
    const cabinet = await harnessed.addCabinetKey(harnessed.merchant.id);
    harnessed.announcer.answer = async () => {
      throw new Error("the cabinet is not there");
    };

    const refused = await asking(served, cabinet, A_WALLET);

    expect(refused.status).toBe(503);
    expect(refusalOf(refused.body).code).toBe("wallet_change_unconfirmed");
  });
});

describe("two changes for one merchant at once", () => {
  it("records the one announced last and refuses the other in words, writing nothing over it", async () => {
    // The first is still being announced when the second is asked for, and
    // the second is announced and recorded first. Written blindly, the first
    // would land on top of it and the waiting address would be one whose
    // message went out before the one the merchant just read.
    const { served, harnessed } = await started();
    const cabinet = await harnessed.addCabinetKey(harnessed.merchant.id);
    // Another session at the same merchant, on a key of its own.
    const other = await harnessed.addCabinetKey(harnessed.merchant.id);
    let nested = false;
    harnessed.announcer.answer = async () => {
      if (!nested) {
        nested = true;
        await ask(served, other, ANOTHER_WALLET);
      }
      return "handed_over";
    };

    const refused = await asking(served, cabinet, A_WALLET);

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refusalOf(refused.body).code).toBe("wallet_change_raced");
    // Its message did go out, and the refusal says so.
    expect(claimsAMessage(refused.body)).toBe(true);
    expect((await walletOf(served, harnessed.merchant.key)).pending?.payout_wallet).toBe(
      ANOTHER_WALLET,
    );
  });

  it("answers a retry that arrives while the first ask is still announced with the same waiting change", async () => {
    // "Asking again is safe" is a promise to a caller whose connection dropped
    // while the gateway was waiting on the cabinet — up to twenty seconds. The
    // retry is announced and recorded first; the first ask then finds the row
    // moved, and what moved it is exactly the change it asked for.
    const { served, harnessed } = await started();
    const cabinet = await harnessed.addCabinetKey(harnessed.merchant.id);
    const retry: { answered?: Awaited<ReturnType<typeof asking>> } = {};
    let retrying = false;
    harnessed.announcer.answer = async () => {
      if (!retrying) {
        retrying = true;
        retry.answered = await asking(served, cabinet, A_WALLET);
      }
      return "handed_over";
    };

    const first = await asking(served, cabinet, A_WALLET);

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(retry.answered?.status).toBe(200);
    expect(first.body).toStrictEqual(retry.answered?.body);
    expect((first.body as WalletAnswer).pending?.payout_wallet).toBe(A_WALLET);
  });

  it("lets a cancel win over a change still being announced, and refuses the change", async () => {
    const { served, harnessed } = await started();
    const cabinet = await harnessed.addCabinetKey(harnessed.merchant.id);
    await ask(served, cabinet, A_WALLET);
    const cancel: { answered?: WalletAnswer } = {};
    let cancelling = false;
    harnessed.announcer.answer = async (announcement) => {
      if (announcement.kind === "wallet_change" && !cancelling) {
        cancelling = true;
        cancel.answered = await ask(served, cabinet, harnessed.merchant.wallet);
      }
      return "handed_over";
    };

    const refused = await asking(served, cabinet, ANOTHER_WALLET);

    expect(cancel.answered).toStrictEqual({
      payout_wallet: harnessed.merchant.wallet,
      pending: null,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refusalOf(refused.body).code).toBe("wallet_change_raced");
    expect((await walletOf(served, harnessed.merchant.key)).pending).toBeNull();
  });

  it("refuses a cancel that a recorded change overtook, without claiming a message", async () => {
    const { served, harnessed } = await started();
    const cabinet = await harnessed.addCabinetKey(harnessed.merchant.id);
    await ask(served, cabinet, A_WALLET);
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
            pending: { address: ANOTHER_WALLET, takesEffectAt: when + 48 * HOURS },
          },
          when,
        );
      }
      return await writing(id, expected, next, when);
    };

    const refused = await asking(served, cabinet, harnessed.merchant.wallet);

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refusalOf(refused.body).code).toBe("wallet_change_raced");
    expect(claimsAMessage(refused.body)).toBe(false);
    expect((await walletOf(served, harnessed.merchant.key)).pending?.payout_wallet).toBe(
      ANOTHER_WALLET,
    );
  });

  it("refuses a raced first address without claiming a message that was never sent", async () => {
    // A first address is written before anything is announced, so when
    // another write lands first there is no message about it anywhere, and a
    // refusal that said there might be would send its reader looking for one.
    const { served, harnessed } = await started();
    const registered = await served.call("POST", "/v0/merchants", {
      body: { invitation: INVITATION },
    });
    const key = (registered.body as { secret: string }).secret;
    const writing = harnessed.store.setPayoutWallet.bind(harnessed.store);
    let overtaken = false;
    harnessed.store.setPayoutWallet = async (id, expected, next, when) => {
      if (!overtaken) {
        overtaken = true;
        await writing(id, expected, { address: ANOTHER_WALLET, pending: null }, when);
      }
      return await writing(id, expected, next, when);
    };

    const refused = await asking(served, key, A_WALLET);

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refusalOf(refused.body).code).toBe("wallet_change_raced");
    expect(claimsAMessage(refused.body)).toBe(false);
    expect((await walletOf(served, key)).payout_wallet).toBe(ANOTHER_WALLET);
  });
});

describe("a deployment where no money is real", () => {
  it.each([
    ["the test channel", { PAYMENT_NETWORK: "eip155:84532" }],
    ["a sandbox", { FACILITATOR_URL: "sandbox:scripted" }],
  ])("applies a replacement at once on %s and announces nothing", async (_where, overrides) => {
    const { served, harnessed } = await started(overrides);
    const cabinet = await harnessed.addCabinetKey(harnessed.merchant.id);

    expect(await ask(served, cabinet, A_WALLET)).toStrictEqual({
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
    // A key issued at the terminal, or before labels had a limit, can carry
    // anything. When it issues another key, the announcement names it all the
    // same, as one line the cabinet's listener takes, rather than failing to
    // announce because of how a key was named.
    const { served, harnessed } = await started();
    const long = `the stock\nworker ${"k".repeat(200)}`;
    const key = await harnessed.addKey(harnessed.merchant.id, long);

    const issued = await served.call("POST", "/v0/keys", {
      body: { label: "the price desk" },
      headers: bearer(key),
    });

    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const [announced] = harnessed.announcer.announced;
    const named = (announced as Announcement).asked_with;
    expect(named.kind).toBe("merchant_code");
    const label = named.kind === "merchant_code" ? named.label : "";
    expect(label).not.toMatch(/[\r\n\t]/);
    expect(label.length).toBeLessThanOrEqual(101);
    expect(label.startsWith("the stock worker kkk")).toBe(true);
  });

  it("is not announced when it is the cabinet's own, renewed at every sign-in", async () => {
    const { served, harnessed } = await started();
    const registered = await served.call("POST", "/v0/merchants", {
      body: { invitation: INVITATION },
    });
    const cabinetKey = (registered.body as { secret: string }).secret;

    const renewed = await served.call("POST", "/v0/keys/cabinet", { headers: bearer(cabinetKey) });

    expect(renewed.status).toBe(200);
    expect(harnessed.announcer.announced).toStrictEqual([]);
  });
});
