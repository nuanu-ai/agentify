/**
 * The cabinet's listener for the gateway: the gateway asks, the cabinet tells
 * every account that names the merchant (ADR-0019).
 *
 * The promises are the gateway's to rely on and the merchant's to read. The
 * route opens for the gateway's own secret and for no other — the scanner's
 * above all, since the scanner's route is a different door with a different
 * holder. Every account naming the merchant is told and nobody else is. The
 * answer says whether every message was handed over, whether there was nobody
 * to tell, or whether a message could not be. And each message carries the
 * facts a person needs to act — what changes, from what to what, when at the
 * earliest, that it was asked for in the cabinet, and where the screen is that
 * decides it — and nothing that opens anything.
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { GatewayRequest } from "@agentify/gateway/announcements";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { buildGatewayApp, startGatewayServer, tellerFor } from "./gateway-server.js";
import { identityFor } from "./identity.js";
import type { Handover, Message } from "./mail.js";

const SECRET = "the-gateway-cabinet-secret-this-suite-presents";
const REPORT_IDENTITY_SECRET = "the-scanner-report-identity-secret-32-characters";
const PATH = "/internal/gateway";

const MERCHANT = "mch_the_shop";
const FROM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const TO = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const THE_SETTINGS_SCREEN = "https://agentify.ad/cabinet/settings";

const config = () =>
  loadConfig({
    DATABASE_URL: "postgres://unused.example/unused",
    AUTH_SECRET: "a".repeat(44),
    REPORT_IDENTITY_SECRET,
    GATEWAY_CABINET_SECRET: SECRET,
    PAYMENT_NETWORK: "eip155:8453",
    FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
    REGISTRATION_INVITATION: "the-existing-gateway-invitation",
    PUBLIC_BASE_URL: "https://agentify.ad",
    BASE_PATH: "/cabinet",
  });

const aWalletChange: GatewayRequest = {
  operation: "announce",
  kind: "wallet_change",
  merchant_id: MERCHANT,
  from: FROM,
  to: TO,
  not_before: "2026-09-26T12:00:00.000Z",
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/**
 * The listener over the real component on its memory store, with accounts at
 * two merchants, and a mail provider that takes or refuses each address as the
 * test says.
 */
const listening = async (
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
  const server = buildGatewayApp(SECRET, tellerFor(settings, identity, postman)).listen(
    0,
    "127.0.0.1",
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}${PATH}`, sent };
};

const post = async (url: string, body: unknown, secret: string | null = SECRET) =>
  await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
    },
    body: JSON.stringify(body),
  });

describe("who may ask", () => {
  it("opens no listener for a cabinet that holds no gateway secret", () => {
    expect(startGatewayServer(null, async () => "handed_over")).toBeNull();
  });

  it.each([
    ["no secret", null],
    ["a wrong one", "a-wrong-gateway-cabinet-secret-nobody-holds"],
    ["the scanner's", REPORT_IDENTITY_SECRET],
  ])("refuses a request carrying %s, and tells nobody", async (_what, secret) => {
    const { url, sent } = await listening([["owner@example.com", MERCHANT]]);

    const refused = await post(url, aWalletChange, secret);

    expect(refused.status).toBe(401);
    expect(sent).toStrictEqual([]);
  });

  const { operation: _operation, ...withoutOperation } = aWalletChange;

  it.each([
    ["a request that is not an announcement", { ...aWalletChange, kind: "wallet_gone" }],
    ["a request that names no operation", withoutOperation],
  ])("refuses %s, and tells nobody", async (_what, body) => {
    const { url, sent } = await listening([["owner@example.com", MERCHANT]]);

    const refused = await post(url, body);

    expect(refused.status).toBe(400);
    expect(sent).toStrictEqual([]);
  });
});

describe("a wallet change", () => {
  it("is told to every account naming the merchant, and to nobody else", async () => {
    const { url, sent } = await listening([
      ["owner@example.com", MERCHANT],
      ["partner@example.com", MERCHANT],
      ["stranger@example.com", "mch_another_shop"],
    ]);

    const answered = await post(url, aWalletChange);

    expect(answered.status).toBe(200);
    expect(await answered.json()).toStrictEqual({ outcome: "handed_over" });
    expect(sent.map((message) => message.to).sort()).toStrictEqual([
      "owner@example.com",
      "partner@example.com",
    ]);
  });

  it("says what changes, not before when, that it was asked in the cabinet, and where it is decided, with no token", async () => {
    const { url, sent } = await listening([["owner@example.com", MERCHANT]]);

    await post(url, aWalletChange);

    const [message] = sent;
    for (const text of [message?.body ?? "", message?.html ?? ""]) {
      expect(text).toContain(FROM);
      expect(text).toContain(TO);
      expect(text).toContain("2026-09-26 12:00:00 UTC");
      // Only a cabinet's key changes a wallet, so where it was asked for is
      // the cabinet, and a person who did not ask knows a session did.
      expect(text).toMatch(/asked for in the cabinet/i);
      expect(text).toContain(THE_SETTINGS_SCREEN);
      expect(text).not.toMatch(/token/i);
    }
  });

  it("answers that there is nobody to tell where no account names the merchant", async () => {
    const { url, sent } = await listening([["stranger@example.com", "mch_another_shop"]]);

    const answered = await post(url, aWalletChange);

    expect(await answered.json()).toStrictEqual({ outcome: "nobody_to_tell" });
    expect(sent).toStrictEqual([]);
  });

  it("answers that a message was not handed over when the provider refused any one", async () => {
    const { url } = await listening(
      [
        ["owner@example.com", MERCHANT],
        ["partner@example.com", MERCHANT],
      ],
      new Set(["partner@example.com"]),
    );

    expect(await (await post(url, aWalletChange)).json()).toStrictEqual({
      outcome: "not_handed_over",
    });
  });
});

describe("a key's label, which somebody else may have written", () => {
  it("is refused by the listener when it is more than one line", async () => {
    const { url, sent } = await listening([["owner@example.com", MERCHANT]]);

    const refused = await post(url, {
      operation: "announce",
      kind: "key_issued",
      merchant_id: MERCHANT,
      key: { id: "mk_91c0", label: "the price desk" },
      asked_with: { kind: "merchant_code", id: "mk_7f3a", label: "one\ntwo" },
    });

    expect(refused.status).toBe(400);
    expect(sent).toStrictEqual([]);
  });

  it("is written into the message so that no mail client makes a link of it", async () => {
    // A leaked key can be used to issue a key named like an instruction with
    // an address in it. The message is Agentify's, so the label is shown as
    // data: in quotes, on one line, and with nothing in it a mail client
    // would turn into somewhere to click.
    const { url, sent } = await listening([["owner@example.com", MERCHANT]]);

    await post(url, {
      operation: "announce",
      kind: "key_issued",
      merchant_id: MERCHANT,
      key: {
        id: "mk_91c0",
        label: "confirm at https://agentify.example/login or www.evil.example",
      },
      asked_with: { kind: "cabinet" },
    } satisfies GatewayRequest);

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
    [
      "a first wallet",
      { operation: "announce", kind: "wallet_set", merchant_id: MERCHANT, to: TO },
    ],
    [
      "a cancelled change",
      {
        operation: "announce",
        kind: "wallet_change_cancelled",
        merchant_id: MERCHANT,
        kept: FROM,
        cancelled: TO,
      },
    ],
  ] as const)(
    "advises pausing selling at once after %s, not cancelling what is not waiting",
    async (_what, request) => {
      const { url, sent } = await listening([["owner@example.com", MERCHANT]]);

      await post(url, request satisfies GatewayRequest);

      const body = sent[0]?.body ?? "";
      expect(body).toMatch(/pause selling/i);
      expect(body).not.toMatch(/cancelling a waiting/i);
    },
  );

  it.each([
    ["a replacement", aWalletChange],
    [
      "a first wallet",
      { operation: "announce", kind: "wallet_set", merchant_id: MERCHANT, to: TO },
    ],
    [
      "a new key",
      {
        operation: "announce",
        kind: "key_issued",
        merchant_id: MERCHANT,
        key: { id: "mk_91c0", label: "the price desk" },
        asked_with: { kind: "cabinet" },
      },
    ],
  ] as const)("claims no person signed in for %s, only the cabinet", async (_what, request) => {
    const { url, sent } = await listening([["owner@example.com", MERCHANT]]);

    await post(url, request satisfies GatewayRequest);

    expect(sent[0]?.body ?? "").not.toMatch(/person signed in/i);
  });
});

describe("what is announced once it is done", () => {
  it("tells of a first wallet set, naming the address and where to replace it", async () => {
    // It applied at once, so the message is the owner's only word of it if
    // somebody else set it.
    const { url, sent } = await listening([["owner@example.com", MERCHANT]]);

    const answered = await post(url, {
      operation: "announce",
      kind: "wallet_set",
      merchant_id: MERCHANT,
      to: TO,
    } satisfies GatewayRequest);

    expect(await answered.json()).toStrictEqual({ outcome: "handed_over" });
    for (const text of [sent[0]?.body ?? "", sent[0]?.html ?? ""]) {
      expect(text).toContain(TO);
      expect(text).toMatch(/in the cabinet/i);
      expect(text).toContain(THE_SETTINGS_SCREEN);
    }
  });

  it("tells of a cancelled change, naming the address kept and the one cancelled", async () => {
    const { url, sent } = await listening([["owner@example.com", MERCHANT]]);

    const answered = await post(url, {
      operation: "announce",
      kind: "wallet_change_cancelled",
      merchant_id: MERCHANT,
      kept: FROM,
      cancelled: TO,
    } satisfies GatewayRequest);

    expect(await answered.json()).toStrictEqual({ outcome: "handed_over" });
    expect(sent[0]?.body).toContain(FROM);
    expect(sent[0]?.body).toContain(TO);
  });

  it("tells of a new key, naming it the way the list of keys does", async () => {
    const { url, sent } = await listening([["owner@example.com", MERCHANT]]);

    const answered = await post(url, {
      operation: "announce",
      kind: "key_issued",
      merchant_id: MERCHANT,
      key: { id: "mk_91c0", label: "the price desk" },
      asked_with: { kind: "cabinet" },
    } satisfies GatewayRequest);

    expect(await answered.json()).toStrictEqual({ outcome: "handed_over" });
    expect(sent[0]?.body).toContain("the price desk");
    expect(sent[0]?.body).toContain("mk_91c0");
  });
});
