import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type TariffId, tariffBlock } from "./tariff.js";

/**
 * The cabinet's tariff block and the landing's pricing section describe the
 * same six candidates. If this fails, one page promises what the other does
 * not: a line of the cabinet's block is missing from the landing.
 */
const landing = readFileSync(
  new URL("../../commerce-landing/index.html", import.meta.url),
  "utf8",
).replaceAll("&nbsp;", " ");

const textsOf = (html: string): string[] =>
  [...html.matchAll(/<(?:li|span|b)>([^<]+)<\/(?:li|span|b)>/g)].map((match) => match[1] ?? "");

describe("the tariff on the settings screen", () => {
  it("promises nothing the landing's pricing does not", () => {
    for (const id of ["t1", "t2", "t3", "t4", "t5", "t6"] as TariffId[]) {
      const lines = textsOf(tariffBlock(id));
      expect(lines.length, id).toBeGreaterThan(0);
      for (const line of lines) {
        expect(landing, `${id}: ${line}`).toContain(line);
      }
    }
  });

  it("draws nothing while no tariff is chosen", () => {
    expect(tariffBlock(null)).toBe("");
  });
});
