/**
 * A shop's HTML as the plain text a card carries.
 *
 * The promise to a merchant whose shop writes HTML: what reaches the publish
 * door is the text their own shop page shows, and it passes the door's rule
 * that a card's words are plain text — or the converter says, in words, what
 * in the text still is not, so the product is named and left in the shop
 * rather than refused for something the merchant cannot see.
 *
 * The inputs are the shapes WordPress really sends: prose wrapped in `<p>`,
 * block comments, punctuation turned into numbered references by wptexturize
 * and convert_chars, and names typed by hand.
 */

import { notPlainTextIn } from "@nuanu-ai/agentify-contracts";
import { describe, expect, it } from "vitest";
import { plainTextOfHtml } from "./html-text.js";

/** The text, where the converter says it is plain; a failure naming what it found otherwise. */
const textOf = (html: string): string => {
  const read = plainTextOfHtml(html);
  if (!read.plain) {
    throw new Error(`expected plain text from ${JSON.stringify(html)}: ${read.found.join("; ")}`);
  }
  // Whatever the converter calls plain, the door has to agree.
  expect(notPlainTextIn(read.text, "one line"), read.text).toStrictEqual([]);
  return read.text;
};

describe("a shop's HTML as plain text", () => {
  it("is the text of the paragraphs, without the markup", () => {
    expect(
      textOf("<p>Put a memorable weekend within reach.</p>\n<p>Valid for twelve months.</p>"),
    ).toBe("Put a memorable weekend within reach. Valid for twelve months.");
  });

  it("joins inline markup into the sentence it sits in", () => {
    expect(textOf("<p>A single-use access code <em>by email</em>.</p>")).toBe(
      "A single-use access code by email.",
    );
  });

  it("puts back the punctuation WordPress writes as numbered references", () => {
    // What wptexturize and convert_chars make of quotation marks, an
    // apostrophe, a dash and an ampersand typed in the editor.
    expect(textOf("&#8220;Chef&#8217;s table&#8221; &#8211; coffee &#038; brunch&#8230;")).toBe(
      "“Chef’s table” – coffee & brunch…",
    );
  });

  it("reads a non-breaking space as the space a reader sees", () => {
    expect(textOf("Coffee&nbsp;&amp;&nbsp;brunch")).toBe("Coffee & brunch");
    expect(textOf("<p>&nbsp;</p>")).toBe("");
  });

  it("reads every name HTML knows, not only the common ones", () => {
    // A name typed by hand into the editor, which WordPress passes through.
    expect(textOf("Caf&eacute; &euro;5 &copy; &trade; 25&deg;C &frac12; price")).toBe(
      "Café €5 © ™ 25°C ½ price",
    );
  });

  it("drops the comments a block editor leaves around every block", () => {
    expect(
      textOf(
        "<!-- wp:paragraph -->\n<p>Valid for six months.</p>\n<!-- /wp:paragraph -->\n" +
          '<!-- wp:image {"id":42} --><figure><img src="a.png" alt=""/></figure><!-- /wp:image -->',
      ),
    ).toBe("Valid for six months.");
    expect(textOf("Real text.<!-- a comment never closed")).toBe("Real text.");
  });

  it("drops what a browser does not show either", () => {
    expect(textOf("<script>alert('<p>')</script><p>Real text.</p>")).toBe("Real text.");
    expect(textOf("<style>p{color:red}</style>Real text.")).toBe("Real text.");
    expect(textOf("<!DOCTYPE html><?xml version='1.0'?>Real text.")).toBe("Real text.");
  });

  it("reads a tag whose attribute carries a bracket, either way round", () => {
    expect(textOf('<a title="a > b" href="/x">the shop</a>')).toBe("the shop");
    // The image block's own shape, with alt text a merchant wrote.
    expect(
      textOf('<figure><img src="x.png" alt="Mug <3 coffee"/></figure><p>A mug for tea.</p>'),
    ).toBe("A mug for tea.");
    expect(textOf("<a title='5<6'>five</a>")).toBe("five");
  });

  it("reads a tag whose quotation mark never closes", () => {
    expect(textOf("<p><img src=x.png alt=Mom's></p><p>A mug.</p>")).toBe("A mug.");
    expect(textOf("<p><a href=/x title=Don't>link</a> text</p>")).toBe("link text");
  });

  it("drops a hidden block whole even when its tag quotes a bracket", () => {
    expect(textOf('<style title="<">p{color:red}</style><p>Real.</p>')).toBe("Real.");
    expect(textOf('<script data-x="<">alert(1)</script><p>Real.</p>')).toBe("Real.");
    expect(textOf("<template data-x='a<b'><p>Hidden</p></template><p>Shown.</p>")).toBe("Shown.");
  });

  it("reads an empty comment the way a browser does", () => {
    expect(textOf("A<!-->B")).toBe("AB");
    expect(textOf("A<!--->B")).toBe("AB");
  });

  it("drops a template, which a browser keeps out of the page", () => {
    expect(textOf("<template><p>Not shown.</p></template><p>Shown.</p>")).toBe("Shown.");
  });

  it("never hands on a control character, however the shop wrote it", () => {
    // A numbered reference to a control character decodes into one, and a NUL
    // cannot even be stored. Written raw or as a number, what shows nothing is
    // left out and what spaces the text is a space.
    for (const html of [
      "Caf&#0;e",
      "Tea&#7;time",
      "Tea&#1;time",
      "Tea&#31;time",
      "Tea&#127;time",
      "Tea&#129;time",
      "Tea\u0007time",
      "Tea\u0000time",
      "Tea\u0085time",
    ]) {
      const text = textOf(html);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it looks for
      expect(text, JSON.stringify(html)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
    expect(textOf("Tea&#9;for&#10;two&#13;")).toBe("Tea for two");
    // A reference to nothing at all is what a browser shows for one: the
    // replacement character, visible on the shop's page as on the card.
    expect(textOf("Caf&#0;e")).toBe("Caf\uFFFDe");
  });

  it("reads each reference once", () => {
    // What the shop sends for a merchant who typed `&#038;` into their prose
    // is `&amp;#038;`, and the page shows the six characters they typed.
    const read = plainTextOfHtml("Type &amp;#038; for an ampersand");

    expect(read.text).toBe("Type &#038; for an ampersand");
  });

  it("says what is still not plain text where the shop's own page shows markup as text", () => {
    // A tag written into the prose as text, and a reference typed out, are what
    // the page shows — and what the door refuses. The converter does not guess
    // them away: it says what is there.
    const tag = plainTextOfHtml("<p>Adds a &lt;header&gt; block to the theme.</p>");
    const reference = plainTextOfHtml("Type &amp;#038; for an ampersand");

    expect(tag.plain).toBe(false);
    expect(tag.text).toBe("Adds a <header> block to the theme.");
    expect(tag.plain ? [] : tag.found).toStrictEqual(
      notPlainTextIn("Adds a <header> block to the theme.", "one line"),
    );
    expect(reference.plain).toBe(false);
    expect(reference.plain ? "" : reference.found.join(" ")).toContain('"&#038;"');
  });

  it("is empty for an empty page", () => {
    expect(textOf("")).toBe("");
    expect(textOf("<p></p>\n<br/>")).toBe("");
  });

  it("takes no longer on markup built to be slow than on an ordinary page", () => {
    // The HTML comes from a shop the merchant controls and the converter runs
    // in the same process as the gateway, so a page crafted to make a pattern
    // backtrack would stall everybody's sales, not only the merchant's import.
    // A quarter of a megabyte each, the size at which a pattern that has
    // turned quadratic takes seconds rather than milliseconds.
    const hostile = [
      `<a${" a".repeat(125_000)}`,
      "<a ".repeat(85_000),
      '<a "'.repeat(64_000),
      "<a '".repeat(64_000),
      "<a".repeat(125_000),
      "<script".repeat(36_000),
      "<script ".repeat(32_000),
      "<script>x".repeat(28_000),
      "<!--".repeat(64_000),
      "<!--x".repeat(50_000),
      `<a "${"x".repeat(250_000)}`,
      `<${"a".repeat(250_000)}`,
      `<a b="${"<a ".repeat(85_000)}`,
      // Short on purpose: a pattern that lets a quotation mark be read two
      // ways goes exponential here, and a synchronous match cannot be stopped,
      // so a long one would hang the run instead of failing it.
      `<a${' "x"'.repeat(20)}`,
      `<a${" 'x'".repeat(20)}`,
    ];
    const started = performance.now();
    for (const html of hostile) plainTextOfHtml(html);

    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
