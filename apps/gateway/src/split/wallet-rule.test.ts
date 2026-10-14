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

  it("refuses to judge something that is not an address", () => {
    expect(() => verdictOn("0xde3F8C4422A7F8C94bce9Cc2Ec118665108148E")).toThrowError(
      /not an address/,
    );
  });
});
