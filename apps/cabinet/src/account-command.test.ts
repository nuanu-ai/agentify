import { describe, expect, it } from "vitest";
import { type CabinetKeyCheck, runAccount } from "./account-command.js";
import { loadConfig } from "./config.js";
import { type Identity, identityFor } from "./identity.js";
import type { Message } from "./mail.js";
import { rewindLinkSends } from "./testing/link-sends.js";

const KEY = "the-merchants-own-key-long-enough";
const MERCHANT = "mer_the_merchant";
const NOON = new Date("2026-09-17T12:00:00.000Z");

const config = loadConfig({
  DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
  AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
  PAYMENT_NETWORK: "eip155:84532",
  FACILITATOR_URL: "sandbox:scripted",
  REGISTRATION_INVITATION: "the-existing-gateway-invitation",
});

function store() {
  const rows: Record<string, Record<string, unknown>[]> = {
    cabinet_accounts: [],
    cabinet_sessions: [],
    cabinet_credentials: [],
    cabinet_verifications: [],
    cabinet_link_sends: [],
  };
  const messages: Message[] = [];
  return {
    identity: identityFor(config, {
      rows,
      postman: async (message) => {
        messages.push(message);
        return "accepted";
      },
    }),
    messages,
    rows,
  };
}

type Run = Readonly<{ code: number; said: string }>;

async function running(
  identity: Identity,
  argv: readonly string[],
  readKey: () => Promise<string> = async () => KEY,
  ask: CabinetKeyCheck = async () => ({
    ok: true,
    document: "a-fresh-cabinet-key-the-command-does-not-keep",
  }),
): Promise<Run> {
  const lines: string[] = [];
  const code = await runAccount(
    argv,
    identity,
    { say: (line) => lines.push(line), readKey, now: () => NOON },
    ask,
  );
  return { code, said: lines.join("\n") };
}

describe("the passwordless account command", () => {
  it("seeds an unconfirmed P2 without a password or session", async () => {
    const { identity, rows } = store();

    const made = await running(identity, ["add", " Person@Example.com ", MERCHANT]);

    expect(made.code).toBe(0);
    expect(made.said).toContain("unconfirmed account for person@example.com");
    expect(made.said).toMatch(/one-time link/i);
    expect(made.said).not.toContain(KEY);
    expect(await identity.byEmail("person@example.com")).toStrictEqual({
      id: expect.any(String),
      email: "person@example.com",
      confirmed: false,
      merchant: { id: MERCHANT, key: KEY },
    });
    expect(rows.cabinet_credentials).toHaveLength(0);
    expect(rows.cabinet_sessions).toHaveLength(0);
  });

  it("trims the piped key before checking and storing it", async () => {
    const { identity } = store();
    const checked: string[] = [];
    const result = await running(
      identity,
      ["add", "person@example.com", MERCHANT],
      async () => `  ${KEY}\n`,
      async (key) => {
        checked.push(key);
        return { ok: true, document: "unused-fresh-key" };
      },
    );

    expect(result.code).toBe(0);
    expect(checked).toStrictEqual([KEY]);
    expect((await identity.byEmail("person@example.com"))?.merchant?.key).toBe(KEY);
  });

  it("does not overwrite an existing person or merchant", async () => {
    const { identity } = store();
    await running(identity, ["add", "person@example.com", MERCHANT]);

    const repeated = await running(identity, ["add", "person@example.com", "mer_somebody_else"]);

    expect(repeated.code).not.toBe(0);
    expect(repeated.said).toMatch(/already.*nothing was changed/i);
    expect((await identity.byEmail("person@example.com"))?.merchant?.id).toBe(MERCHANT);
  });

  it("refuses missing, short and wrong-kind keys without printing them", async () => {
    for (const scenario of [
      {
        key: "",
        answer: async () => ({ ok: true, document: "unused" }) as const,
        words: /standard input/i,
      },
      {
        key: "too-short",
        answer: async () => ({ ok: true, document: "unused" }) as const,
        words: /16 characters/i,
      },
      {
        key: KEY,
        answer: async () => ({ ok: false, status: 403, why: "wrong kind" }) as const,
        words: /own code/i,
      },
    ]) {
      const { identity } = store();
      const tried = await running(
        identity,
        ["add", "person@example.com", MERCHANT],
        async () => scenario.key,
        scenario.answer,
      );
      expect(tried.code).not.toBe(0);
      expect(tried.said).toMatch(scenario.words);
      expect(tried.said).not.toContain(KEY);
      await expect(identity.byEmail("person@example.com")).resolves.toBeNull();
    }
  });

  it("writes nothing when the gateway cannot answer", async () => {
    const { identity } = store();
    const tried = await running(
      identity,
      ["add", "person@example.com", MERCHANT],
      async () => KEY,
      async () => ({ ok: false, status: 0, why: "the gateway could not be reached" }),
    );

    expect(tried.code).not.toBe(0);
    expect(tried.said).toMatch(/gateway did not answer/i);
    await expect(identity.byEmail("person@example.com")).resolves.toBeNull();
  });

  it("validates address and merchant before asking the gateway", async () => {
    const { identity } = store();
    let asked = 0;
    const ask: CabinetKeyCheck = async () => {
      asked += 1;
      return { ok: true, document: "unused" };
    };
    for (const args of [
      ["add", "not-an-address", MERCHANT],
      ["add", "person@example.com"],
      ["add", "person@example.com", "merchant with spaces"],
    ]) {
      expect((await running(identity, args, async () => KEY, ask)).code).not.toBe(0);
    }
    expect(asked).toBe(0);
  });

  it("lists confirmation, merchant and live session count without the key", async () => {
    const { identity, messages } = store();
    await identity.make("person@example.com", { id: MERCHANT, key: KEY });
    await identity.requestLink("person@example.com", "default");
    const token = new URL(
      messages[0]?.body.match(/https?:\/\/\S+/)?.[0] ?? "wrong:",
    ).searchParams.get("token");
    if (token === null) throw new Error("the link was not mailed");
    await identity.openLink(token);

    const listed = await running(identity, ["list"]);

    expect(listed.code).toBe(0);
    expect(listed.said).toContain("person@example.com");
    expect(listed.said).toContain("1 session open");
    expect(listed.said).toContain("address confirmed");
    expect(listed.said).toContain(MERCHANT);
    expect(listed.said).not.toContain(KEY);
  });

  it("revokes every session while retaining the person and merchant", async () => {
    const { identity, messages, rows } = store();
    await identity.make("person@example.com", { id: MERCHANT, key: KEY });
    for (let index = 0; index < 2; index += 1) {
      // Two sessions means two links, and the door keeps a minute between
      // them; this test is about what revoking does, not about that minute.
      rewindLinkSends(rows);
      await identity.requestLink("person@example.com", "default");
      const token = new URL(
        messages[index]?.body.match(/https?:\/\/\S+/)?.[0] ?? "wrong:",
      ).searchParams.get("token");
      if (token === null) throw new Error("the link was not mailed");
      await identity.openLink(token);
    }

    const revoked = await running(identity, ["revoke", "person@example.com"]);

    expect(revoked.code).toBe(0);
    expect(revoked.said).toContain("Ended 2 sessions");
    expect((await identity.byEmail("person@example.com"))?.merchant?.id).toBe(MERCHANT);
  });

  it("renders control characters from restored addresses harmlessly", async () => {
    const { identity, rows } = store();
    rows.cabinet_accounts?.push({
      id: "person_unsafe",
      email: "hidden\u001b[2J@example.com",
      emailVerified: false,
      name: "",
      createdAt: NOON,
      updatedAt: NOON,
      merchantId: MERCHANT,
      merchantKey: KEY,
    });

    const listed = await running(identity, ["list"]);

    expect(listed.said).not.toContain("\u001b");
    expect(listed.said).toContain("\\x1b");
  });
});
