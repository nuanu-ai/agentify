/**
 * A card's own words are plain text, and the publish door refuses the ones
 * that are not rather than cleaning them.
 *
 * The promise to a merchant: text an agent will read — the title, the
 * description, and the title of each declared field — is refused at the
 * publish when it carries HTML markup, an HTML character reference or a
 * control character, and the refusal names what it found and where. Nothing
 * is rewritten on the way in, so what an agent reads is what the merchant
 * wrote. The promise to an agent is the same fact from the other side.
 *
 * The second promise is to the merchant whose card was stored before the rule:
 * reading it back, and serving it in the catalog, does not fail on its words.
 */

import { describe, expect, it } from "vitest";
import {
  CardSchema,
  MerchantCardSchema,
  notPlainTextIn,
  PublicCardSchema,
  publicCardOf,
  toJsonSchemas,
} from "./index.js";

const card = {
  merchant_item_id: "coffee-brunch",
  title: "Coffee and brunch for two",
  description: "A gift card for coffee, pastries or brunch from the seasonal menu.",
  price: { amount: "25.00", currency: "USD" },
  params: { email: { type: "string", required: true, title: "Where to send the card" } },
  result: { code: { type: "string", title: "The code to show at the counter" } },
  fulfillment: "sync",
};

/** The findings a publish of this card would come back with, by where they point. */
const findingsOf = (value: unknown): { path: string; message: string }[] => {
  const parsed = CardSchema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
};

/** The findings about one place on the card. */
const findingsAt = (value: unknown, path: string): string[] =>
  findingsOf(value)
    .filter((finding) => finding.path === path)
    .map((finding) => finding.message);

describe("a card's own words are plain text", () => {
  it("takes the ordinary characters that also begin markup and references", () => {
    // Precise, not paranoid: an ampersand between words, a comparison and an
    // arrow are text, and a merchant writing them is not writing HTML.
    for (const text of [
      "Tea & coffee",
      "A&B",
      "AT&T",
      "5 < 10 and 10 > 5",
      "x<y",
      "<3",
      "a -> b <- c",
      "Fish & chips < £10",
      "List< String >",
      "Write to <jane@example.com>",
      "Docs at <https://example.com/docs>",
      "&",
      "& more",
    ]) {
      expect(findingsOf({ ...card, title: text }), text).toStrictEqual([]);
      expect(findingsOf({ ...card, description: text }), text).toStrictEqual([]);
      expect(
        findingsOf({ ...card, result: { code: { type: "string", title: text } } }),
        text,
      ).toStrictEqual([]);
    }
  });

  it("keeps the words exactly as they were written", () => {
    // Accepting is not rewriting: nothing is decoded, escaped or trimmed.
    const written = { ...card, title: "Tea & coffee <3", description: "5 < 10 & 10 > 5" };

    expect(CardSchema.parse(written)).toStrictEqual(written);
  });

  it("refuses HTML markup in the title, naming what it found and where", () => {
    const [finding, ...rest] = findingsAt({ ...card, title: "Access <b>now</b>" }, "title");

    expect(rest.length, "one finding for one kind of thing").toBe(0);
    expect(finding).toContain('"<b>"');
    expect(finding).toContain("character 8");
    expect(finding).toContain("plain text");
  });

  it("refuses markup in the description", () => {
    const findings = findingsAt(
      { ...card, description: "<p>Valid for twelve months.</p>" },
      "description",
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('"<p>"');
    expect(findings[0]).toContain("character 1");
  });

  it("says how many places carry it, so the first one fixed is not taken for the last", () => {
    const [finding] = findingsAt({ ...card, description: "<p>One.</p><p>Two.</p>" }, "description");

    expect(finding).toContain("4");
    expect(finding).toContain('"<p>"');
  });

  it("refuses every shape a tag is written in", () => {
    for (const text of [
      "Line one<br>line two",
      "Line one<br/>line two",
      "Line one<br />line two",
      '<a href="https://example.com">the shop</a>',
      "<A HREF='x'>upper case</A>",
      "</p>",
      "<o:p></o:p>",
      "<custom-element>",
      '<p\nclass="x">split over lines</p>',
    ]) {
      expect(findingsAt({ ...card, description: text }, "description"), text).toHaveLength(1);
    }
  });

  it("refuses an HTML comment, the shape a block editor leaves behind", () => {
    const findings = findingsAt(
      { ...card, description: "<!-- wp:paragraph -->Valid for twelve months." },
      "description",
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('"<!--"');
    expect(findings[0]).toContain("character 1");
  });

  it("refuses character references, named and numbered", () => {
    for (const [text, reference] of [
      ["Coffee &amp; brunch", "&amp;"],
      ["Chef&#8217;s table", "&#8217;"],
      ["Chef&#x2019;s table", "&#x2019;"],
      ["Caf&eacute; brunch", "&eacute;"],
      ["Coffee&nbsp;brunch", "&nbsp;"],
    ] as const) {
      const findings = findingsAt({ ...card, title: text }, "title");

      expect(findings, text).toHaveLength(1);
      expect(findings[0]).toContain(`"${reference}"`);
    }
  });

  it("refuses a control character, and names it by its code rather than printing it", () => {
    for (const [text, code] of [
      ["Access\u0007now", "U+0007"],
      ["Access\u0000now", "U+0000"],
      ["Access\u007fnow", "U+007F"],
      ["Access\u0085now", "U+0085"],
      ["Access\u009bnow", "U+009B"],
      ["Access\tnow", "U+0009"],
      ["Access\rnow", "U+000D"],
    ] as const) {
      const findings = findingsAt({ ...card, description: text }, "description");

      expect(findings, JSON.stringify(text)).toHaveLength(1);
      expect(findings[0]).toContain(code);
      expect(findings[0]).toContain("character 7");
      expect(findings[0]).not.toContain(text.charAt(6));
    }
  });

  it("lets a description run to several lines, and holds a title to one", () => {
    // A description is prose of up to five hundred characters and may be
    // paragraphs; a line feed is the one line break every reader agrees on. A
    // title is the one line a catalog shows, and so is a field's title.
    const twoLines = "Valid for twelve months.\nBooking is required.";

    expect(findingsOf({ ...card, description: twoLines })).toStrictEqual([]);
    expect(findingsAt({ ...card, title: "One month\nof access" }, "title")[0]).toContain("U+000A");
    expect(
      findingsAt(
        { ...card, params: { email: { type: "string", title: "Where\nto send it" } } },
        "params.email.title",
      )[0],
    ).toContain("U+000A");
  });

  it("names each kind it found, in the one place it found them", () => {
    const findings = findingsAt(
      { ...card, description: "<p>Chef&#8217;s table\u0007</p>" },
      "description",
    );

    expect(findings).toHaveLength(3);
    expect(findings.join(" ")).toContain('"<p>"');
    expect(findings.join(" ")).toContain('"&#8217;"');
    expect(findings.join(" ")).toContain("U+0007");
  });

  it("holds the title of every declared field to the same rule", () => {
    const refused = {
      ...card,
      params: { email: { type: "string", title: "Where to send the <b>card</b>" } },
      result: { code: { type: "string", title: "The code &amp; its PIN" } },
    };

    expect(findingsAt(refused, "params.email.title")[0]).toContain('"<b>"');
    expect(findingsAt(refused, "result.code.title")[0]).toContain('"&amp;"');
  });

  it("finds a field's title written beside the short spelling of its neighbours", () => {
    const refused = {
      ...card,
      result: { code: "string", pin: { type: "string", title: "PIN&nbsp;code" } },
    };

    expect(findingsAt(refused, "result.pin.title")).toHaveLength(1);
  });

  it("reports it in the same pass as everything else wrong with the card", () => {
    // A merchant told one thing at a time fixes it, publishes again, and only
    // then learns the rest. The words are checked even when the shape is not
    // right yet.
    // A key of the wrong type is the kind of finding that stops zod checking
    // anything that looks at the card as a whole.
    const findings = findingsOf({
      ...card,
      merchant_item_id: 7,
      price: "5.00",
      title: "<b>Sale</b>",
    });

    expect(findings.map((finding) => finding.path)).toContain("merchant_item_id");
    expect(findings.map((finding) => finding.path)).toContain("price");
    expect(findings.map((finding) => finding.path)).toContain("title");
  });

  it("shortens a long fragment and says that it did", () => {
    const long = `<a href="https://example.com/${"x".repeat(200)}">the shop</a>`;
    const [finding] = findingsAt({ ...card, description: long }, "description");

    expect(finding).toContain("cut short");
    expect(finding?.length).toBeLessThan(400);
  });

  it("says in the card document what it refuses, for the reader who has only that", () => {
    const description = toJsonSchemas().card.description ?? "";

    expect(description).toContain("plain text");
    expect(description).toContain("markup");
    expect(description).toContain("reference");
  });
});

describe("a card stored before the rule", () => {
  // The rule is the publish door's. A card published before it may carry any
  // of what it refuses, and reading one back must not fail on its words: the
  // merchant's own list, the catalog an agent reads and every document in
  // between would otherwise fail whole over one old row.
  const stored = {
    ...card,
    title: "Coffee &#038; Brunch Gift Card",
    description: "<p>Treat someone to an unhurried morning.</p>\n<!-- wp:paragraph -->",
    result: { code: { type: "string", title: "The code&nbsp;to show" } },
  };

  it("reads back to its merchant whole", () => {
    const parsed = MerchantCardSchema.parse({
      id: "item_4d21bb",
      as_of: "2026-08-26T09:00:00Z",
      card: stored,
      selling: "open",
      paused: false,
    });

    expect(parsed.card.title).toBe(stored.title);
    expect(parsed.card.description).toBe(stored.description);
  });

  it("reaches an agent in the catalog as it was stored", () => {
    const projected = publicCardOf(stored as never, {
      id: "item_4d21bb",
      as_of: "2026-08-26T09:00:00Z",
    });

    expect(PublicCardSchema.parse(projected).title).toBe(stored.title);
  });

  it("is still refused when it is published again", () => {
    // The negative control for the two above: the same card through the door.
    expect(findingsAt(stored, "title")).toHaveLength(1);
    expect(findingsAt(stored, "description").length).toBeGreaterThan(0);
  });
});

describe("the rule, for a connector that turns a shop's pages into cards", () => {
  // A shop connector converts the shop's HTML into text before the text
  // reaches the door, and it asks the door's own rule whether it succeeded, so
  // there is one definition of plain text rather than two that drift.
  it("finds nothing in plain text", () => {
    expect(notPlainTextIn("Coffee & brunch, 5 < 10", "one line")).toStrictEqual([]);
    expect(notPlainTextIn("Two\nlines", "several lines")).toStrictEqual([]);
  });

  it("names what it found, one kind at a time", () => {
    const found = notPlainTextIn("Adds a <header> block &amp; more", "one line");

    expect(found).toHaveLength(2);
    expect(found.join(" ")).toContain('"<header>"');
    expect(found.join(" ")).toContain('"&amp;"');
  });

  it("holds one line to one line", () => {
    expect(notPlainTextIn("Two\nlines", "one line")).toHaveLength(1);
  });
});
