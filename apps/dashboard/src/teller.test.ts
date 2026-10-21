/**
 * Every account naming the merchant is told and nobody else is; the answer says
 * whether every message was handed over, there was nobody to tell, or a message
 * could not be. Each message carries what a person needs to act (what changes,
 * from what to what, the earliest moment, that it was asked for in the
 * dashboard, where the deciding screen is) and nothing that opens anything.
 */

import { PAYOUT_SPLIT_NETWORKS, payoutSplitFor, payoutSplitNetworkOf } from "@agentify/gateway";
import type { Announcement } from "@agentify/gateway/announcements";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { SIGN_OUT_EVERY_OTHER_DEVICE, STOP_ALL_SELLING } from "./control-labels.js";
import { identityFor } from "./identity.js";
import type { Handover, Message } from "./mail.js";
import type { CommissionRate } from "./shares.js";
import { tellerFor } from "./teller.js";

const MERCHANT = "mch_the_shop";
const FROM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const TO = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
/** The splits buyers pay into for each wallet, as the gateway's facts carry them. */
const LIVE = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:8453");
const FROM_SPLIT = payoutSplitFor(LIVE, MERCHANT, FROM).address;
const TO_SPLIT = payoutSplitFor(LIVE, MERCHANT, TO).address;
const THE_SETTINGS_SCREEN = "https://agentify.ad/dashboard/settings";

const config = () =>
  loadConfig({
    DATABASE_URL: "postgres://unused.example/unused",
    AUTH_SECRET: "a".repeat(44),
    PAYMENT_NETWORK: "eip155:8453",
    FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
    PUBLIC_BASE_URL: "https://agentify.ad",
    BASE_PATH: "/dashboard",
  });

const aWalletChange: Announcement = {
  kind: "wallet_change",
  merchant_id: MERCHANT,
  from: FROM,
  from_split: FROM_SPLIT,
  to: TO,
  to_split: TO_SPLIT,
  not_before: "2026-09-26T12:00:00.000Z",
  asked_with: { kind: "signed_in", email: "owner@example.com" },
};

const telling = async (
  people: readonly (readonly [email: string, merchantId: string])[],
  refuses: ReadonlySet<string> = new Set(),
  rate: CommissionRate = LIVE,
) => {
  const sent: Message[] = [];
  const postman = async (message: Message): Promise<Handover> => {
    if (refuses.has(message.to)) return "refused";
    sent.push(message);
    return "accepted";
  };
  const settings = config();
  const identity = identityFor(settings, { postman });
  for (const [email, merchantId] of people) {
    await identity.make(email, merchantId);
  }
  return { tell: tellerFor(settings, identity, postman, rate), sent };
};

/** A share of the payout split's total, formatted from the network's own terms. */
const percent = (part: number): string => `${(part / LIVE.totalAllocation) * 100}%`;
const COMMISSION = percent(LIVE.commissionAllocation);
const SHARE = percent(LIVE.totalAllocation - LIVE.commissionAllocation);

describe("a wallet change", () => {
  it("is told to every account naming the merchant, and to nobody else", async () => {
    const { tell, sent } = await telling([
      ["owner@example.com", MERCHANT],
      ["partner@example.com", MERCHANT],
      ["stranger@example.com", "mch_another_shop"],
    ]);

    expect(await tell(aWalletChange)).toBe("handed_over");
    expect(sent.map((message) => message.to).sort()).toStrictEqual([
      "owner@example.com",
      "partner@example.com",
    ]);
  });

  it("says what changes, not before when, that it was asked in the dashboard, and where it is decided, with no token", async () => {
    const { tell, sent } = await telling([["owner@example.com", MERCHANT]]);

    await tell(aWalletChange);

    const [message] = sent;
    for (const text of [message?.body ?? "", message?.html ?? ""]) {
      expect(text).toContain(FROM);
      expect(text).toContain(TO);
      expect(text).toContain("2026-09-26 12:00:00 UTC");
      // Only a dashboard session changes a wallet, so a person who did not ask
      // knows a session did.
      expect(text).toMatch(/asked for in the dashboard/i);
      expect(text).toContain(THE_SETTINGS_SCREEN);
      expect(text).not.toMatch(/token/i);
    }
  });

  it("answers that there is nobody to tell where no account names the merchant", async () => {
    const { tell, sent } = await telling([["stranger@example.com", "mch_another_shop"]]);

    expect(await tell(aWalletChange)).toBe("nobody_to_tell");
    expect(sent).toStrictEqual([]);
  });

  it("answers that a message was not handed over when the provider refused any one", async () => {
    const { tell } = await telling(
      [
        ["owner@example.com", MERCHANT],
        ["partner@example.com", MERCHANT],
      ],
      new Set(["partner@example.com"]),
    );

    expect(await tell(aWalletChange)).toBe("not_handed_over");
  });
});

describe("a key's label, which somebody else may have written", () => {
  it("is written into the message so that no mail client makes a link of it", async () => {
    // Whoever is signed in to the dashboard, the owner or not, can name a key
    // like an instruction with an address in it, so the label is shown as data: quoted, on one line, with nothing a
    // mail client would turn into a link.
    const { tell, sent } = await telling([["owner@example.com", MERCHANT]]);

    await tell({
      kind: "key_issued",
      merchant_id: MERCHANT,
      key: {
        id: "mk_91c0",
        label: "confirm at https://agentify.example/login or www.evil.example",
      },
      asked_with: { kind: "signed_in", email: "owner@example.com" },
    } satisfies Announcement);

    for (const text of [sent[0]?.body ?? "", sent[0]?.html ?? ""]) {
      expect(text).toContain("mk_91c0");
      expect(text).not.toContain("https://agentify.example");
      expect(text).not.toContain("agentify.example/login");
      expect(text).not.toContain("www.evil.example");
    }
    expect((sent[0]?.html.match(/<a /g) ?? []).length).toBe(2);
  });
});

describe("what a message advises and claims", () => {
  // A first wallet and a cancel leave nothing waiting, so advice to cancel
  // cannot work there; what works at once is pausing the selling, then a
  // replacement, which waits.
  it.each([
    [
      "a first wallet",
      {
        kind: "wallet_set",
        merchant_id: MERCHANT,
        to: TO,
        to_split: TO_SPLIT,
        asked_with: { kind: "signed_in", email: "owner@example.com" },
      },
    ],
    [
      "a cancelled change",
      {
        kind: "wallet_change_cancelled",
        merchant_id: MERCHANT,
        kept: FROM,
        kept_split: FROM_SPLIT,
        cancelled: TO,
        asked_with: { kind: "signed_in", email: "owner@example.com" },
      },
    ],
  ] as const)(
    "advises stopping selling, signing out every other device, then an address of one's own, after %s",
    async (_what, request) => {
      const { tell, sent } = await telling([["owner@example.com", MERCHANT]]);

      await tell(request satisfies Announcement);

      // In this order, by the names the screens give the controls: the stop is
      // immediate, the sign-out keeps an intruder from undoing what comes next,
      // and the address waits and is announced.
      const body = sent[0]?.body ?? "";
      const stop = body.indexOf(STOP_ALL_SELLING);
      const signOut = body.indexOf(SIGN_OUT_EVERY_OTHER_DEVICE);
      const address = body.search(/set your own address/i);
      expect(stop).toBeGreaterThan(-1);
      expect(signOut).toBeGreaterThan(stop);
      expect(address).toBeGreaterThan(signOut);
      expect(body).not.toMatch(/cancelling a waiting/i);
    },
  );
});

describe("who asked", () => {
  // Every message names the account the session was signed in as, and says a
  // session rather than a person, because a stolen session is signed in as the
  // owner all the same.
  const ASKED_FROM = { kind: "signed_in", email: "partner@example.com" } as const;

  it.each([
    ["a replacement", { ...aWalletChange, asked_with: ASKED_FROM }],
    [
      "a first wallet",
      {
        kind: "wallet_set",
        merchant_id: MERCHANT,
        to: TO,
        to_split: TO_SPLIT,
        asked_with: ASKED_FROM,
      },
    ],
    [
      "a cancelled change",
      {
        kind: "wallet_change_cancelled",
        merchant_id: MERCHANT,
        kept: FROM,
        kept_split: FROM_SPLIT,
        cancelled: TO,
        asked_with: ASKED_FROM,
      },
    ],
    [
      "a new key",
      {
        kind: "key_issued",
        merchant_id: MERCHANT,
        key: { id: "mk_91c0", label: "the price desk" },
        asked_with: ASKED_FROM,
      },
    ],
  ] as const)(
    "names the account the session that asked for %s is signed in as",
    async (_what, request) => {
      const { tell, sent } = await telling([
        ["owner@example.com", MERCHANT],
        ["partner@example.com", MERCHANT],
      ]);

      await tell(request satisfies Announcement);

      expect(sent).toHaveLength(2);
      for (const message of sent) {
        for (const text of [message.body, message.html]) {
          expect(text).toContain("partner@example.com");
          expect(text).not.toMatch(/person signed in/i);
        }
      }
    },
  );
});

describe("what is announced once it is done", () => {
  it("tells of a first wallet set, naming the address and where to replace it", async () => {
    // It applied at once, so the message is the owner's only word of it if
    // somebody else set it.
    const { tell, sent } = await telling([["owner@example.com", MERCHANT]]);

    const answered = await tell({
      kind: "wallet_set",
      merchant_id: MERCHANT,
      to: TO,
      to_split: TO_SPLIT,
      asked_with: { kind: "signed_in", email: "owner@example.com" },
    } satisfies Announcement);

    expect(answered).toBe("handed_over");
    for (const text of [sent[0]?.body ?? "", sent[0]?.html ?? ""]) {
      expect(text).toContain(TO);
      expect(text).toMatch(/in the dashboard/i);
      expect(text).toContain(THE_SETTINGS_SCREEN);
    }
  });

  it("tells of a cancelled change, naming the address kept and the one cancelled", async () => {
    const { tell, sent } = await telling([["owner@example.com", MERCHANT]]);

    const answered = await tell({
      kind: "wallet_change_cancelled",
      merchant_id: MERCHANT,
      kept: FROM,
      kept_split: FROM_SPLIT,
      cancelled: TO,
      asked_with: { kind: "signed_in", email: "owner@example.com" },
    } satisfies Announcement);

    expect(answered).toBe("handed_over");
    expect(sent[0]?.body).toContain(FROM);
    expect(sent[0]?.body).toContain(TO);
  });

  it("tells of a new key, naming it the way the list of keys does", async () => {
    const { tell, sent } = await telling([["owner@example.com", MERCHANT]]);

    const answered = await tell({
      kind: "key_issued",
      merchant_id: MERCHANT,
      key: { id: "mk_91c0", label: "the price desk" },
      asked_with: { kind: "signed_in", email: "owner@example.com" },
    } satisfies Announcement);

    expect(answered).toBe("handed_over");
    expect(sent[0]?.body).toContain("the price desk");
    expect(sent[0]?.body).toContain("mk_91c0");
  });
});

describe("the payout contract a message names", () => {
  // Nobody can check a split's address by eye against anything they know, so
  // the message is the merchant's record of where buyers pay: whole, named as
  // the payout contract, and saying that it pays only the wallet and Agentify.

  /** The paragraph of the text that names this split. */
  const naming = (text: string, split: string): string => {
    const at = text.indexOf(split);
    expect(at, `the message names ${split}`).toBeGreaterThan(-1);
    return text.slice(Math.max(0, text.lastIndexOf("\n\n", at)), text.indexOf("\n\n", at));
  };

  it("names, with a first wallet, the contract buyers now pay into and what it pays", async () => {
    const { tell, sent } = await telling([["owner@example.com", MERCHANT]]);

    await tell({
      kind: "wallet_set",
      merchant_id: MERCHANT,
      to: TO,
      to_split: TO_SPLIT,
      asked_with: { kind: "signed_in", email: "owner@example.com" },
    } satisfies Announcement);

    const said = naming(sent[0]?.body ?? "", TO_SPLIT);
    expect(said).toMatch(/payout contract/);
    expect(said).toContain(
      `pays only this wallet, ${SHARE} of every sale, and Agentify, ${COMMISSION}`,
    );
    expect(sent[0]?.html).toContain(TO_SPLIT);
  });

  it("names, with a replacement, the contract paid until it applies and the one paid after", async () => {
    const { tell, sent } = await telling([["owner@example.com", MERCHANT]]);

    await tell(aWalletChange);

    const body = sent[0]?.body ?? "";
    expect(naming(body, FROM_SPLIT)).toMatch(/until then buyers pay into/i);
    const after = naming(body, TO_SPLIT);
    expect(after).toMatch(/from then on buyers pay into/i);
    expect(after).toContain(`${SHARE} of every sale`);
    expect(after).toContain(`Agentify, ${COMMISSION}`);
    expect(body.indexOf(FROM_SPLIT)).toBeLessThan(body.indexOf(TO_SPLIT));
    for (const split of [FROM_SPLIT, TO_SPLIT]) {
      expect(sent[0]?.html).toContain(split);
    }
  });

  it("says the shares of the terms the teller is given, so a rate written into the message would be caught", async () => {
    // The Base Sepolia experiment's real terms, 97% to the merchant and 3% to
    // Agentify, with the split made at them.
    const atThreePercent = { commissionAllocation: 30_000, totalAllocation: 1_000_000 };
    const toSplit = payoutSplitFor({ ...LIVE, ...atThreePercent }, MERCHANT, TO).address;
    const { tell, sent } = await telling(
      [["owner@example.com", MERCHANT]],
      new Set(),
      atThreePercent,
    );

    await tell({
      kind: "wallet_set",
      merchant_id: MERCHANT,
      to: TO,
      to_split: toSplit,
      asked_with: { kind: "signed_in", email: "owner@example.com" },
    } satisfies Announcement);

    const said = naming(sent[0]?.body ?? "", toSplit);
    expect(said).toContain("pays only this wallet, 97% of every sale, and Agentify, 3%");
    expect(sent[0]?.body).not.toContain("99.9%");
    expect(sent[0]?.body).not.toContain("0.1%");
  });

  it("names, with a cancel, the contract buyers still pay into", async () => {
    const { tell, sent } = await telling([["owner@example.com", MERCHANT]]);

    await tell({
      kind: "wallet_change_cancelled",
      merchant_id: MERCHANT,
      kept: FROM,
      kept_split: FROM_SPLIT,
      cancelled: TO,
      asked_with: { kind: "signed_in", email: "owner@example.com" },
    } satisfies Announcement);

    const said = naming(sent[0]?.body ?? "", FROM_SPLIT);
    expect(said).toMatch(/buyers still pay into/i);
    expect(said).toContain(`Agentify, ${COMMISSION}`);
    expect(sent[0]?.body).not.toContain(TO_SPLIT);
  });
});
