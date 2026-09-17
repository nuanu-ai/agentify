import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CabinetIdentity } from "./cabinet-entry.js";
import { loadConfig } from "./config.js";
import { identityFor } from "./identity.js";
import type { Message } from "./mail.js";

const config = loadConfig({
  DATABASE_URL: "postgres://nobody@nowhere:5432/unused",
  AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
  PAYMENT_NETWORK: "eip155:84532",
  FACILITATOR_URL: "sandbox:scripted",
});

function memoryIdentity(handed: "accepted" | "refused" = "accepted") {
  const rows: Record<string, Record<string, unknown>[]> = {
    cabinet_accounts: [],
    cabinet_sessions: [],
    cabinet_credentials: [],
    cabinet_verifications: [],
    cabinet_link_sends: [],
  };
  const messages: Message[] = [];
  const store = identityFor(config, {
    rows,
    postman: async (message) => {
      messages.push(message);
      return handed;
    },
  });
  return { identity: store as unknown as CabinetIdentity, messages, rows, store };
}

function tokenIn(message: Message): string {
  const found = /https?:\/\/\S+\/sign-in\/open\?token=([^\s]+)/.exec(message.body)?.[1];
  if (found === undefined) throw new Error("the cabinet link was not in the message");
  return decodeURIComponent(found);
}

describe("cabinet magic links", () => {
  it("keeps two links independent and creates a person only when each is opened", async () => {
    const { identity, messages, rows } = memoryIdentity();

    await expect(identity.requestLink(" Person@Example.com ", "default")).resolves.toStrictEqual({
      status: "accepted",
    });
    await expect(identity.requestLink("person@example.com", "settings")).resolves.toStrictEqual({
      status: "accepted",
    });

    expect(rows.cabinet_accounts).toHaveLength(0);
    expect(rows.cabinet_sessions).toHaveLength(0);
    expect(messages).toHaveLength(2);
    const firstToken = tokenIn(messages[0] as Message);
    const secondToken = tokenIn(messages[1] as Message);
    expect(firstToken).not.toBe(secondToken);
    expect(rows.cabinet_verifications?.map((row) => row.identifier)).toStrictEqual([
      createHash("sha256").update(firstToken).digest("base64url"),
      createHash("sha256").update(secondToken).digest("base64url"),
    ]);

    const first = await identity.openLink(firstToken);
    expect(first).toMatchObject({
      status: "opened",
      destination: "default",
      person: { email: "person@example.com", confirmed: true, merchant: null },
    });
    expect(rows.cabinet_accounts).toHaveLength(1);
    expect(rows.cabinet_sessions).toHaveLength(1);

    await expect(identity.openLink(firstToken)).resolves.toStrictEqual({ status: "refused" });

    const second = await identity.openLink(secondToken);
    expect(second).toMatchObject({
      status: "opened",
      destination: "settings",
      person: { id: first.status === "opened" ? first.person.id : "wrong person" },
    });
    expect(rows.cabinet_accounts).toHaveLength(1);
    expect(rows.cabinet_sessions).toHaveLength(2);
  });

  it("refuses a report-purpose token at the cabinet door without consuming it", async () => {
    const { identity, messages, rows } = memoryIdentity();
    await identity.requestLink("person@example.com", "default");
    const token = tokenIn(messages[0] as Message);
    const verification = rows.cabinet_verifications?.[0];
    if (verification === undefined) throw new Error("the link was not stored");
    verification.value = JSON.stringify({
      email: "person@example.com",
      purpose: "report",
      intentKind: "registration",
      state: "the-scanner-state",
    });

    await expect(identity.openLink(token)).resolves.toStrictEqual({ status: "refused" });
    expect(rows.cabinet_verifications).toHaveLength(1);
    expect(rows.cabinet_accounts).toHaveLength(0);
    expect(rows.cabinet_sessions).toHaveLength(0);
  });

  it("keeps no token or rate event when the mail provider refuses the message", async () => {
    const { identity, rows } = memoryIdentity("refused");

    await expect(identity.requestLink("person@example.com", "default")).resolves.toStrictEqual({
      status: "unavailable",
    });
    expect(rows.cabinet_verifications).toHaveLength(0);
    expect(rows.cabinet_link_sends).toHaveLength(0);
    expect(rows.cabinet_accounts).toHaveLength(0);
  });
});
