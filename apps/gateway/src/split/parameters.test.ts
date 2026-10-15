/**
 * A split is immutable once anybody creates it, so the rule that makes one is
 * what every merchant was told: their wallet first at 99.9%, the network's
 * commission wallet second at 0.1%, nobody who can change it and nobody who
 * takes a cut for paying it out.
 */

import { describe, expect, it } from "vitest";
import { COMMISSION, handEncoded, IMPLEMENTATION, MERCHANT, ON_CHAIN } from "./fixture.js";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "./networks.js";
import { payoutSplitFor } from "./parameters.js";

/**
 * The code's own Base Sepolia entry, with the experiment's commission wallet
 * standing in for whichever the code names, so the golden addresses exercise
 * the shipped factory, implementation and rate.
 */
const TEST_CHANNEL = {
  ...payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532"),
  commissionWallet: COMMISSION,
};

const LIVE_CHANNEL = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:8453");

const goldenSplit = (network: string, merchantId: string, commissionWallet: string) => {
  const found = handEncoded.splits.find(
    (split) =>
      split.network === network &&
      split.merchantId === merchantId &&
      split.commissionWallet === commissionWallet,
  );
  if (found === undefined) throw new Error(`no hand-encoded split on ${network} for ${merchantId}`);
  return found;
};

const MERCHANT_ID = handEncoded.payouts.merchant.merchantId;

describe("a merchant's payout split", () => {
  it("pays their wallet first at 999000 of a million and the commission wallet second at 1000, with no owner and no incentive", () => {
    const golden = goldenSplit("eip155:84532", MERCHANT_ID, COMMISSION);
    const salt = handEncoded.salts.find(
      (vector) => vector.network === "eip155:84532" && vector.merchantId === MERCHANT_ID,
    )?.salt;

    expect(payoutSplitFor(TEST_CHANNEL, MERCHANT_ID, MERCHANT)).toStrictEqual({
      address: golden.address,
      network: "eip155:84532",
      merchantId: MERCHANT_ID,
      merchantWallet: MERCHANT,
      commissionWallet: COMMISSION,
      merchantAllocation: 999_000,
      commissionAllocation: 1_000,
      totalAllocation: 1_000_000,
      distributionIncentive: 0,
      owner: "0x0000000000000000000000000000000000000000",
      salt,
      factory: TEST_CHANNEL.factory,
    });
    expect(TEST_CHANNEL.factory.toLowerCase()).toBe(ON_CHAIN.factory);
    expect(TEST_CHANNEL.implementation).toBe(IMPLEMENTATION);
  });

  it("names on the live chain that chain's own commission wallet and salt", () => {
    const golden = goldenSplit("eip155:8453", MERCHANT_ID, LIVE_CHANNEL.commissionWallet);
    const split = payoutSplitFor(LIVE_CHANNEL, MERCHANT_ID, MERCHANT);

    expect(split.address).toBe(golden.address);
    expect(split.commissionWallet).toBe(LIVE_CHANNEL.commissionWallet);
    expect(split.commissionWallet).not.toBe(COMMISSION);
  });

  it("gives another merchant with the same wallet a split of their own", () => {
    const other = "mch_ffffffffffffffffffffffffffffffff";
    expect(payoutSplitFor(TEST_CHANNEL, other, MERCHANT).address).toBe(
      goldenSplit("eip155:84532", other, COMMISSION).address,
    );
  });

  it("writes the wallet in its checksummed spelling whichever spelling it was given", () => {
    const split = payoutSplitFor(TEST_CHANNEL, MERCHANT_ID, MERCHANT.toLowerCase());
    expect(split.merchantWallet).toBe(MERCHANT);
    expect(split.address).toBe(payoutSplitFor(TEST_CHANNEL, MERCHANT_ID, MERCHANT).address);
  });

  it("refuses a wallet whose capitals disagree with it, which is another wallet's address", () => {
    expect(() =>
      payoutSplitFor(TEST_CHANNEL, MERCHANT_ID, MERCHANT.replace("3F8C", "3f8C")),
    ).toThrowError(/not an address/);
  });

  it("refuses a wallet that is the commission wallet itself, or nobody's", () => {
    expect(() => payoutSplitFor(TEST_CHANNEL, MERCHANT_ID, COMMISSION.toLowerCase())).toThrowError(
      /twice/,
    );
    expect(() =>
      payoutSplitFor(TEST_CHANNEL, MERCHANT_ID, "0x0000000000000000000000000000000000000000"),
    ).toThrowError(/zero address/);
  });
});

describe("the split a merchant and a wallet give", () => {
  const merchants = [MERCHANT_ID, "mch_ffffffffffffffffffffffffffffffff", "mch_1", "the_merchant"];
  const wallets = [
    MERCHANT,
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  ];
  const channels = [TEST_CHANNEL, LIVE_CHANNEL];

  it("is the same split every time they come back to it, and another for any change", () => {
    const seen = new Map<string, string>();
    for (const channel of channels) {
      for (const merchantId of merchants) {
        for (const wallet of wallets) {
          const key = `${channel.network} ${merchantId} ${wallet}`;
          const first = payoutSplitFor(channel, merchantId, wallet);
          expect(payoutSplitFor(channel, merchantId, wallet.toLowerCase()), key).toStrictEqual(
            first,
          );
          const earlier = seen.get(first.address);
          expect(earlier, `${key} gives the split of ${earlier}`).toBeUndefined();
          seen.set(first.address, key);
        }
      }
    }
    expect(seen.size).toBe(channels.length * merchants.length * wallets.length);
  });
});
