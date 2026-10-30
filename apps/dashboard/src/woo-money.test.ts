/**
 * The arithmetic a shop priced in another currency is sold by: its amounts as
 * the shop writes them, at no decimals or two, and the merchant's rate turning
 * them into the US dollars a buyer pays. The rupiah prices are the lab's
 * realistic catalogue, drawn from the census of Indonesian shops, written as
 * those shops write them, with no decimals; the reference is Coinbase's answer
 * recorded on 2026-10-21.
 */

import { describe, expect, it } from "vitest";
import {
  dollarsAt,
  gapOf,
  minorOf,
  rateWrittenAs,
  shopAmountOf,
  sumOf,
  withinOneUnit,
} from "./woo-money.js";

const CENSUS_MEDIAN = "170000";
const CHEAPEST = "2000";
const DEAREST = "40500000";
const COINBASE_IDR = "18035.292596";

describe("a price in a shop's own currency, turned into US dollars at the merchant's rate", () => {
  it("is the shop's amount divided by the rate, rounded up to the cent", () => {
    expect(dollarsAt("250000", "18000")).toBe("13.89");
    expect(dollarsAt(CENSUS_MEDIAN, COINBASE_IDR)).toBe("9.43");
  });

  it("adds no cent where the conversion is exact", () => {
    expect(dollarsAt("180000", "18000")).toBe("10.00");
    expect(dollarsAt(DEAREST, "18000")).toBe("2250.00");
  });

  it("charges a cheap product the cent it rounds up to, never a price of nothing", () => {
    expect(dollarsAt(CHEAPEST, "18000")).toBe("0.12");
    expect(dollarsAt("1", "18000")).toBe("0.01");
  });

  it("converts a shop that writes two decimals at a rate written with six", () => {
    expect(dollarsAt("19.90", "0.891113")).toBe("22.34");
  });

  it("has no price for a rate of nothing, or an amount it cannot read", () => {
    expect(dollarsAt("250000", "0")).toBeNull();
    expect(dollarsAt("250000", "0.000000")).toBeNull();
    expect(dollarsAt("250.000", "18000")).toBeNull();
    expect(dollarsAt("Rp 250.000", "18000")).toBeNull();
  });
});

describe("a rate as the merchant types it", () => {
  it("is how many units of the shop's currency one US dollar buys, in digits", () => {
    expect(rateWrittenAs("18000")).toBe("18000");
    expect(rateWrittenAs(" 18000 ")).toBe("18000");
    expect(rateWrittenAs("0.891113")).toBe("0.891113");
    expect(rateWrittenAs(".89")).toBe("0.89");
    expect(rateWrittenAs("018000")).toBe("18000");
  });

  it("is refused with a separator between thousands, a seventh decimal, a sign or nothing", () => {
    for (const typed of [
      "18,000",
      "18 000",
      "0.8911126",
      "-18000",
      "",
      "0",
      "0.0",
      "1e4",
      "18000.",
    ]) {
      expect(rateWrittenAs(typed), typed).toBeNull();
    }
  });
});

describe("how far a rate is from the reference", () => {
  it("asks for the rate again when a digit is missing or one too many", () => {
    expect(gapOf("1800", COINBASE_IDR)).toMatchObject({ far: true, shown: "90.0% below" });
    expect(gapOf("180000", COINBASE_IDR)).toMatchObject({ far: true, shown: "898.0% above" });
  });

  it("asks again for a euro rate typed the other way round", () => {
    expect(gapOf("1.12", "0.8911126396507733")).toMatchObject({ far: true, shown: "25.7% above" });
  });

  it("leaves alone a rate the merchant moved by their own exchange's spread", () => {
    expect(gapOf("18000", COINBASE_IDR)).toMatchObject({ far: false, shown: "0.2% below" });
    expect(gapOf("16500", COINBASE_IDR)).toMatchObject({ far: false, shown: "8.5% below" });
  });

  it("asks again past ten percent either way, and not at ten exactly", () => {
    expect(gapOf("19800", "18000").far).toBe(false);
    expect(gapOf("19800.000001", "18000").far).toBe(true);
    expect(gapOf("16200", "18000").far).toBe(false);
    expect(gapOf("16199.999999", "18000").far).toBe(true);
  });
});

describe("an amount as the shop writes it", () => {
  it("is padded to the shop's decimals and never rounded into one the shop did not set", () => {
    expect(shopAmountOf("250000", 0)).toBe("250000");
    expect(shopAmountOf("250000.00", 0)).toBe("250000");
    expect(shopAmountOf("250000.5", 0)).toBeNull();
    expect(shopAmountOf("19.9", 2)).toBe("19.90");
    expect(shopAmountOf(".99", 2)).toBe("0.99");
    expect(shopAmountOf("25.001", 2)).toBeNull();
  });

  it("is added only to an amount written at the same decimals", () => {
    expect(sumOf("250000", "24000")).toBe("274000");
    expect(sumOf("20.00", "1.50")).toBe("21.50");
    expect(sumOf("250000", "1.50")).toBeNull();
  });

  it("is counted in the shop's smallest written unit", () => {
    expect(minorOf("250000")).toEqual({ minor: 250000n, decimals: 0 });
    expect(minorOf("25.00")).toEqual({ minor: 2500n, decimals: 2 });
    expect(minorOf("25.0")).toBeNull();
  });
});

describe("a shop's order held to the amount it was priced at", () => {
  it("is taken on at the amount or one smallest unit either side of it", () => {
    expect(withinOneUnit("250000", "250000")).toBe(true);
    expect(withinOneUnit("250001", "250000")).toBe(true);
    expect(withinOneUnit("249999", "250000")).toBe(true);
    expect(withinOneUnit("25.01", "25.00")).toBe(true);
  });

  it("is not taken on two units off, or written at other decimals", () => {
    expect(withinOneUnit("250002", "250000")).toBe(false);
    expect(withinOneUnit("249998", "250000")).toBe(false);
    expect(withinOneUnit("25.02", "25.00")).toBe(false);
    expect(withinOneUnit("250000.00", "250000")).toBe(false);
    expect(withinOneUnit("25", "25.00")).toBe(false);
  });
});
