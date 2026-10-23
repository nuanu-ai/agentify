/**
 * `test: false` on a receipt is a claim to somebody else's agent about somebody
 * else's money, so a chain nobody wrote down is refused rather than sorted into
 * a side.
 */

import { describe, expect, it } from "vitest";
import {
  CDP_FACILITATOR_URL,
  environmentOf,
  environmentOfKeyPrefix,
  isTestnetChain,
  keyPrefixFor,
  LIVE_CHAINS,
  PUBLIC_X402_FACILITATOR_URL,
  SANDBOX_FACILITATOR,
  SITES,
  SURFACE_WORDS,
  surfaceModeOf,
  TESTNET_CHAINS,
} from "./environment.js";

describe("environmentOf", () => {
  it("reads Base Sepolia as a test environment", () => {
    expect(environmentOf("eip155:84532")).toBe("test");
  });

  it("refuses Ethereum Sepolia and Polygon Amoy, where no payout split is written", () => {
    expect(() => environmentOf("eip155:11155111")).toThrowError(/neither written list/);
    expect(() => environmentOf("eip155:80002")).toThrowError(/neither written list/);
  });

  it("reads Base mainnet as a live environment", () => {
    expect(environmentOf("eip155:8453")).toBe("live");
  });

  it("refuses a chain on neither list, naming the variable and both lists", () => {
    expect(() => environmentOf("eip155:1")).toThrowError(
      /PAYMENT_NETWORK.*eip155:1.*eip155:84532.*eip155:8453/s,
    );
  });

  it("refuses Ethereum and Polygon mainnet, which are chains we do not sell on", () => {
    expect(() => environmentOf("eip155:1")).toThrow();
    expect(() => environmentOf("eip155:137")).toThrow();
  });

  it("holds the two lists apart", () => {
    for (const chain of TESTNET_CHAINS) {
      expect(LIVE_CHAINS.has(chain)).toBe(false);
    }
  });
});

describe("isTestnetChain", () => {
  it("answers for every chain rather than throwing, which is what a spending gate needs", () => {
    expect(isTestnetChain("eip155:84532")).toBe(true);
    expect(isTestnetChain("eip155:8453")).toBe(false);
    expect(isTestnetChain("eip155:1")).toBe(false);
  });

  it("agrees with the derivation wherever the derivation answers", () => {
    for (const chain of [...TESTNET_CHAINS, ...LIVE_CHAINS]) {
      expect(isTestnetChain(chain)).toBe(environmentOf(chain) === "test");
    }
  });
});

describe("surfaceModeOf", () => {
  it("is the sandbox where nothing settles, whatever the chain says", () => {
    expect(surfaceModeOf("eip155:84532", SANDBOX_FACILITATOR)).toBe("sandbox");
  });

  it("is a test site where a test chain settles for real", () => {
    expect(surfaceModeOf("eip155:84532", PUBLIC_X402_FACILITATOR_URL)).toBe("test");
  });

  it("is live where the money is real", () => {
    expect(surfaceModeOf("eip155:8453", CDP_FACILITATOR_URL)).toBe("live");
  });

  it("refuses an unwritten chain even where nothing settles", () => {
    expect(() => surfaceModeOf("eip155:1", SANDBOX_FACILITATOR)).toThrow();
  });
});

describe("SURFACE_WORDS", () => {
  it("claims on a test page only what the chain vouches for, not that anything settles", () => {
    // A test mode is any facilitator on a test chain, including a local model
    // that settles nothing; that the money is not real is all the chain says.
    expect(SURFACE_WORDS.test).toMatch(/test funds/);
    expect(SURFACE_WORDS.test).not.toMatch(/settle/i);
  });
});

describe("key prefixes", () => {
  it("gives each environment its own", () => {
    expect(keyPrefixFor("test")).toBe("csk_test_");
    expect(keyPrefixFor("live")).toBe("csk_live_");
  });

  it("reads an environment back off a key", () => {
    expect(environmentOfKeyPrefix("csk_test_abc")).toBe("test");
    expect(environmentOfKeyPrefix("csk_live_abc")).toBe("live");
  });

  it("reads nothing off a key that carries neither prefix", () => {
    expect(environmentOfKeyPrefix("csk_abc")).toBeNull();
    expect(environmentOfKeyPrefix("")).toBeNull();
  });
});

describe("SITES", () => {
  it("names the two sites a key can be told to go to", () => {
    expect(SITES.test).toBe("test.agentify.ad");
    expect(SITES.live).toBe("agentify.ad");
  });
});
