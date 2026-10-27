/**
 * An address money could never reach is refused before anything is written, and
 * one a wallet handed out with capitals is not. The settings screen draws the
 * address (`app/screens/settings.test.tsx`), and the routes that save one are
 * driven over HTTP in `server.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { WALLET_NEEDED, WALLET_RULE, whatIsWrongWithTheWallet } from "./payout-wallet.js";

/** Of the right shape, and obviously not a real address. */
const SHAPED = "0x0123456789abcdef0123456789abcdef01234567";

describe("the rule an address is held to", () => {
  it("takes both of the two spellings anybody writes an address in", () => {
    // Lower case is what a block explorer prints; mixed case is what a wallet
    // copies, its capitals a checksum. Both are addresses merchants are
    // actually given.
    expect(whatIsWrongWithTheWallet(SHAPED)).toBeNull();
    expect(whatIsWrongWithTheWallet("0x70997970C51812dc3A010C7d01b50e0d17dc79C8")).toBeNull();
  });

  it("refuses capitals that disagree with the rest, and says which failure it is", () => {
    // Capitals that do not check out mean a character is wrong, and a wrong
    // address is another valid one belonging to somebody else; the sentence has
    // to name the capitals.
    const shouted = `0x${SHAPED.slice(2).toUpperCase()}`;

    const said = whatIsWrongWithTheWallet(shouted);

    expect(said).not.toBeNull();
    expect(said).toMatch(/capital letters/i);
    expect(said).toMatch(/not saved/i);
    expect(said).not.toBe(whatIsWrongWithTheWallet("my wallet"));
  });

  it("refuses what money could never reach, and says nothing was saved", () => {
    const wrong = [
      "",
      "0x",
      // One character short and one long: the mistakes of a hand that retyped
      // it.
      SHAPED.slice(0, -1),
      `${SHAPED}0`,
      // No 0x prefix, as some tools print it.
      SHAPED.slice(2),
      // A non-hexadecimal character in the middle, where an eye skates over it.
      `${SHAPED.slice(0, 20)}z${SHAPED.slice(21)}`,
      `${SHAPED} and then some`,
      "my wallet",
    ];

    for (const address of wrong) {
      const said = whatIsWrongWithTheWallet(address);
      expect(said, address).not.toBeNull();
      expect(said, address).toMatch(/not saved/i);
    }
  });

  it("tells a mistyped address to be copied again, never to drop the capitals that caught it", () => {
    // Written in lower case, a typo passes as somebody else's valid address.
    const said = whatIsWrongWithTheWallet(`0x${SHAPED.slice(2).toUpperCase()}`) ?? "";

    expect(said).toMatch(/copy it again/i);
    for (const advice of [said, WALLET_RULE, WALLET_NEEDED]) {
      expect(advice).not.toMatch(/lower ?case/i);
    }
  });

  it("names what makes an address the wrong shape: its start, a character, or its length", () => {
    expect(whatIsWrongWithTheWallet(SHAPED.slice(2))).toMatch(/start with 0x/i);
    expect(whatIsWrongWithTheWallet(`${SHAPED.slice(0, 20)}z${SHAPED.slice(21)}`)).toContain(
      "“z” can't be in a wallet address.",
    );
    expect(whatIsWrongWithTheWallet(SHAPED.slice(0, -1))).toMatch(/41 characters/);
  });
});
