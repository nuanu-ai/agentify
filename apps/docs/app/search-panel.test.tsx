/**
 * A search result shows the words it was found by: the text around the
 * first match, cut at whole words, with every matched word marked.
 */

import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { excerptOf } from "./search-panel.js";

/** The excerpt as text, a marked word written `<mark>word</mark>`. */
const drawn = (text: string, terms: readonly string[]): string =>
  excerptOf(text, terms)
    .map((part: ReactNode) =>
      isValidElement<{ children: string }>(part) ? `<mark>${part.props.children}</mark>` : part,
    )
    .join("");

const TEXT =
  "Every order is closed by your handler. A courier hands the parcel over, and the handler " +
  "sends the tracking number with the carrier's name, which the agent passes to the buyer. " +
  "Nothing else is needed from you once the tracking number is sent.";

describe("a search result's excerpt", () => {
  it("marks every matched word, whatever its case", () => {
    expect(drawn(TEXT, ["tracking", "number"])).toContain(
      "<mark>tracking</mark> <mark>number</mark>",
    );
    expect(drawn("A Tracking number", ["tracking"])).toBe("A <mark>Tracking</mark> number");
  });

  it("starts near the first match, at a whole word, saying it was cut", () => {
    const excerpt = drawn(TEXT, ["courier"]);

    expect(excerpt).toContain("<mark>courier</mark>");
    expect(excerpt.startsWith("Every order")).toBe(true);
    const late = drawn(TEXT, ["needed"]);
    expect(late.startsWith("… ")).toBe(true);
    expect(late.replace(/<[^>]+>/g, "")).toMatch(/^… \S/);
    expect(TEXT).toContain(
      late
        .replace(/<[^>]+>/g, "")
        .replace(/^… /, "")
        .replace(/ …$/, ""),
    );
  });

  it("shows the start of the text when the match was in a heading", () => {
    expect(drawn(TEXT, ["refund"])).toMatch(/^Every order is closed/);
  });
});
