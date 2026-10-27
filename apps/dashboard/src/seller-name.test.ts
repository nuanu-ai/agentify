/**
 * A refused seller name tells the merchant whose rule refused it: the payment
 * network's listing for length and characters, Agentify's own for plain text.
 * A merchant told the wrong owner of a rule argues with the wrong party.
 */

import { describe, expect, it } from "vitest";
import { whatIsWrongWithTheName, whatIsWrongWithTheSite } from "./seller-name.js";

const NETWORK = /payment network/i;

describe("whose rule a refused seller name broke", () => {
  it("takes a name with an ampersand written as text", () => {
    expect(whatIsWrongWithTheName("Tea & Co")).toBeNull();
  });

  it.each(["Freeland — eSIM & VPN", "x".repeat(33)])(
    "attributes a refused listing name to the payment network: %s",
    (name) => {
      expect(whatIsWrongWithTheName(name)).toMatch(NETWORK);
    },
  );

  it("does not lend the network's name to the plain-text rule, which is ours", () => {
    for (const name of ["<b>Tea</b>", "Tea &amp; Co"]) {
      const refusal = whatIsWrongWithTheName(name);

      expect(refusal, name).not.toBeNull();
      expect(refusal, name).not.toMatch(NETWORK);
    }
  });
});

describe("a refused shop's site", () => {
  it("offers the domain alone where the address carried a page after it", () => {
    expect(whatIsWrongWithTheSite("https://freeland.example/shop")).toContain(
      "Use the domain only: https://freeland.example.",
    );
  });

  it("offers no domain a person would not recognise, as one written in another script", () => {
    const refusal = whatIsWrongWithTheSite("https://магазин.рф/");
    expect(refusal).not.toBeNull();
    expect(refusal).toMatch(/not saved/i);
    expect(refusal).toMatch(/https:\/\/ and your domain only/i);
    expect(refusal).not.toMatch(/xn--/);
  });

  it("says the rule where no domain can be taken from what was typed", () => {
    const said = whatIsWrongWithTheSite("my shop") ?? "";

    expect(said).toMatch(/https:\/\/ and your domain only/);
    expect(said).toMatch(/not saved/);
  });
});
