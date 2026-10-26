/**
 * A refused seller name tells the merchant whose rule refused it: the payment
 * network's listing for length and characters, Agentify's own for plain text.
 * A merchant told the wrong owner of a rule argues with the wrong party.
 */

import { describe, expect, it } from "vitest";
import { whatIsWrongWithTheName } from "./seller-name.js";

const NETWORK = /payment network/i;

describe("whose rule a refused seller name broke", () => {
  it("takes a name with an ampersand written as text", () => {
    expect(whatIsWrongWithTheName("Tea & Co")).toBeNull();
  });

  it("names the payment network for a character its listing does not carry", () => {
    expect(whatIsWrongWithTheName("Freeland — eSIM & VPN")).toMatch(NETWORK);
  });

  it("names the payment network for a name past its length", () => {
    expect(whatIsWrongWithTheName("x".repeat(33))).toMatch(NETWORK);
  });

  it("does not lend the network's name to the plain-text rule, which is ours", () => {
    for (const name of ["<b>Tea</b>", "Tea &amp; Co"]) {
      const refusal = whatIsWrongWithTheName(name);

      expect(refusal, name).not.toBeNull();
      expect(refusal, name).not.toMatch(NETWORK);
    }
  });
});
