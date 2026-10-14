/**
 * Every value in this table enters every split's address or every payout's
 * calls, and a split is immutable, so a value that drifts moves every
 * merchant's money for good. The contracts are compared with the addresses the
 * experiment's transactions called on Base Sepolia rather than with a copy
 * typed here, on every network, since 0xSplits sits at the same addresses on
 * Base; and a network the table does not describe is refused rather than given
 * another network's values.
 */

import { checksummedAddressOf } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import { loadConfig, SANDBOX_FACILITATOR } from "../config.js";
import { PaymentEdge } from "../http/x402.js";
import { SPLIT_NETWORKS_WITH_A_FIXTURE_BASE } from "../testing/split-networks.js";
import { IMPLEMENTATION, inputOf, ON_CHAIN } from "./fixture.js";
import {
  PAYOUT_SPLIT_NETWORKS,
  type PayoutSplitNetwork,
  type PayoutSplitNetworks,
  payoutSplitNetworkOf,
} from "./networks.js";

const DATABASE_URL = "postgres://agentify@localhost:5432/agentify";

/** What a live chain needs besides the table before `loadConfig` takes it. */
const LIVE = {
  DATABASE_URL,
  PAYMENT_NETWORK: "eip155:8453",
  FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
  CDP_API_KEY_ID: "key-id",
  CDP_API_KEY_SECRET: "key-secret",
};

const entriesOf = (table: PayoutSplitNetworks): readonly PayoutSplitNetwork[] =>
  Object.values(table);

const addressesOf = (entry: PayoutSplitNetwork): readonly string[] => [
  entry.commissionWallet,
  entry.factory,
  entry.implementation,
  entry.warehouse,
  entry.multicall3,
  entry.usdc,
];

const TEST_CHANNEL = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532");

/**
 * Every entry a gateway runs on: the code's own, and the Base entry that tests
 * starting a live gateway put in place of the code's.
 */
const EVERY_ENTRY: readonly PayoutSplitNetwork[] = [
  ...entriesOf(PAYOUT_SPLIT_NETWORKS),
  payoutSplitNetworkOf(SPLIT_NETWORKS_WITH_A_FIXTURE_BASE, "eip155:8453"),
];

/** The token a gateway on this network asks a buyer for, as its payment library names it. */
const tokenOn = (network: string): string => {
  const config =
    network === "eip155:8453"
      ? loadConfig(LIVE, SPLIT_NETWORKS_WITH_A_FIXTURE_BASE)
      : loadConfig({ DATABASE_URL, PAYMENT_NETWORK: network });
  return new PaymentEdge(config.payment, config.publicBaseUrl, 300).token().asset;
};

describe("the payout split table in the code", () => {
  it("names on every network the contracts the experiment called and the token payments there are asked in", () => {
    for (const entry of EVERY_ENTRY) {
      expect(entry.factory.toLowerCase(), entry.network).toBe(ON_CHAIN.factory);
      expect(entry.implementation, entry.network).toBe(IMPLEMENTATION);
      expect(entry.warehouse.toLowerCase(), entry.network).toBe(ON_CHAIN.warehouse);
      // The experiment never called Multicall3, which sits at one address on
      // every chain it is deployed to; the payout tests hold that address.
      expect(entry.multicall3, entry.network).toBe(TEST_CHANNEL.multicall3);
      expect(entry.usdc, entry.network).toBe(tokenOn(entry.network));
    }
    expect(TEST_CHANNEL.usdc.toLowerCase()).toBe(ON_CHAIN.usdc);
    // The token word of every distribute: selector, the tuple's offset, then the token.
    expect(`0x${inputOf("distribute").slice(2 + 8 + 64 + 24, 2 + 8 + 128)}`).toBe(ON_CHAIN.usdc);
  });

  it("writes every address in the checksummed spelling, whose capitals catch a mistyped character", () => {
    for (const table of [PAYOUT_SPLIT_NETWORKS, SPLIT_NETWORKS_WITH_A_FIXTURE_BASE]) {
      for (const entry of entriesOf(table)) {
        for (const address of addressesOf(entry)) {
          expect(checksummedAddressOf(address.toLowerCase()), `${entry.network} ${address}`).toBe(
            address,
          );
        }
      }
    }
  });

  it("takes a commission of 1000 of every 1000000 on every network", () => {
    for (const entry of entriesOf(PAYOUT_SPLIT_NETWORKS)) {
      expect([entry.commissionAllocation, entry.totalAllocation], entry.network).toStrictEqual([
        1_000, 1_000_000,
      ]);
    }
  });

  it("keeps every commission wallet apart from every contract and from every other network's", () => {
    for (const table of [PAYOUT_SPLIT_NETWORKS, SPLIT_NETWORKS_WITH_A_FIXTURE_BASE]) {
      const entries = entriesOf(table);
      const contracts = new Set(
        entries.flatMap((entry) =>
          addressesOf(entry)
            .slice(1)
            .map((a) => a.toLowerCase()),
        ),
      );
      const wallets = entries.map((entry) => entry.commissionWallet.toLowerCase());
      expect(new Set(wallets).size, "two networks share a commission wallet").toBe(wallets.length);
      for (const wallet of wallets) {
        expect(wallet).not.toBe("0x0000000000000000000000000000000000000000");
        expect(contracts.has(wallet), wallet).toBe(false);
      }
    }
  });

  it("files every entry under the network it describes", () => {
    for (const table of [PAYOUT_SPLIT_NETWORKS, SPLIT_NETWORKS_WITH_A_FIXTURE_BASE]) {
      for (const [network, entry] of Object.entries(table)) {
        expect(entry.network).toBe(network);
      }
    }
  });

  it("refuses a network it names no commission wallet for, rather than lending it another's", () => {
    for (const network of [
      "eip155:8453",
      "eip155:11155111",
      "eip155:80002",
      "eip155:1",
      "constructor",
      "__proto__",
    ]) {
      expect(() => payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, network), network).toThrowError(
        new RegExp(`${network}.*commission wallet`, "s"),
      );
    }
  });
});

describe("the table a gateway runs on", () => {
  it("is the code's own wherever a gateway is configured from its environment alone", () => {
    const config = loadConfig({ DATABASE_URL });
    expect(config.payoutSplitNetworks).toBe(PAYOUT_SPLIT_NETWORKS);
    expect(config.payoutSplit).toBe(TEST_CHANNEL);
  });

  it("is Base Sepolia's in the sandbox, which describes Base Sepolia", () => {
    expect(loadConfig({ DATABASE_URL, FACILITATOR_URL: SANDBOX_FACILITATOR }).payoutSplit).toBe(
      TEST_CHANNEL,
    );
  });

  it("is the one handed in beside the environment, for this network", () => {
    const config = loadConfig(LIVE, SPLIT_NETWORKS_WITH_A_FIXTURE_BASE);
    expect(config.payoutSplitNetworks).toBe(SPLIT_NETWORKS_WITH_A_FIXTURE_BASE);
    expect(config.payoutSplit).toBe(
      payoutSplitNetworkOf(SPLIT_NETWORKS_WITH_A_FIXTURE_BASE, "eip155:8453"),
    );
  });
});
