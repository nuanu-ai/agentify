/**
 * A buyer pays the address this computes, long before anybody creates the
 * split there. If the formula is wrong, no contract with our parameters can
 * ever exist at that address and nobody can pay out what lands on it, so every
 * golden value here is one the chain gave or one laid out by hand.
 */

import { describe, expect, it } from "vitest";
import {
  cloneInitCode,
  payoutSplitSalt,
  type SplitDeployment,
  type SplitParameters,
  splitAddress,
} from "./address.js";
import {
  COMMISSION,
  EXPERIMENT_PARAMETERS,
  handEncoded,
  IMPLEMENTATION,
  MERCHANT,
  ON_CHAIN,
  S,
  S2,
  S3,
} from "./fixture.js";

const ZERO = "0x0000000000000000000000000000000000000000";

/** The factory and implementation of the experiment, as the chain named them. */
const DEPLOYMENT: SplitDeployment = { factory: ON_CHAIN.factory, implementation: IMPLEMENTATION };

/** S as the experiment created it: the passing control for every refusal below. */
const S_SPLIT: SplitParameters & SplitDeployment = {
  ...DEPLOYMENT,
  ...EXPERIMENT_PARAMETERS,
  salt: S.salt,
};

describe("the address of a split", () => {
  it("is the address the factory gave each split of the Base Sepolia experiment", () => {
    expect(splitAddress(S_SPLIT)).toBe(S.address);
    expect(splitAddress({ ...S_SPLIT, salt: S2.salt })).toBe(S2.address);
    expect(splitAddress({ ...S_SPLIT, allocations: S3.allocations })).toBe(S3.address);
  });

  it("is computed over the factory's clone code with its fifteen trailing zero bytes", () => {
    // Laid out from Splits' Clone.sol: the 98 bytes it stores, then the 15 of
    // the zero slot that `create2(0, 0x0f, 0x71, salt)` hashes with them.
    expect(cloneInitCode(IMPLEMENTATION)).toBe(
      `0x60593d8160093d39f336602c57343d527f` +
        `9e4ac34f21c619cefc926c8bd93b54bf5a39c7ab2127a895af1cc0691d7e3dff` +
        `593da1005b3d3d3d3d363d3d37363d73` +
        IMPLEMENTATION.slice(2).toLowerCase() +
        `5af43d3d93803e605757fd5bf3` +
        "00".repeat(15),
    );
  });

  it("is the same whichever spelling the recipients are written in", () => {
    expect(
      splitAddress({ ...S_SPLIT, recipients: [MERCHANT.toLowerCase(), COMMISSION.toLowerCase()] }),
    ).toBe(S.address);
  });

  it("is computed for a total other than a million, where the shares add up to it", () => {
    expect(() =>
      splitAddress({ ...S_SPLIT, allocations: [1_940_000, 60_000], totalAllocation: 2_000_000 }),
    ).not.toThrow();
  });
});

describe("parameters the factory could never make into a split that pays out", () => {
  const refusal = (changed: Partial<SplitParameters>): string => {
    try {
      splitAddress({ ...S_SPLIT, ...changed });
    } catch (thrown) {
      return thrown instanceof Error ? thrown.message : String(thrown);
    }
    throw new Error("an address was given");
  };

  it("are refused where the allocations fall short of the total", () => {
    expect(refusal({ allocations: [999_000, 999] })).toMatch(/add up to 999999.*1000000/s);
  });

  it("are refused where the allocations exceed the total", () => {
    expect(refusal({ allocations: [999_000, 1_001] })).toMatch(/add up to 1000001.*1000000/s);
  });

  it("are refused where the allocations add up to a million but the total is another number", () => {
    expect(refusal({ allocations: [999_000, 1_000], totalAllocation: 2_000_000 })).toMatch(
      /add up to 1000000.*2000000/s,
    );
  });

  it("are refused where a recipient has no allocation", () => {
    expect(refusal({ allocations: [1_000_000] })).toMatch(/2 recipients and allocations for 1/);
  });

  it("are refused with a total of zero, which every distribution would divide by", () => {
    expect(refusal({ allocations: [0, 0], totalAllocation: 0 })).toMatch(/total.*zero/s);
  });

  it("are refused with a distribution incentive, a cut for whoever distributes", () => {
    expect(refusal({ distributionIncentive: 1 })).toMatch(/incentive/);
  });

  it("are refused with an owner, who could change the recipients", () => {
    expect(refusal({ owner: COMMISSION })).toMatch(/owner/);
  });

  it("are refused where one wallet is named twice", () => {
    expect(refusal({ recipients: [MERCHANT, MERCHANT.toLowerCase()] })).toMatch(/twice/);
  });

  it("are refused where a recipient is the zero address", () => {
    expect(refusal({ recipients: [ZERO, COMMISSION] })).toMatch(/zero address/);
  });

  it("are refused with any number of recipients but two", () => {
    expect(
      refusal({
        recipients: [MERCHANT, COMMISSION, "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"],
        allocations: [998_000, 1_000, 1_000],
      }),
    ).toMatch(/two recipients/);
  });

  it("are refused where a recipient is not an address, or its capitals disagree with it", () => {
    const flipped = MERCHANT.replace("3F8C", "3f8C");
    expect(flipped).not.toBe(MERCHANT);
    expect(refusal({ recipients: [flipped, COMMISSION] })).toMatch(/not an address/);
    expect(
      refusal({ recipients: ["0xde3F8C4422A7F8C94bce9Cc2Ec118665108148E", COMMISSION] }),
    ).toMatch(/not an address/);
  });

  it("are refused with a salt that is not thirty-two bytes written in hexadecimal", () => {
    expect(refusal({ salt: S.salt.slice(0, -2) })).toMatch(/salt/);
    expect(refusal({ salt: `${S.salt}00` })).toMatch(/salt/);
    expect(refusal({ salt: `0x${"zz".repeat(32)}` })).toMatch(/salt/);
    expect(refusal({ salt: S.salt.slice(2) })).toMatch(/salt/);
  });

  it("are refused where an allocation is not a whole number of parts, even where they add up", () => {
    expect(refusal({ allocations: [1_001_000, -1_000] })).toMatch(/whole number/);
    expect(refusal({ allocations: [999_000.5, 999.5] })).toMatch(/whole number/);
  });

  it("are refused where the total is not a whole number of parts", () => {
    expect(refusal({ totalAllocation: 1_000_000.5 })).toMatch(/add up to 1000000.*1000000\.5/s);
    expect(refusal({ totalAllocation: -1_000_000 })).toMatch(/add up to 1000000.*-1000000/s);
  });
});

describe("the salt of a merchant's split", () => {
  it("is the hash of the label, the chain id and the merchant's identifier", () => {
    for (const { network, merchantId, salt } of handEncoded.salts) {
      expect(payoutSplitSalt(network, merchantId), `${network} ${merchantId}`).toBe(salt);
    }
  });

  it("differs between the test chain and the live chain, and between two merchants", () => {
    const salts = new Set(handEncoded.salts.map(({ salt }) => salt));
    expect(salts.size).toBe(handEncoded.salts.length);
  });

  it("gives a split whose address changes with the chain id alone", () => {
    const [onTest, onLive] = handEncoded.splits.filter(
      (split) =>
        split.commissionWallet === COMMISSION &&
        split.merchantId === handEncoded.payouts.merchant.merchantId,
    );
    expect(onTest?.network).toBe("eip155:84532");
    expect(onLive?.network).toBe("eip155:8453");
    for (const split of [onTest, onLive]) {
      if (split === undefined) throw new Error("a hand-encoded split is missing");
      expect(
        splitAddress({
          ...DEPLOYMENT,
          recipients: [split.merchantWallet, split.commissionWallet],
          allocations: [999_000, 1_000],
          totalAllocation: 1_000_000,
          distributionIncentive: 0,
          owner: ZERO,
          salt: payoutSplitSalt(split.network, split.merchantId),
        }),
      ).toBe(split.address);
    }
  });

  it("refuses a network that is not an EVM chain written as eip155 and a decimal chain id", () => {
    for (const network of [
      "eip155:84532abc",
      "eip155:",
      "eip155:084532",
      "eip155:0x14a34",
      "eip155:0",
      "EIP155:84532",
      "eip155:84532 ",
      " eip155:84532",
      "caip2:eip155:84532",
      "84532",
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    ]) {
      expect(
        () => payoutSplitSalt(network, handEncoded.payouts.merchant.merchantId),
        network,
      ).toThrowError(/eip155/);
    }
  });

  it("refuses a merchant with no identifier", () => {
    expect(() => payoutSplitSalt("eip155:84532", "")).toThrowError(/merchant/);
  });
});
