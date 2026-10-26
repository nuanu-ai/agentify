/**
 * What a writer is promised when a page names a number the build writes in:
 * it reaches the reader spelled the way the sentence around it needs, and a
 * value the build cannot say, a form it does not have or a name nobody knows
 * stops the build instead of reaching a reader as something odd.
 */

import { describe, expect, it } from "vitest";
import { writtenIn } from "./build-values.js";

const VALUES = {
  "price-holds": { ms: 30_000, unit: "second" },
  "silent-after": { ms: 600_000, unit: "minute" },
  "default-deadline": { ms: 86_400_000, unit: "day" },
  "waiting-at-most": { count: 50 },
  rate: { part: 1_000, total: 1_000_000 },
  release: { text: "0.9.1" },
} as const;

describe("a number a page names", () => {
  it("is spelled out in prose, with its unit", () => {
    expect(writtenIn("A price holds for {{price-holds}}.", VALUES)).toBe(
      "A price holds for thirty seconds.",
    );
    expect(writtenIn("polled for {{silent-after}}, or {{default-deadline}}", VALUES)).toBe(
      "polled for ten minutes, or a day",
    );
    expect(writtenIn("{{waiting-at-most}} of yours, {{rate}}", VALUES)).toBe(
      "fifty of yours, 0.1%",
    );
  });

  it("is written in digits in a drawing, and without its unit where the sentence names it", () => {
    expect(writtenIn("Note over A,G: the price holds {{price-holds:short}}", VALUES)).toBe(
      "Note over A,G: the price holds 30 s",
    );
    expect(writtenIn("and the facilitator's {{price-holds:number}} fit", VALUES)).toBe(
      "and the facilitator's thirty fit",
    );
  });

  it("is written as a percentage, and in words where a screen reader reads it aloud", () => {
    expect(writtenIn('W -- "{{rate}}" --> F', VALUES)).toBe('W -- "0.1%" --> F');
    expect(writtenIn("accDescr: {{rate:words}} kept for Agentify", VALUES)).toBe(
      "accDescr: 0.1 percent kept for Agentify",
    );
  });

  it("opens a sentence with a capital where its name is written with one", () => {
    expect(writtenIn("{{Waiting-at-most}} of your purchases", VALUES)).toBe(
      "Fifty of your purchases",
    );
    expect(writtenIn("{{Default-deadline}} applies instead.", VALUES)).toBe(
      "A day applies instead.",
    );
  });

  it("leaves a value a deployment decides for the server to fill", () => {
    expect(writtenIn("[{{abuse-email}}](mailto:{{abuse-email}}) at {{origin}}", VALUES)).toBe(
      "[{{abuse-email}}](mailto:{{abuse-email}}) at {{origin}}",
    );
  });
});

describe("the build stops", () => {
  it("on a number the speller refuses, naming the value it was written for", () => {
    const values = { ...VALUES, "price-holds": { ms: 1_500, unit: "second" } } as const;

    expect(() => writtenIn("holds for {{price-holds}}", values)).toThrow(
      /^\{\{price-holds\}\} cannot be written in: /,
    );
  });

  it("on a form the value does not have", () => {
    expect(() => writtenIn("{{rate:short}}", VALUES)).toThrow(/\{\{rate:short\}\}/);
    expect(() => writtenIn("{{release:words}}", VALUES)).toThrow(/release:words/);
    expect(() => writtenIn("{{waiting-at-most:number}}", VALUES)).toThrow(/waiting-at-most:number/);
    expect(() => writtenIn("{{price-holds:long}}", VALUES)).toThrow(/price-holds:long/);
    expect(() => writtenIn("{{silent-after:short}}", VALUES)).toThrow(/silent-after:short/);
  });

  it("on a name neither the build nor a deployment knows, in a code block as anywhere else", () => {
    expect(() => writtenIn("Pay within {{nothing}}.", VALUES)).toThrow(/\{\{nothing\}\}/);
    expect(() => writtenIn("```ts\nconst wait = {{nothing}};\n```\n", VALUES)).toThrow(
      /\{\{nothing\}\}/,
    );
  });

  it("on a name written in any other shape, rather than showing it to a reader", () => {
    for (const written of [
      "{{Quote-TTL}}",
      "{{QUOTE-TTL}}",
      "{{price_holds}}",
      "{{ price-holds }}",
      "{{price-holds:Short}}",
      "{{price-holds:}}",
      "{{release2}}",
      "{{price-holds",
    ]) {
      expect(() => writtenIn(`holds ${written} here`, VALUES), written).toThrow(written);
      expect(() => writtenIn(`holds ${written} here`, VALUES), written).toThrow(
        /is not written as a name/,
      );
    }
  });

  it("on a value a deployment fills given a capital or a form", () => {
    expect(() => writtenIn("at {{Origin}}", VALUES)).toThrow(
      /^\{\{Origin\}\}: a value a deployment fills/,
    );
    expect(() => writtenIn("at {{origin:short}}", VALUES)).toThrow(
      /^\{\{origin:short\}\}: a value a deployment fills/,
    );
  });

  it("naming the page it stopped on", () => {
    expect(() => writtenIn("Pay within {{nothing}}.", VALUES, "orders.md")).toThrow(
      /^orders\.md: \{\{nothing\}\}/,
    );
  });
});
