import { decodeHTML, decodeHTMLAttribute } from "entities";
import { asciiLower } from "./markup.js";

/**
 * A reader of a page's HTML that splits it the way the HTML standard's
 * tokenizer does, in time linear in the page's length.
 *
 * It follows the tokenizer's states: character references, attributes and
 * their quoting, comments, bogus comments and doctypes, the raw content of
 * script, style, title and the like (including the escaped comment states of
 * a script), and SVG or MathML content. Of tree construction it keeps only
 * what changes how the text is split: an HTML element's raw content is read
 * raw, an `svg` or `math` element opens foreign content, and the start tags
 * the standard lists close foreign content again. SVG's `foreignObject`,
 * `title` and `desc` are read as SVG, where a browser reads HTML inside them.
 * It reads the page as a reader that runs no scripts does, so `noscript`
 * holds ordinary markup.
 *
 * What the page ends inside of yields nothing: a tag, a comment, or the raw
 * content of an element whose end tag never comes. A page is cut at the
 * fetch limit, and what it was about to say there is unknown.
 */

export type StartTag = {
  /** The name, with A to Z lowered. */
  name: string;
  /** Each attribute by its lowered name, the first of a repeated name kept, its value decoded. */
  attributes: ReadonlyMap<string, string>;
  selfClosing: boolean;
  /** Whether the tag lies inside SVG or MathML content. */
  foreign: boolean;
};

type HtmlVisitor = {
  /** Character data between tags, its character references decoded. */
  text?: (text: string, foreign: boolean) => void;
  startTag?: (tag: StartTag) => void;
  endTag?: (name: string, foreign: boolean) => void;
  /**
   * The whole content of an element read raw, given once its end tag is read:
   * decoded for `title` and `textarea`, as written for `script`, `style`,
   * `xmp`, `iframe`, `noembed` and `noframes`. The element's end tag follows.
   */
  content?: (tag: StartTag, text: string) => void;
};

const RCDATA = new Set(["title", "textarea"]);
const RAWTEXT = new Set(["style", "xmp", "iframe", "noembed", "noframes"]);

// The start tags that end SVG or MathML content when they appear inside it.
const BREAKOUT = new Set(
  "b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var".split(
    " ",
  ),
);
const FONT_BREAKOUT = ["color", "face", "size"];

const isSpace = (code: number): boolean =>
  code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
const isAlpha = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const ends = (code: number): boolean => isSpace(code) || code === 47 || code === 62;
const UPPER = /[A-Z]/;
const lower = (name: string): string => (UPPER.test(name) ? asciiLower(name) : name);

type Tag = StartTag & { end: number };

// The tag whose name begins at `from`, up to and past its `>`, or undefined
// when the page ends inside it. An end tag's attributes are read past and
// dropped.
const readTag = (html: string, from: number, foreign: boolean, keep: boolean): Tag | undefined => {
  const length = html.length;
  let at = from;
  while (at < length && !ends(html.charCodeAt(at))) at += 1;
  const name = lower(html.slice(from, at));
  const attributes = new Map<string, string>();
  for (;;) {
    while (at < length && isSpace(html.charCodeAt(at))) at += 1;
    if (at >= length) return undefined;
    const code = html.charCodeAt(at);
    if (code === 62) return { name, attributes, selfClosing: false, foreign, end: at + 1 };
    if (code === 47) {
      at += 1;
      if (html.charCodeAt(at) === 62)
        return { name, attributes, selfClosing: true, foreign, end: at + 1 };
      continue;
    }
    // A name's first character may be `=`; after that `=` ends it.
    const nameStart = at;
    at += 1;
    while (at < length) {
      const next = html.charCodeAt(at);
      if (ends(next) || next === 61) break;
      at += 1;
    }
    const nameEnd = at;
    while (at < length && isSpace(html.charCodeAt(at))) at += 1;
    let value = "";
    if (html.charCodeAt(at) === 61) {
      at += 1;
      while (at < length && isSpace(html.charCodeAt(at))) at += 1;
      const quote = html.charCodeAt(at);
      if (quote === 34 || quote === 39) {
        const close = html.indexOf(quote === 34 ? '"' : "'", at + 1);
        if (close === -1) return undefined;
        value = html.slice(at + 1, close);
        at = close + 1;
      } else {
        const valueStart = at;
        while (at < length) {
          const next = html.charCodeAt(at);
          if (isSpace(next) || next === 62) break;
          at += 1;
        }
        value = html.slice(valueStart, at);
      }
    }
    if (!keep) continue;
    const key = lower(html.slice(nameStart, nameEnd));
    if (!attributes.has(key))
      attributes.set(key, value.includes("&") ? decodeHTMLAttribute(value) : value);
  }
};

// Whether `</name` followed by a space, `/` or `>` begins at `at`, any case.
const endTagNamed = (html: string, at: number, name: string): boolean =>
  html.charCodeAt(at) === 60 &&
  html.charCodeAt(at + 1) === 47 &&
  lower(html.slice(at + 2, at + 2 + name.length)) === name &&
  ends(html.charCodeAt(at + 2 + name.length));

const rawEnd = (html: string, name: string, from: number): number => {
  for (let at = html.indexOf("</", from); at !== -1; at = html.indexOf("</", at + 2))
    if (endTagNamed(html, at, name)) return at;
  return -1;
};

// Where the `</script` that ends a script's content begins, or -1. Inside
// `<!--` a script ends at `</script` as well, but a `<script` there starts a
// stretch where `</script` only returns to the comment, until `-->` ends both.
const scriptEnd = (html: string, from: number): number => {
  const length = html.length;
  let at = from;
  for (;;) {
    at = html.indexOf("<", at);
    if (at === -1) return -1;
    if (endTagNamed(html, at, "script")) return at;
    if (!html.startsWith("<!--", at)) {
      at += 1;
      continue;
    }
    // Inside the comment, with the dashes of `<!--` already counted.
    let dashes = 2;
    let doubled = false;
    for (at += 4; at < length; at += 1) {
      const code = html.charCodeAt(at);
      if (code === 45) {
        dashes += 1;
        continue;
      }
      if (code === 62 && dashes >= 2) break;
      dashes = 0;
      if (code !== 60) continue;
      if (!doubled && endTagNamed(html, at, "script")) return at;
      if (
        !doubled &&
        lower(html.slice(at + 1, at + 7)) === "script" &&
        ends(html.charCodeAt(at + 7))
      ) {
        doubled = true;
        at += 7;
      } else if (doubled && endTagNamed(html, at, "script")) {
        doubled = false;
        at += 8;
      }
    }
    if (at >= length) return -1;
    at += 1;
  }
};

const decodeText = (text: string): string => (text.includes("&") ? decodeHTML(text) : text);

const breaksOut = (tag: StartTag): boolean =>
  BREAKOUT.has(tag.name) ||
  (tag.name === "font" && FONT_BREAKOUT.some((name) => tag.attributes.has(name)));

export const readHtml = (html: string, visitor: HtmlVisitor): void => {
  const length = html.length;
  let foreign = 0;
  // Where the character data not yet given to the visitor begins, and where
  // the next `<` is looked for. A `<` that opens nothing stays in the text.
  let text = 0;
  let at = 0;
  const flush = (end: number) => {
    if (end > text) visitor.text?.(decodeText(html.slice(text, end)), foreign > 0);
  };
  // A comment ends at the first `-->` or `--!>`. Each is looked for once and
  // kept while it lies ahead: looking for the one a page never writes from
  // every comment would walk the rest of the page once per comment.
  const ahead = (needle: string) => {
    let found = -2;
    return (from: number): number => {
      if (found !== -1 && found < from) found = html.indexOf(needle, from);
      return found;
    };
  };
  const nextDashes = ahead("-->");
  const nextBang = ahead("--!>");
  for (let open = html.indexOf("<"); open !== -1; open = html.indexOf("<", at)) {
    const next = html.charCodeAt(open + 1);
    const opens = isAlpha(next) || next === 33 || next === 63 || (next === 47 && open + 2 < length);
    if (!opens) {
      at = open + 1;
      continue;
    }
    flush(open);
    if (isAlpha(next)) {
      const tag = readTag(html, open + 1, foreign > 0, true);
      if (!tag) return;
      at = tag.end;
      if (foreign > 0 && breaksOut(tag)) {
        foreign = 0;
        tag.foreign = false;
      }
      if (tag.name === "svg" || tag.name === "math") {
        if (!tag.selfClosing) foreign += 1;
      } else if (!tag.foreign && tag.name === "plaintext") {
        visitor.startTag?.(tag);
        if (at < length) visitor.text?.(html.slice(at), false);
        return;
      } else if (
        !tag.foreign &&
        (tag.name === "script" || RCDATA.has(tag.name) || RAWTEXT.has(tag.name))
      ) {
        visitor.startTag?.(tag);
        const end = tag.name === "script" ? scriptEnd(html, at) : rawEnd(html, tag.name, at);
        if (end === -1) return;
        const close = readTag(html, end + 2, false, false);
        if (!close) return;
        const content = html.slice(at, end);
        visitor.content?.(tag, RCDATA.has(tag.name) ? decodeText(content) : content);
        visitor.endTag?.(tag.name, false);
        at = text = close.end;
        continue;
      }
      visitor.startTag?.(tag);
    } else if (next === 47) {
      const after = html.charCodeAt(open + 2);
      if (isAlpha(after)) {
        const tag = readTag(html, open + 2, foreign > 0, false);
        if (!tag) return;
        at = tag.end;
        if (foreign > 0 && (tag.name === "br" || tag.name === "p")) foreign = 0;
        else if (foreign > 0 && (tag.name === "svg" || tag.name === "math")) foreign -= 1;
        visitor.endTag?.(tag.name, foreign > 0);
      } else if (after === 62) at = open + 3;
      else {
        const close = html.indexOf(">", open + 2);
        if (close === -1) return;
        at = close + 1;
      }
    } else if (html.startsWith("<!--", open)) {
      if (html.charCodeAt(open + 4) === 62) at = open + 5;
      else if (html.startsWith("->", open + 4)) at = open + 6;
      else {
        const dashes = nextDashes(open + 4);
        const banged = nextBang(open + 4);
        if (dashes === -1 && banged === -1) return;
        at = banged === -1 || (dashes !== -1 && dashes < banged) ? dashes + 3 : banged + 4;
      }
    } else if (next === 33 && foreign > 0 && html.startsWith("<![CDATA[", open)) {
      const close = html.indexOf("]]>", open + 9);
      if (close === -1) return;
      visitor.text?.(html.slice(open + 9, close), true);
      at = close + 3;
    } else {
      const close = html.indexOf(">", open + 2);
      if (close === -1) return;
      at = close + 1;
    }
    text = at;
  }
  flush(length);
};
