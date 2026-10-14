/**
 * The application hands the dashboard's teller the rate the gateway records
 * splits with, so a message about a wallet names the shares every split it
 * names pays. The entry point is imported whole with its outer edges cut: the
 * gateway's start keeps the teller it is handed and starts nothing, the
 * dashboard's pages are not read off a build, and the accounts a message goes
 * to come from no database. What is checked is the message itself, as the
 * log postman writes it.
 */

import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "@agentify/gateway";
import type { Announcement, AnnouncementAnswer } from "@agentify/gateway/announcements";
import { afterEach, describe, expect, it, vi } from "vitest";

type Tell = (announcement: Announcement) => Promise<AnnouncementAnswer["outcome"]>;

const held = vi.hoisted(() => ({ tell: null as Tell | null }));

vi.mock("@agentify/gateway/start", () => ({
  startGateway: async (_config: unknown, { announce }: { announce: Tell }) => {
    held.tell = announce;
    throw new Error("this test starts no gateway");
  },
}));

vi.mock("@agentify/dashboard/start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agentify/dashboard/start")>()),
  builtPages: async () => ({}),
}));

vi.mock("../../dashboard/src/identity.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  identityFor: () => ({ emailsNaming: async () => ["owner@example.com"] }),
}));

/** The test channel, with its database on a loopback port nothing listens on. */
const TEST_CHANNEL = {
  DATABASE_URL: "postgres://agentify@127.0.0.1:9/agentify",
  AUTH_SECRET: "a".repeat(44),
  PAYMENT_NETWORK: "eip155:84532",
  FACILITATOR_URL: "https://x402.org/facilitator",
  PUBLIC_BASE_URL: "https://agentify.ad",
  BASE_PATH: "/dashboard",
};

const WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const SPLIT = "0x8EEaEAa722ED3088386c9b7EBadBD5Fe852f7eA4";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("the application's messages about a wallet", () => {
  it("name the shares of the payout split the gateway records on its network", async () => {
    for (const [name, value] of Object.entries(TEST_CHANNEL)) vi.stubEnv(name, value);
    // The entry point exits where its start fails, as it does here by design.
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...line: unknown[]) => {
      logged.push(line.join(" "));
    });

    await import("./main.js").catch(() => undefined);
    await held.tell?.({
      kind: "wallet_set",
      merchant_id: "mch_the_shop",
      to: WALLET,
      to_split: SPLIT,
      asked_with: { kind: "signed_in", email: "owner@example.com" },
    });

    const network = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, TEST_CHANNEL.PAYMENT_NETWORK);
    const percent = (part: number): string => `${(part / network.totalAllocation) * 100}%`;
    expect(held.tell).not.toBeNull();
    expect(logged.join("\n")).toContain(
      `It pays only this wallet, ${percent(network.totalAllocation - network.commissionAllocation)} of every sale, and Agentify, ${percent(network.commissionAllocation)}.`,
    );
  });
});
