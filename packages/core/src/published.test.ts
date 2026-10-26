/**
 * How the numbers Agentify publishes about itself are said: the portal, the
 * landing and the dashboard write a deadline, a count and the commission
 * through these, so a number they cannot say exactly stops whoever is writing
 * it out rather than reaching a reader rounded or garbled.
 */

import { describe, expect, it } from "vitest";
import { durationInWords, inWords, ordinalInWords, percentOf } from "./published.js";

describe("a stretch of time, said in words", () => {
  it("is counted in the unit its sentence names", () => {
    expect(durationInWords(30_000, "second")).toBe("thirty seconds");
    expect(durationInWords(600_000, "minute")).toBe("ten minutes");
    expect(durationInWords(30 * 86_400_000, "day")).toBe("thirty days");
    expect(durationInWords(48_000, "second")).toBe("forty-eight seconds");
  });

  it("is one of its unit as a sentence says one", () => {
    expect(durationInWords(86_400_000, "day")).toBe("a day");
  });

  it("is refused where it is no whole number of its unit, rather than rounded", () => {
    expect(() => durationInWords(1_500, "second")).toThrow(
      /1500 ms is not a whole number of seconds/,
    );
    expect(() => durationInWords(90_000, "minute")).toThrow(/not a whole number of minutes/);
  });
});

describe("a count, said in words", () => {
  it("is written as a sentence writes it", () => {
    expect(inWords(5)).toBe("five");
    expect(inWords(15)).toBe("fifteen");
    expect(inWords(50)).toBe("fifty");
    expect(inWords(99)).toBe("ninety-nine");
  });

  it("is refused where it has no words here, rather than written in digits or as nothing", () => {
    for (const count of [0, 100, 2.5, -3]) {
      expect(() => inWords(count), String(count)).toThrow(/cannot say .* in words/);
    }
  });
});

describe("a count, said as its place in a row", () => {
  it("is written as a sentence writes it", () => {
    const said = [1, 2, 3, 5, 8, 9, 10, 12, 20, 21, 50, 99].map(ordinalInWords);

    expect(said).toStrictEqual([
      "first",
      "second",
      "third",
      "fifth",
      "eighth",
      "ninth",
      "tenth",
      "twelfth",
      "twentieth",
      "twenty-first",
      "fiftieth",
      "ninety-ninth",
    ]);
  });
});

describe("a rate, said as a percentage", () => {
  it("is said exactly", () => {
    expect(percentOf(1_000, 1_000_000)).toBe("0.1%");
    expect(percentOf(999_000, 1_000_000)).toBe("99.9%");
  });

  it("is refused where it could only be rounded, so no rounded rate reads as the exact one", () => {
    expect(() => percentOf(1, 3)).toThrow(/no exact percentage/);
  });
});
