/**
 * The pre-release check of the commission wallets, run against answers Base
 * and Base Sepolia gave to the very requests it makes, recorded beside this
 * file. On Base a commission wallet that is not the product owner's Safe
 * takes every live split's commission somewhere nobody chose, for good, and
 * nothing offline can tell; this check is what tells, so a verdict it gets
 * wrong here is a release it would let through.
 */

import { readFileSync } from "node:fs";
import {
  PAYOUT_SPLIT_NETWORKS,
  type PayoutSplitNetwork,
  payoutSplitNetworkOf,
} from "@agentify/gateway";
import { createPublicClient, custom, decodeAbiParameters, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { commissionWalletVerdicts, ownersFrom, type Verdict } from "./commission-wallet.js";

interface Exchange {
  readonly method: string;
  readonly params: readonly unknown[];
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

const recorded = JSON.parse(
  readFileSync(new URL("./commission-wallet.rpc.json", import.meta.url), "utf8"),
) as {
  readonly addresses: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly answers: Readonly<Record<string, { readonly exchanges: readonly Exchange[] }>>;
};

const addressesOn = (network: string): Readonly<Record<string, string>> => {
  const found = recorded.addresses[network];
  if (found === undefined) throw new Error(`nothing was recorded on ${network}`);
  return found;
};

const named = (network: string, name: string): string => {
  const address = addressesOn(network)[name];
  if (address === undefined) throw new Error(`no ${name} was recorded on ${network}`);
  return address;
};

/** A value with every string in lower case and every object's keys in order. */
const normal = (value: unknown): unknown => {
  if (typeof value === "string") return value.toLowerCase();
  if (Array.isArray(value)) return value.map(normal);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, normal(inner)]),
    );
  }
  return value;
};

/** A client whose RPC answers exactly what this network's RPC answered, and nothing it was not asked. */
const answeringAs = (network: string): PublicClient => {
  const exchanges = recorded.answers[network]?.exchanges ?? [];
  return createPublicClient({
    transport: custom(
      {
        async request({ method, params }: { method: string; params?: unknown }) {
          const asked = JSON.stringify(normal(params ?? []));
          const found = exchanges.find(
            (exchange) =>
              exchange.method === method && JSON.stringify(normal(exchange.params)) === asked,
          );
          if (found === undefined) {
            throw new Error(`${network}'s RPC was never asked ${method} ${asked}`);
          }
          if (found.error !== undefined) {
            throw Object.assign(new Error(found.error.message), { code: found.error.code });
          }
          return found.result;
        },
      },
      { retryCount: 0 },
    ),
  });
};

const BASE = "eip155:8453";
const BASE_SEPOLIA = "eip155:84532";
const ETHEREUM = "eip155:1";
const ETHEREUM_SEPOLIA = "eip155:11155111";
const EVERY_CHAIN_READ = [BASE, BASE_SEPOLIA, ETHEREUM, ETHEREUM_SEPOLIA];

/** The code's Base Sepolia entry, with the commission wallet the answers were recorded for. */
const SEPOLIA_ENTRY: PayoutSplitNetwork = {
  ...payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, BASE_SEPOLIA),
  commissionWallet: named(BASE_SEPOLIA, "commission"),
};

/** A Base entry as the code would carry one, with this commission wallet. */
const baseWith = (commissionWallet: string, usdc = named(BASE, "usdc")): PayoutSplitNetwork => ({
  ...SEPOLIA_ENTRY,
  network: BASE,
  commissionWallet,
  usdc,
});

const SAFE_OWNERS = (() => {
  const answer = recorded.answers[BASE]?.exchanges.find(
    (exchange) =>
      exchange.method === "eth_call" &&
      JSON.stringify(normal(exchange.params)).includes(named(BASE, "safe").toLowerCase()) &&
      JSON.stringify(exchange.params).includes("0xa0e67e2b"),
  );
  const [owners] = decodeAbiParameters([{ type: "address[]" }], answer?.result as Hex);
  return owners;
})();

const checkOn = (
  network: string,
  entry: PayoutSplitNetwork | null,
  owners: readonly string[] | null = null,
  answeredBy = network,
): Promise<readonly Verdict[]> =>
  commissionWalletVerdicts({
    networks: [network],
    chainsRead: [network],
    table: entry === null ? {} : { [network]: entry },
    clientOf: () => answeringAs(answeredBy),
    owners: owners === null ? {} : { [network]: owners },
  });

const outcome = (verdicts: readonly Verdict[]) =>
  verdicts.map((verdict) => [verdict.check, verdict.passed]);

const CONTRACTS_PASS = [
  ["factory", true],
  ["implementation", true],
  ["warehouse", true],
  ["Multicall3", true],
  ["USDC", true],
];

describe("the pre-release check of the commission wallets", () => {
  it("passes Base Sepolia's chain, its commission wallet and its five contracts, and says the wallet is a plain one", async () => {
    const verdicts = await checkOn(BASE_SEPOLIA, SEPOLIA_ENTRY);

    expect(outcome(verdicts)).toStrictEqual([
      ["chain id", true],
      ["commission wallet", true],
      ...CONTRACTS_PASS,
    ]);
    expect(verdicts.find((verdict) => verdict.check === "commission wallet")?.saw).toMatch(
      /plain wallet/,
    );
  });

  it("passes the code's own table on both networks, Base's commission wallet a Safe with the product owner's one owner, and neither wallet a contract on any other chain read", async () => {
    const verdicts = await commissionWalletVerdicts({
      networks: [BASE, BASE_SEPOLIA],
      chainsRead: EVERY_CHAIN_READ,
      table: PAYOUT_SPLIT_NETWORKS,
      clientOf: (network) => answeringAs(network),
      // The product owner's hardware wallet, confirmed by him on 2026-10-15.
      owners: { [BASE]: ["0x36d44e40d127046B69E1163EF995Fe8C7b159Ca5"] },
    });

    expect(verdicts.map((v) => [v.network, v.check, v.passed])).toStrictEqual([
      [BASE, "chain id", true],
      [BASE, "commission wallet", true],
      [BASE, "Safe threshold", true],
      [BASE, "Safe owners", true],
      [BASE, `commission wallet on ${BASE_SEPOLIA}`, true],
      [BASE, `commission wallet on ${ETHEREUM}`, true],
      [BASE, `commission wallet on ${ETHEREUM_SEPOLIA}`, true],
      ...CONTRACTS_PASS.map(([check, passed]) => [BASE, check, passed]),
      [BASE_SEPOLIA, "chain id", true],
      [BASE_SEPOLIA, "commission wallet", true],
      [BASE_SEPOLIA, `commission wallet on ${BASE}`, true],
      [BASE_SEPOLIA, `commission wallet on ${ETHEREUM}`, true],
      [BASE_SEPOLIA, `commission wallet on ${ETHEREUM_SEPOLIA}`, true],
      ...CONTRACTS_PASS.map(([check, passed]) => [BASE_SEPOLIA, check, passed]),
    ]);
    const on = (network: string, check: string) =>
      verdicts.find((v) => v.network === network && v.check === check)?.saw;
    expect(on(BASE, "commission wallet")).toContain(named(BASE, "commissionSafe"));
    expect(on(BASE, "Safe threshold")).toMatch(/^1 /);
    expect(on(BASE_SEPOLIA, "commission wallet")).toMatch(/plain wallet/);
  });

  it("fails a test channel's plain wallet that is a contract on Ethereum Sepolia, naming that chain and what it found there", async () => {
    // The address first named as the test channel's commission wallet: Circle's
    // USDC on Ethereum Sepolia, with no code on Base Sepolia.
    const usdcThere = named(ETHEREUM_SEPOLIA, "ethereumSepoliaUsdc");

    const verdicts = await commissionWalletVerdicts({
      networks: [BASE_SEPOLIA],
      chainsRead: [BASE_SEPOLIA, ETHEREUM_SEPOLIA],
      table: { [BASE_SEPOLIA]: { ...SEPOLIA_ENTRY, commissionWallet: usdcThere } },
      clientOf: (network) => answeringAs(network),
      owners: {},
    });

    expect(outcome(verdicts)).toStrictEqual([
      ["chain id", true],
      ["commission wallet", true],
      [`commission wallet on ${ETHEREUM_SEPOLIA}`, false],
      ...CONTRACTS_PASS,
    ]);
    const there = verdicts.find((v) => v.check === `commission wallet on ${ETHEREUM_SEPOLIA}`);
    expect(there?.saw).toContain(ETHEREUM_SEPOLIA);
    expect(there?.saw).toMatch(/bytes of code/);
  });

  it("fails a commission contract on Base whose address holds code on another chain read, where it would be another contract", async () => {
    const verdicts = await commissionWalletVerdicts({
      networks: [BASE],
      chainsRead: [BASE, ETHEREUM_SEPOLIA],
      table: { [BASE]: baseWith(named(BASE, "safeSingleton")) },
      clientOf: (network) => answeringAs(network),
      owners: { [BASE]: SAFE_OWNERS },
    });

    expect(
      verdicts.find((v) => v.check === `commission wallet on ${ETHEREUM_SEPOLIA}`)?.passed,
    ).toBe(false);
  });

  it("takes no silence for an account on another chain, nor an answer from an RPC of the wrong chain", async () => {
    const wallet = named(BASE_SEPOLIA, "testChannelCommission");
    const run = (clientOf: (network: string) => PublicClient) =>
      commissionWalletVerdicts({
        networks: [BASE_SEPOLIA],
        chainsRead: [BASE_SEPOLIA, ETHEREUM],
        table: { [BASE_SEPOLIA]: { ...SEPOLIA_ENTRY, commissionWallet: wallet } },
        clientOf,
        owners: {},
      });
    const elsewhere = (verdicts: readonly Verdict[]) =>
      verdicts.find((v) => v.check === `commission wallet on ${ETHEREUM}`)?.passed;

    expect(elsewhere(await run((network) => answeringAs(network)))).toBe(true);
    expect(
      elsewhere(await run((network) => answeringAs(network === ETHEREUM ? BASE : network))),
    ).toBe(false);
    expect(
      elsewhere(
        await run((network) =>
          network === ETHEREUM ? answeringAs("eip155:0") : answeringAs(network),
        ),
      ),
    ).toBe(false);
  });

  it("fails a network the table names no payout split for, reading nothing", async () => {
    const verdicts = await commissionWalletVerdicts({
      networks: [BASE],
      chainsRead: [BASE, ETHEREUM],
      table: {},
      clientOf: (network) => answeringAs(network),
      owners: {},
    });

    expect(outcome(verdicts)).toStrictEqual([["the code table", false]]);
  });

  it("passes Base when its commission wallet is a Safe whose owners are exactly the ones named, in any order and spelling", async () => {
    const verdicts = await checkOn(
      BASE,
      baseWith(named(BASE, "safe")),
      [...SAFE_OWNERS].reverse().map((owner) => owner.toLowerCase()),
    );

    expect(outcome(verdicts)).toStrictEqual([
      ["chain id", true],
      ["commission wallet", true],
      ["Safe threshold", true],
      ["Safe owners", true],
      ...CONTRACTS_PASS,
    ]);
  });

  it("fails a Safe on Base with an owner the names leave out, naming that owner", async () => {
    const left = SAFE_OWNERS.at(-1) ?? "";

    const verdicts = await checkOn(BASE, baseWith(named(BASE, "safe")), SAFE_OWNERS.slice(0, -1));

    const owners = verdicts.find((verdict) => verdict.check === "Safe owners");
    expect(owners?.passed).toBe(false);
    expect(owners?.saw).toContain(left);
  });

  it("fails a Safe on Base whose owners the names add one to, naming the one that is no owner", async () => {
    const verdicts = await checkOn(BASE, baseWith(named(BASE, "safe")), [
      ...SAFE_OWNERS,
      named(BASE, "distributor"),
    ]);

    const owners = verdicts.find((verdict) => verdict.check === "Safe owners");
    expect(owners?.passed).toBe(false);
    expect(owners?.saw).toContain(named(BASE, "distributor"));
  });

  it("fails a Safe on Base when no owners are named to hold it to", async () => {
    const verdicts = await checkOn(BASE, baseWith(named(BASE, "safe")));

    expect(verdicts.find((verdict) => verdict.check === "Safe owners")?.passed).toBe(false);
  });

  it("holds a commission wallet with code on Base Sepolia to the same reads, and fails one whose owners cannot be read", async () => {
    const verdicts = await checkOn(BASE_SEPOLIA, {
      ...SEPOLIA_ENTRY,
      commissionWallet: named(BASE_SEPOLIA, "safeSingleton"),
    });

    expect(outcome(verdicts)).toStrictEqual([
      ["chain id", true],
      ["commission wallet", true],
      ["Safe threshold", true],
      ["Safe owners", false],
      ...CONTRACTS_PASS,
    ]);
  });

  it("fails a commission wallet on Base Sepolia the RPC does not answer for, where a plain wallet would pass", async () => {
    const verdicts = await checkOn(BASE_SEPOLIA, {
      ...SEPOLIA_ENTRY,
      commissionWallet: named(BASE, "safe"),
    });

    expect(verdicts.find((verdict) => verdict.check === "commission wallet")?.passed).toBe(false);
  });

  it("fails what the RPC does not answer, taking no silence for a plain wallet or for code", async () => {
    const unanswered = named(BASE_SEPOLIA, "commission");

    const verdicts = await checkOn(BASE, baseWith(unanswered, unanswered), SAFE_OWNERS);

    expect(outcome(verdicts)).toStrictEqual([
      ["chain id", true],
      ["commission wallet", false],
      ["factory", true],
      ["implementation", true],
      ["warehouse", true],
      ["Multicall3", true],
      ["USDC", false],
    ]);
  });

  it("fails a plain wallet on Base, where one lost key would lose every commission", async () => {
    const verdicts = await checkOn(BASE, baseWith(named(BASE, "distributor")), SAFE_OWNERS);

    expect(outcome(verdicts)).toStrictEqual([
      ["chain id", true],
      ["commission wallet", false],
      ...CONTRACTS_PASS,
    ]);
  });

  it("fails a Safe on Base whose owners cannot be read", async () => {
    const verdicts = await checkOn(BASE, baseWith(named(BASE, "safeSingleton")), SAFE_OWNERS);

    expect(outcome(verdicts)).toStrictEqual([
      ["chain id", true],
      ["commission wallet", true],
      ["Safe threshold", true],
      ["Safe owners", false],
      ...CONTRACTS_PASS,
    ]);
  });

  it("fails a contract on Base that answers neither getThreshold nor getOwners, which is no Safe", async () => {
    const verdicts = await checkOn(BASE, baseWith(named(BASE, "feeDisburser")), SAFE_OWNERS);

    expect(outcome(verdicts)).toStrictEqual([
      ["chain id", true],
      ["commission wallet", true],
      ["Safe threshold", false],
      ["Safe owners", false],
      ...CONTRACTS_PASS,
    ]);
  });

  it("reads nothing more from an RPC that answers another chain", async () => {
    const verdicts = await checkOn(BASE, baseWith(named(BASE, "safe")), SAFE_OWNERS, BASE_SEPOLIA);

    expect(outcome(verdicts)).toStrictEqual([["chain id", false]]);
  });

  it("fails a contract the code names where the chain holds no code", async () => {
    const verdicts = await checkOn(
      BASE,
      baseWith(named(BASE, "safe"), named(BASE, "baseSepoliaUsdc")),
      SAFE_OWNERS,
    );

    expect(verdicts.find((verdict) => verdict.check === "USDC")?.passed).toBe(false);
    expect(verdicts.filter((verdict) => !verdict.passed)).toHaveLength(1);
  });
});

describe("the owners the Base Safe is held to", () => {
  it("are read from a list of addresses, in either spelling", () => {
    const [first, second] = SAFE_OWNERS;
    expect(ownersFrom(`${first?.toLowerCase()}, ${second}`)).toStrictEqual([first, second]);
    expect(ownersFrom(undefined)).toBeNull();
  });

  it("refuses a list with anything but an address in it", () => {
    expect(() => ownersFrom(`${SAFE_OWNERS[0]},0x1234`)).toThrow(/COMMISSION_SAFE_OWNERS/);
  });
});
