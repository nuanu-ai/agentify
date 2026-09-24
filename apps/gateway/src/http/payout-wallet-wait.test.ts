/**
 * A payout wallet change on the live deployment: announced first, then waited
 * on (ADR-0019), over the real HTTP surface.
 *
 * The address a merchant is paid at is the one setting whose change redirects
 * money, and any key of theirs reaches it — the cabinet's, or one sitting in
 * their own server's environment. So on the live deployment a replacement is
 * told to every account naming the merchant before anything is written, and it
 * takes effect forty-eight hours after that. Everything here is what a caller
 * holding a key sees, and what an agent is told to pay while the wait runs.
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
import { ANNOUNCING, type Harness, harness, type Served, serve } from "../testing/harness.js";
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
  (body as { error: { code: string; retryable: boolean } }).error;

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
  it("applies at once and is announced to nobody, or a new merchant could not start selling", async () => {
    const { served, harnessed } = await started();
    const registered = await served.call("POST", "/v0/merchants", {
      body: { invitation: INVITATION },
    });
    const key = (registered.body as { secret: string }).secret;

    expect(await ask(served, key, A_WALLET)).toStrictEqual({
      payout_wallet: A_WALLET,
      pending: null,
    });
    expect(harnessed.announcer.announced).toStrictEqual([]);
  });
});

describe("a replacement on the live deployment", () => {
  it("waits forty-eight hours, and payment requests name the address paid now until then", async () => {
    // The promise the whole wait is for: a key that leaked cannot move a
    // merchant's money today. Until the moment is reached, every agent asking
    // to pay is told the old address.
    const { served, harnessed } = await started();
    const itemId = await published(served, harnessed.merchant.key);
    const asked = harnessed.now();

    const answered = await ask(served, harnessed.merchant.key, A_WALLET);

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

  it("is announced before it is recorded, saying what changes, when, and which key asked", async () => {
    const { served, harnessed } = await started();
    const asked = harnessed.now();
    let recordedWhileAnnouncing: WalletAnswer | null = null;
    harnessed.announcer.answer = async () => {
      // What the merchant's own caller would read while the message is still
      // being handed over: nothing yet, because nothing is written first.
      recordedWhileAnnouncing = await walletOf(served, harnessed.merchant.key);
      return "handed_over";
    };

    await ask(served, harnessed.merchant.key, A_WALLET);

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
        asked_with: await theMerchantsKey(harnessed),
      },
    ]);
  });

  it("counts the forty-eight hours from the moment every message was handed over", async () => {
    // The message cannot know when it will have been handed over, which is why
    // it says "not before". What is recorded is counted from after, so the
    // change never takes effect earlier than any message said.
    const { served, harnessed } = await started();
    const asked = harnessed.now();
    harnessed.announcer.answer = async () => {
      harnessed.advance(5 * 60 * 1_000);
      return "handed_over";
    };

    const answered = await ask(served, harnessed.merchant.key, A_WALLET);

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
      harnessed.announcer.announced.map((one) => (one as Announcement).asked_with),
    ).toStrictEqual([{ kind: "cabinet" }]);
  });
});

describe("asking again", () => {
  it("for the address already waiting changes nothing, sends nothing and restarts no clock", async () => {
    // A retry after a dropped connection. It has to be safe, and it has to
    // answer with the change that is waiting, or the caller reads the old
    // address back and takes its own write for a failure.
    const { served, harnessed } = await started();
    const first = await ask(served, harnessed.merchant.key, A_WALLET);
    harnessed.advance(HOURS);

    const again = await ask(served, harnessed.merchant.key, A_WALLET.toLowerCase());

    expect(again).toStrictEqual(first);
    expect(harnessed.announcer.announced).toHaveLength(1);
  });

  it("for a different address replaces the waiting change and starts the wait again", async () => {
    const { served, harnessed } = await started();
    await ask(served, harnessed.merchant.key, A_WALLET);
    harnessed.advance(HOURS);
    const replaced = harnessed.now();

    const answered = await ask(served, harnessed.merchant.key, ANOTHER_WALLET);

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
    const itemId = await published(served, harnessed.merchant.key);
    await ask(served, harnessed.merchant.key, A_WALLET);

    const cancelled = await ask(served, harnessed.merchant.key, harnessed.merchant.wallet);

    expect(cancelled).toStrictEqual({ payout_wallet: harnessed.merchant.wallet, pending: null });
    expect(harnessed.announcer.announced[1]).toStrictEqual({
      kind: "wallet_change_cancelled",
      merchant_id: harnessed.merchant.id,
      kept: harnessed.merchant.wallet,
      cancelled: A_WALLET,
      asked_with: await theMerchantsKey(harnessed),
    });
    harnessed.advance(THE_WAIT);
    expect(await payToNow(served, itemId)).toBe(harnessed.merchant.wallet);
  });

  it("cancels even while mail is down, because a cancel moves money nowhere new", async () => {
    const { served, harnessed } = await started();
    await ask(served, harnessed.merchant.key, A_WALLET);
    harnessed.announcer.answer = "not_handed_over";

    expect(await ask(served, harnessed.merchant.key, harnessed.merchant.wallet)).toStrictEqual({
      payout_wallet: harnessed.merchant.wallet,
      pending: null,
    });
  });

  it("for the address paid now with nothing waiting changes nothing and sends nothing", async () => {
    const { served, harnessed } = await started();

    expect(await ask(served, harnessed.merchant.key, harnessed.merchant.wallet)).toStrictEqual({
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
      await ask(served, harnessed.merchant.key, A_WALLET);
      const before = await walletOf(served, harnessed.merchant.key);
      harnessed.announcer.answer = outcome;

      const refused = await asking(served, harnessed.merchant.key, ANOTHER_WALLET);

      expect(refused.status, JSON.stringify(refused.body)).toBe(status);
      expect(refusalOf(refused.body).code).toBe(code);
      expect(refusalOf(refused.body).retryable).toBe(false);
      expect(await walletOf(served, harnessed.merchant.key)).toStrictEqual(before);
    },
  );

  it("is refused when the cabinet cannot be reached at all, which reads as no answer", async () => {
    const { served, harnessed } = await started();
    harnessed.announcer.answer = async () => {
      throw new Error("the cabinet is not there");
    };

    const refused = await asking(served, harnessed.merchant.key, A_WALLET);

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
    const other = await harnessed.addKey(harnessed.merchant.id, "a second worker");
    let nested = false;
    harnessed.announcer.answer = async () => {
      if (!nested) {
        nested = true;
        await ask(served, other, ANOTHER_WALLET);
      }
      return "handed_over";
    };

    const refused = await asking(served, harnessed.merchant.key, A_WALLET);

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refusalOf(refused.body).code).toBe("wallet_change_raced");
    expect((await walletOf(served, harnessed.merchant.key)).pending?.payout_wallet).toBe(
      ANOTHER_WALLET,
    );
  });
});

describe("a deployment where no money is real", () => {
  it.each([
    ["the test channel", { PAYMENT_NETWORK: "eip155:84532" }],
    ["a sandbox", { FACILITATOR_URL: "sandbox:scripted" }],
  ])("applies a replacement at once on %s and announces nothing", async (_where, overrides) => {
    const { served, harnessed } = await started(overrides);

    expect(await ask(served, harnessed.merchant.key, A_WALLET)).toStrictEqual({
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
