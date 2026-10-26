import { describe, expect, it } from "vitest";
import { checksummedAddressOf, EvmAddressSchema } from "./evm-address.js";
import { errorOf } from "./testing/expect-schema.js";

/**
 * The addresses EIP-55 publishes as its own test vectors, in the spelling the
 * standard prints them in: an outside oracle, so an implementation that agrees
 * with all eight is the standard's and not merely self-consistent. Of the last
 * four, two come out of the checksum all capitals and two all lower case; that
 * is the standard's own output.
 */
const CHECKSUMMED = [
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  "0x52908400098527886E0F7030069857D2E4169EE7",
  "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
  "0xde709f2102306220921060314715629080e2fb77",
  "0x27b1fdb04752bbc536007a920d24acb045561c26",
];

/** The same address with one letter's case flipped: one keystroke off. */
const oneLetterFlipped = (address: string): string => {
  const body = address.slice(2);
  for (const [index, character] of [...body].entries()) {
    const flipped =
      character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase();
    if (flipped !== character) {
      return `0x${body.slice(0, index)}${flipped}${body.slice(index + 1)}`;
    }
  }
  throw new Error(`${address} carries no letter to flip`);
};

const accepts = (value: string): boolean => EvmAddressSchema.safeParse(value).success;

describe("an address on an EVM chain", () => {
  // The promise: the address a merchant's sales are paid to is the address
  // their wallet showed them, despite a lost character, a case-mangling copy or
  // an unseen truncation.

  it("takes every address the standard publishes, in the spelling it publishes", () => {
    for (const address of CHECKSUMMED) {
      expect(accepts(address), address).toBe(true);
    }
  });

  it("takes the same addresses written all in lower case", () => {
    // Lower case carries no checksum and is a real spelling: it is what a
    // block explorer prints.
    for (const address of CHECKSUMMED) {
      expect(accepts(address.toLowerCase()), address).toBe(true);
    }
  });

  it("refuses an address whose letters claim a checksum they do not carry", () => {
    // One wrong character in a wallet's spelling makes the capitals disagree
    // with the rest, the only warning before money goes to a stranger.
    for (const address of CHECKSUMMED) {
      const mistyped = oneLetterFlipped(address);
      expect(accepts(mistyped), mistyped).toBe(false);
    }
  });

  it("refuses a character swapped for another inside a checksummed address", () => {
    // A changed digit, not just a changed case: the mistake that actually
    // costs money.
    expect(accepts("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAee")).toBe(false);
    expect(accepts("0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d358")).toBe(false);
  });

  it("says the address looks mistyped and to copy it again from the wallet, never to drop the checksum", () => {
    // The reader is a merchant holding a wallet address, who needs to hear
    // that this is not the address they think and what to do. Lower case is
    // accepted but carries no checksum, so suggesting it here would turn the
    // mistyped address, somebody else's valid one, into an accepted one.
    const complaint = errorOf(EvmAddressSchema, oneLetterFlipped(CHECKSUMMED[0] ?? ""));

    expect(complaint).toMatch(/wrong|mistyp/i);
    expect(complaint).toMatch(/copy .*from your wallet/i);
    expect(complaint).not.toMatch(/lower ?case/i);
  });

  it("refuses a shape that is not an address at all", () => {
    expect(accepts("")).toBe(false);
    expect(accepts("0x")).toBe(false);
    // One character short: a paste that lost a character, invisible by eye.
    expect(accepts("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe")).toBe(false);
    expect(accepts("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAedd")).toBe(false);
    // The prefix is part of the address rather than decoration on it.
    expect(accepts("5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(false);
    expect(accepts("0X5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(false);
    // "g" and "z" are where a hand reaching for "f" and "a" lands.
    expect(accepts("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaeg")).toBe(false);
    expect(accepts("0xzaaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(false);
  });

  it("refuses an address with whitespace anywhere on it", () => {
    // Refused rather than trimmed: what a merchant is paid at must be the
    // string they can see.
    const address = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";

    expect(accepts(` ${address}`)).toBe(false);
    expect(accepts(`${address} `)).toBe(false);
    expect(accepts(`${address}\n`)).toBe(false);
    expect(accepts("0x5aaeb6053f3e94c9 b9a09f33669435e7ef1beaed")).toBe(false);
  });

  it("complains about the shape alone when the shape is wrong", () => {
    // One complaint about one string: a merchant should not look for a
    // checksum in something that is not an address.
    const complaint = errorOf(EvmAddressSchema, "0xnot-an-address");

    expect(complaint).toContain("forty");
    expect(complaint).not.toMatch(/wrong|mistyp/i);
  });

  it("refuses anything that is not a string", () => {
    expect(EvmAddressSchema.safeParse(null).success).toBe(false);
    expect(EvmAddressSchema.safeParse(undefined).success).toBe(false);
    expect(EvmAddressSchema.safeParse(0x5aaeb605).success).toBe(false);
  });
});

describe("an address written the way a wallet shows it", () => {
  // The promise: every screen that shows a merchant's address back shows the
  // forty characters they pasted out of their wallet.

  it("writes out the spelling the standard publishes, from either spelling", () => {
    for (const address of CHECKSUMMED) {
      expect(checksummedAddressOf(address.toLowerCase()), address).toBe(address);
      // Given that spelling already, it answers with the same string.
      expect(checksummedAddressOf(address), address).toBe(address);
    }
  });

  it("puts capitals in an address that has letters to capitalise", () => {
    // The negative control: two of the vectors come out all lower case, so an
    // identity function would pass those; this one has to change.
    const lowered = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";

    expect(checksummedAddressOf(lowered)).not.toBe(lowered);
    expect(checksummedAddressOf(lowered)).toBe("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
  });

  it("leaves an address with no letters in it exactly as it is", () => {
    // All digits, nothing to capitalise: what the seeded addresses in the
    // gateway's tests look like.
    const digits = "0x0000000000000000000000000000000000000001";

    expect(checksummedAddressOf(digits)).toBe(digits);
  });

  it("agrees with the schema about which addresses there are", () => {
    // An address this writes out is one the schema takes, and the reverse.
    for (const address of CHECKSUMMED) {
      expect(EvmAddressSchema.safeParse(checksummedAddressOf(address)).success, address).toBe(true);
    }
  });

  it("refuses to repair an address whose letters disagree with it", () => {
    // Capitalising a mistyped address afresh would produce a well-formed
    // address nobody typed, defeating the checksum.
    const mistyped = oneLetterFlipped(CHECKSUMMED[0] ?? "");

    expect(() => checksummedAddressOf(mistyped)).toThrow();
    expect(() => checksummedAddressOf("0x1234")).toThrow();
    expect(() => checksummedAddressOf("")).toThrow();
  });
});
