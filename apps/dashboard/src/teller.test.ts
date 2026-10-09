/**
 * The dashboard's teller: the gateway announces, the dashboard tells every
 * account that names the merchant (ADR-0019), in the process the two share
 * (ADR-0030).
 *
 * The promises are the gateway's to rely on and the merchant's to read. Every
 * account naming the merchant is told and nobody else is. The answer says
 * whether every message was handed over, whether there was nobody to tell, or
 * whether a message could not be. And each message carries the
 * facts a person needs to act — what changes, from what to what, when at the
 * earliest, that it was asked for in the dashboard, and where the screen is that
 * decides it — and nothing that opens anything.
 */

import type { Announcement } from "@agentify/gateway/announcements";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { SIGN_OUT_EVERY_OTHER_DEVICE, STOP_ALL_SELLING } from "./control-labels.js";
import { identityFor } from "./identity.js";
import type { Handover, Message } from "./mail.js";
import { tellerFor } from "./teller.js";

const MERCHANT = "mch_the_shop";
const FROM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const TO = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const THE_SETTINGS_SCREEN = "https://agentify.ad/dashboard/settings";

const config = () =>
  loadConfig({
    DATABASE_URL: "postgres://unused.example/unused",
    AUTH_SECRET: "a".repeat(44),
    PAYMENT_NETWORK: "eip155:8453",
    FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
    REGISTRATION_INVITATION: "the-existing-gateway-invitation",
    PUBLIC_BASE_URL: "https://agentify.ad",
    BASE_PATH: "/dashboard",
  });

const aWalletChange: Announcement = {
  kind: "wallet_change",
  merchant_id: MERCHANT,
  from: FROM,
  to: TO,
  not_before: "2026-09-26T12:00:00.000Z",
};

/**
 * The teller over the real component on its memory store, with accounts at
 * two merchants, and a mail provider that takes or refuses each address as the
 * test says.
 */
const telling = async (
  people: readonly (readonly [email: string, merchantId: string])[],
  refuses: ReadonlySet<string> = new Set(),
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
    await identity.make(email, { id: merchantId, key: `csk_live_key-of-${email}` });
  }
  return { tell: tellerFor(settings, identity, postman), sent };
};

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
      // Only a dashboard's key changes a wallet, so where it was asked for is
      // the dashboard, and a person who did not ask knows a session did.
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
    // A leaked key can be used to issue a key named like an instruction with
    // an address in it. The message is Agentify's, so the label is shown as
    // data: in quotes, on one line, and with nothing in it a mail client
    // would turn into somewhere to click.
    const { tell, sent } = await telling([["owner@example.com", MERCHANT]]);

    await tell({
      kind: "key_issued",
      merchant_id: MERCHANT,
      key: {
        id: "mk_91c0",
        label: "confirm at https://agentify.example/login or www.evil.example",
      },
      asked_with: { kind: "dashboard" },
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
  // A first wallet and a cancel leave nothing waiting, so cancelling a
  // waiting change is advice that cannot work there; what works at once is
  // pausing the selling, and then a replacement, which waits. And the gateway
  // knows the key a change came with, not the person, so no message claims one.
  it.each([
    ["a first wallet", { kind: "wallet_set", merchant_id: MERCHANT, to: TO }],
    [
      "a cancelled change",
      {
        kind: "wallet_change_cancelled",
        merchant_id: MERCHANT,
        kept: FROM,
        cancelled: TO,
      },
    ],
  ] as const)(
    "advises stopping selling, signing out every other device, then an address of one's own, after %s",
    async (_what, request) => {
      const { tell, sent } = await telling([["owner@example.com", MERCHANT]]);

      await tell(request satisfies Announcement);

      // In that order, and by the names the screens give the two controls,
      // which both read from one place: the stop is immediate, the sign-out
      // keeps an intruder from undoing what comes next, and the address waits
      // and is announced.
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

  it.each([
    ["a replacement", aWalletChange],
    ["a first wallet", { kind: "wallet_set", merchant_id: MERCHANT, to: TO }],
    [
      "a new key",
      {
        kind: "key_issued",
        merchant_id: MERCHANT,
        key: { id: "mk_91c0", label: "the price desk" },
        asked_with: { kind: "dashboard" },
      },
    ],
  ] as const)("claims no person signed in for %s, only the dashboard", async (_what, request) => {
    const { tell, sent } = await telling([["owner@example.com", MERCHANT]]);

    await tell(request satisfies Announcement);

    expect(sent[0]?.body ?? "").not.toMatch(/person signed in/i);
  });
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
      cancelled: TO,
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
      asked_with: { kind: "dashboard" },
    } satisfies Announcement);

    expect(answered).toBe("handed_over");
    expect(sent[0]?.body).toContain("the price desk");
    expect(sent[0]?.body).toContain("mk_91c0");
  });
});
