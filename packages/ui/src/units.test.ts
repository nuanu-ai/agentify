import { describe, expect, it } from "vitest";
import { asTyped, keepUnits, withUnit } from "./units.js";

const NBSP = "\u00a0";

describe("a number and its unit as a page shows them", () => {
  it("are joined by a space a line does not break at", () => {
    expect(keepUnits("eSIM Indonesia 5 GB")).toBe(`eSIM Indonesia 5${NBSP}GB`);
    expect(keepUnits("asks again in 30 s")).toBe(`asks again in 30${NBSP}s`);
    expect(keepUnits("47 min left")).toBe(`47${NBSP}min left`);
  });

  it("keep a number with decimals or thousands separators whole", () => {
    expect(keepUnits("8.00 USD")).toBe(`8.00${NBSP}USD`);
    expect(keepUnits("49.450498 USDC")).toBe(`49.450498${NBSP}USDC`);
    expect(keepUnits("240,000 IDR in your shop")).toBe(`240,000${NBSP}IDR in your shop`);
    expect(keepUnits("1,500 bytes")).toBe(`1,500${NBSP}bytes`);
  });

  it("join every pair in the text, at its end and before punctuation too", () => {
    expect(keepUnits("Data 10 GB, valid 30 days.")).toBe(`Data 10${NBSP}GB, valid 30${NBSP}days.`);
    expect(keepUnits("Batik Sarong (115 × 180 cm)")).toBe(`Batik Sarong (115 × 180${NBSP}cm)`);
  });

  it("join a unit spelled out in the singular, the plural or with a capital", () => {
    expect(keepUnits("1 day, 2 hours, 1 Week, 30 Days")).toBe(
      `1${NBSP}day, 2${NBSP}hours, 1${NBSP}Week, 30${NBSP}Days`,
    );
  });

  it("leave a word that only begins like a unit alone", () => {
    for (const text of ["5 mines", "3 hats", "2 dimes", "10 GBP", "4 sizes", "7 dollars"]) {
      expect(keepUnits(text)).toBe(text);
    }
  });

  it("leave a number that is part of a word alone", () => {
    expect(keepUnits("x402 s")).toBe("x402 s");
  });

  it("change no other space", () => {
    const text = "Handwoven Endek Table Runner, 35 × 200 cm, ships in 3 days";
    const kept = keepUnits(text);
    expect(kept.split(NBSP)).toHaveLength(3);
    expect(kept.replaceAll(NBSP, " ")).toBe(text);
    expect(keepUnits("No number here at all")).toBe("No number here at all");
  });
});

describe("a number written with a unit the text names", () => {
  it("is joined to it whatever the unit, such as a shop's currency", () => {
    expect(withUnit("13.34", "EUR")).toBe(`13.34${NBSP}EUR`);
    expect(withUnit(12, "min")).toBe(`12${NBSP}min`);
  });
});

describe("a shown text as a person types it", () => {
  it("has ordinary spaces, so a search typed with them finds what the page shows", () => {
    expect(asTyped(keepUnits("eSIM 5 GB 30 days"))).toBe("eSIM 5 GB 30 days");
    expect(asTyped(withUnit("8.00", "USD"))).toBe("8.00 USD");
  });
});
