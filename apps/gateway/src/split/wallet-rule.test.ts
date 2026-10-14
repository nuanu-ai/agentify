/**
 * The merchant's share goes, immutably, to whatever wallet is saved. An address
 * that is a contract of the payout, a token, a split or Agentify's own wallet
 * takes that share from them for good, so each is named for what it is.
 */

import { checksummedAddressOf } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import { SPLIT_NETWORKS_WITH_A_FIXTURE_BASE } from "../testing/split-networks.js";
import { COMMISSION, IMPLEMENTATION, MERCHANT, ON_CHAIN, S, S2 } from "./fixture.js";
import { payoutSplitNetworkOf } from "./networks.js";
import { whyNotAPayoutWallet } from "./wallet-rule.js";

const NETWORKS = SPLIT_NETWORKS_WITH_A_FIXTURE_BASE;
const KNOWN_SPLITS = [S.address, S2.address];

const verdictOn = (address: string) =>
  whyNotAPayoutWallet(address, { networks: NETWORKS, splits: KNOWN_SPLITS });

/** Both spellings a person may paste: lower case, and the checksummed one. */
const spellingsOf = (address: string): readonly string[] => [
  address.toLowerCase(),
  checksummedAddressOf(address.toLowerCase()),
];

describe("a wallet the merchant's share could not come back from", () => {
  const live = payoutSplitNetworkOf(NETWORKS, "eip155:8453");

  it.each([
    ["the zero address", "0x0000000000000000000000000000000000000000", "zero_address"],
    ["the test chain's commission wallet", COMMISSION, "commission_wallet"],
    ["the live chain's commission wallet", live.commissionWallet, "commission_wallet"],
    ["the factory the splits are made by", ON_CHAIN.factory, "split_factory"],
    ["the implementation every split runs", IMPLEMENTATION, "split_implementation"],
    ["the warehouse shares wait in", ON_CHAIN.warehouse, "split_warehouse"],
    // It runs anyone's calls as itself, so a share withdrawn to it goes to
    // whoever calls it next.
    ["Multicall3", "0xcA11bde05977b3631167028862bE2a173976CA11", "multicall3"],
    ["USDC on Base Sepolia", ON_CHAIN.usdc, "usdc"],
    ["USDC on Base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "usdc"],
    ["a split buyers pay into", S2.address, "payout_split"],
  ])("is refused as what it is when it is %s", (_, address, verdict) => {
    for (const spelling of spellingsOf(address)) {
      expect(verdictOn(spelling), spelling).toBe(verdict);
    }
  });

  it("lets a wallet that is none of these through", () => {
    for (const wallet of [
      MERCHANT,
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    ]) {
      for (const spelling of spellingsOf(wallet)) {
        expect(verdictOn(spelling), spelling).toBeNull();
      }
    }
  });

  it("refuses the contracts of every network, where networks do not share them", () => {
    // The EIP-55 specification's example addresses, standing in for another
    // chain's deployment of the payout contracts.
    const elsewhere = {
      ...live,
      factory: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      implementation: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      warehouse: "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
      multicall3: "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
    };
    const apart = {
      "eip155:84532": payoutSplitNetworkOf(NETWORKS, "eip155:84532"),
      "eip155:8453": elsewhere,
    };
    const verdict = (address: string) =>
      whyNotAPayoutWallet(address, { networks: apart, splits: [] });

    expect([ON_CHAIN.factory, elsewhere.factory].map(verdict)).toStrictEqual([
      "split_factory",
      "split_factory",
    ]);
    expect([IMPLEMENTATION, elsewhere.implementation].map(verdict)).toStrictEqual([
      "split_implementation",
      "split_implementation",
    ]);
    expect([ON_CHAIN.warehouse, elsewhere.warehouse].map(verdict)).toStrictEqual([
      "split_warehouse",
      "split_warehouse",
    ]);
    expect(
      ["0xcA11bde05977b3631167028862bE2a173976CA11", elsewhere.multicall3].map(verdict),
    ).toStrictEqual(["multicall3", "multicall3"]);
  });

  it("refuses to judge something that is not an address", () => {
    expect(() => verdictOn("0xde3F8C4422A7F8C94bce9Cc2Ec118665108148E")).toThrowError(
      /not an address/,
    );
  });
});
