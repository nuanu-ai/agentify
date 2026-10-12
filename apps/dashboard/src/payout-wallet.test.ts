/**
 * An address money could never reach is refused before anything is written, and
 * one a wallet handed out with capitals is not. A saved address can be checked:
 * all of it is on the page, and what a merchant copies is the address itself.
 * The routes that save one are driven over HTTP in `server.test.ts`.
 */

import { checksummedAddressOf } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import { payoutWalletBlock, whatIsWrongWithTheWallet } from "./payout-wallet.js";
import type { Viewer } from "./screens.js";
import { readable } from "./testing/html.js";

/** Of the right shape, and obviously not a real address. */
const SHAPED = "0x0123456789abcdef0123456789abcdef01234567";

const looking = (payout?: Viewer["payout"]): Viewer => ({
  base: "",
  mode: "sandbox",
  who: "owner@example.com",
  confirmed: true,
  ...(payout === undefined ? {} : { payout }),
});

const asCopied = (html: string): string => html.replaceAll(/<[^>]*>/g, "");

describe("the rule an address is held to", () => {
  it("takes both of the two spellings anybody writes an address in", () => {
    // Lower case is what a block explorer prints; mixed case is what a wallet
    // copies, its capitals a checksum. Both are addresses merchants are
    // actually given.
    expect(whatIsWrongWithTheWallet(SHAPED)).toBeNull();
    expect(whatIsWrongWithTheWallet(checksummedAddressOf(SHAPED))).toBeNull();
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
});

describe("the block on the settings screen", () => {
  it("shows a saved address whole, so a merchant can check it against their wallet", () => {
    const block = payoutWalletBlock(looking({ wallet: SHAPED }));

    // No ellipsis for the middle: that is the one presentation under which a
    // wrong address and the right one look identical.
    expect(asCopied(block)).toContain(SHAPED);
    expect(block).not.toContain("…");
  });

  it("leaves no space inside the address, so copying it off the page pastes an address", () => {
    // Real spaces between the groups would make a copied address something no
    // wallet accepts.
    const copied = asCopied(payoutWalletBlock(looking({ wallet: SHAPED })));
    const shown = copied.slice(copied.indexOf("0x"), copied.indexOf("0x") + SHAPED.length);

    expect(shown).toBe(SHAPED);
  });

  it("asks for the address and for nothing else", () => {
    // A second box on this block is how a merchant would come to believe we ask
    // for a key or a recovery phrase.
    const block = payoutWalletBlock(looking({ wallet: null }));

    expect(block.match(/<input/g)).toHaveLength(1);
    expect(block).toContain('name="payout_wallet"');
    expect(readable(block).toLowerCase()).not.toMatch(/enter your (private key|recovery phrase)/);
  });

  it("says a sandbox address is optional because nothing settles", () => {
    const text = readable(payoutWalletBlock(looking({ wallet: null })));

    expect(text).toMatch(/does not settle/i);
    expect(text).toMatch(/optional/i);
  });

  it("says publishing is refused without an address where the door asks for one", () => {
    // Until an address is set, every card the merchant's code publishes is
    // refused, in test mode as in live; the sandbox asks for none.
    for (const mode of ["test", "live"] as const) {
      const text = readable(payoutWalletBlock({ ...looking({ wallet: null }), mode }));
      expect(text, mode).toMatch(/publishing a card is refused/i);
    }
    expect(readable(payoutWalletBlock(looking({ wallet: null })))).not.toMatch(/refused/i);
  });

  it("says nothing about a refusal once an address is set", () => {
    const text = readable(payoutWalletBlock({ ...looking({ wallet: SHAPED }), mode: "test" }));

    expect(text).not.toMatch(/refused/i);
    expect(text).not.toMatch(/optional/i);
  });

  it("names Base Sepolia and test USDC on the test stack", () => {
    const text = readable(payoutWalletBlock({ ...looking({ wallet: null }), mode: "test" }));

    expect(text).toContain("Base Sepolia");
    expect(text).toContain("test USDC");
    expect(text).toMatch(/settle/i);
  });

  it("shows a refused address whole, so the merchant can read it against their wallet", () => {
    // The refused address is on the page as text, not only inside the box: the
    // box's value is an attribute, which the clipboard's view of the page does
    // not see.
    const shouted = `0x${SHAPED.slice(2).toUpperCase()}`;
    const block = payoutWalletBlock(
      looking({ wallet: SHAPED, problem: "It was not saved.", typed: shouted }),
    );

    expect(asCopied(block)).toContain(shouted);
  });

  it("shows what was wrong with an address just refused", () => {
    const block = payoutWalletBlock(looking({ wallet: SHAPED, problem: "that was not saved" }));

    expect(readable(block)).toContain("that was not saved");
  });

  it("draws nothing on a screen that did not ask the gateway for the address", () => {
    // A page that did not ask the gateway must say nothing either way.
    expect(payoutWalletBlock(looking())).toBe("");
  });
});
