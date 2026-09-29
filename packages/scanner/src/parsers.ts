import {
  asciiLower,
  findTag,
  isQuote,
  nextQuote,
  nextTag,
  quotedValues,
  type Span,
} from "./markup.js";

export type SitemapResult = {
  valid: boolean;
  isIndex: boolean;
  urls: string[];
  lastmods: string[];
  errorCode?: string;
};

const decodeXml = (value: string): string =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

const SPACE = /\s/;

// The text of each `<name>…</name>` element in turn, the opening tag allowed
// attributes after a space, up to `limit` of them.
const elementTexts = (xml: string, lower: string, name: string, limit: number): string[] => {
  const opening = `<${name}`;
  const closing = `</${name}>`;
  const texts: string[] = [];
  let from = 0;
  while (texts.length < limit) {
    const open = lower.indexOf(opening, from);
    if (open === -1) break;
    const next = lower.charAt(open + opening.length);
    if (next !== ">" && !SPACE.test(next)) {
      from = open + 1;
      continue;
    }
    const close = lower.indexOf(">", open + opening.length);
    if (close === -1) break;
    const end = lower.indexOf(closing, close + 1);
    if (end === -1) break;
    texts.push(xml.slice(close + 1, end));
    from = end + closing.length;
  }
  return texts;
};

export const parseSitemap = (body: string): SitemapResult => {
  if (/<!DOCTYPE|<!ENTITY/i.test(body))
    return {
      valid: false,
      isIndex: false,
      urls: [],
      lastmods: [],
      errorCode: "xml_entity_blocked",
    };
  const isIndex = /<\s*sitemapindex(?:\s|>)/i.test(body);
  const isUrlSet = /<\s*urlset(?:\s|>)/i.test(body);
  if (!isIndex && !isUrlSet)
    return {
      valid: false,
      isIndex: false,
      urls: [],
      lastmods: [],
      errorCode: "invalid_sitemap_xml",
    };
  const lower = asciiLower(body);
  const urls = elementTexts(body, lower, "loc", 5000)
    .map((text) => decodeXml(text.trim()))
    .filter((value) => /^https?:\/\//i.test(value));
  const lastmods = elementTexts(body, lower, "lastmod", 5000).map((text) => text.trim());
  return {
    valid: urls.length > 0,
    isIndex,
    urls,
    lastmods,
    errorCode: urls.length ? undefined : "sitemap_empty",
  };
};

const blockedJsonKey = new Set(["__proto__", "prototype", "constructor"]);

const validateJsonShape = (value: unknown, depth = 0): boolean => {
  if (depth > 40) return false;
  if (Array.isArray(value))
    return value.length <= 10_000 && value.every((entry) => validateJsonShape(entry, depth + 1));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      entries.length <= 10_000 &&
      entries.every(
        ([key, entry]) => !blockedJsonKey.has(key) && validateJsonShape(entry, depth + 1),
      )
    );
  }
  return true;
};

export const parseSafeJson = (body: string, maxBytes = 1_048_576): unknown | undefined => {
  if (Buffer.byteLength(body) > maxBytes) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return validateJsonShape(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

export type JsonLdResult = {
  nodes: Record<string, unknown>[];
  scriptCount: number;
  invalidCount: number;
};

const flattenJsonLd = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const graph = Array.isArray(record["@graph"]) ? record["@graph"].flatMap(flattenJsonLd) : [];
  return [record, ...graph];
};

const SPACES = /\s*/y;
const pastSpaces = (text: string, from: number): number => {
  SPACES.lastIndex = from;
  SPACES.test(text);
  return SPACES.lastIndex;
};

const JSON_LD = "application/ld+json";
const SCRIPT_END = "</script>";

// Where each JSON-LD type the script tag declares ends, at its closing quote,
// in order: `type`, an `=` with or without spaces around it, and a quoted
// application/ld+json that may carry parameters after a `;`, which run to the
// next quote wherever it is.
const jsonLdTypeEnds = (lower: string, tag: Span): number[] => {
  const text = lower.slice(tag.start, tag.end);
  const ends: number[] = [];
  for (let at = text.indexOf("type"); at !== -1; at = text.indexOf("type", at + 1)) {
    const equals = pastSpaces(text, at + 4);
    if (text.charAt(equals) !== "=") continue;
    const quote = pastSpaces(text, equals + 1);
    if (!isQuote(text.charCodeAt(quote)) || !text.startsWith(JSON_LD, quote + 1)) continue;
    const after = tag.start + quote + 1 + JSON_LD.length;
    const end = lower.charAt(after) === ";" ? nextQuote(lower, after + 1) : after;
    if (isQuote(lower.charCodeAt(end))) ends.push(end);
  }
  return ends;
};

// Where the JSON-LD of a script tag lies. The last type is tried first, and it
// alone can end past the tag's `>`: its text then begins after the first `>`
// past its closing quote. With any other type, the text begins after the
// tag's `>`. It ends at the first `</script>` after it begins, and there must
// be one: `lastEnd` is where the last one in the page begins.
const jsonLdText = (lower: string, tag: Span, lastEnd: number): Span | undefined => {
  const ends = jsonLdTypeEnds(lower, tag);
  const last = ends.at(-1);
  if (last === undefined) return undefined;
  if (last > tag.end) {
    const close = lower.indexOf(">", last);
    if (close !== -1 && lastEnd > close)
      return { start: close + 1, end: lower.indexOf(SCRIPT_END, close + 1) };
    if (ends.length === 1) return undefined;
  }
  return lastEnd > tag.end
    ? { start: tag.end + 1, end: lower.indexOf(SCRIPT_END, tag.end + 1) }
    : undefined;
};

export const parseJsonLd = (html: string): JsonLdResult => {
  const lower = asciiLower(html);
  const lastEnd = lower.lastIndexOf(SCRIPT_END);
  const nodes: Record<string, unknown>[] = [];
  let scriptCount = 0;
  let invalidCount = 0;
  for (let tag = nextTag(lower, "script", 0); tag; ) {
    const text = jsonLdText(lower, tag, lastEnd);
    if (!text) {
      tag = nextTag(lower, "script", tag.end + 1);
      continue;
    }
    scriptCount += 1;
    const parsed = parseSafeJson(html.slice(text.start, text.end), 524_288);
    if (parsed === undefined) invalidCount += 1;
    else for (const node of flattenJsonLd(parsed)) nodes.push(node);
    tag = nextTag(lower, "script", text.end + SCRIPT_END.length);
  }
  return { nodes, scriptCount, invalidCount };
};

export const jsonLdTypes = (node: Record<string, unknown>): string[] => {
  const type = node["@type"];
  if (typeof type === "string") return [type];
  return Array.isArray(type)
    ? type.filter((entry): entry is string => typeof entry === "string")
    : [];
};

// The text with each `<name>…</name>` element replaced by a space, the first
// closing tag after an opening one ending it.
const withoutElements = (text: string, name: string): string => {
  const lower = asciiLower(text);
  const closing = `</${name}>`;
  const kept: string[] = [];
  let from = 0;
  for (let open = findTag(lower, name, 0); open !== -1; open = findTag(lower, name, from)) {
    const end = lower.indexOf(closing, open + name.length + 1);
    if (end === -1) break;
    kept.push(text.slice(from, open), " ");
    from = end + closing.length;
  }
  kept.push(text.slice(from));
  return kept.join("");
};

// The text with each tag, a `<`, at least one character and the first `>`
// after it, replaced by a space.
const withoutTags = (text: string): string => {
  const kept: string[] = [];
  let from = 0;
  for (let open = text.indexOf("<"); open !== -1; ) {
    const close = text.indexOf(">", open + 1);
    if (close === -1) break;
    if (close === open + 1) {
      open = text.indexOf("<", close);
      continue;
    }
    kept.push(text.slice(from, open), " ");
    from = close + 1;
    open = text.indexOf("<", from);
  }
  kept.push(text.slice(from));
  return kept.join("");
};

// Every run of whitespace becomes one space. A run that is already one space
// is left alone rather than replaced by itself: on a page made of single
// spaces between words, replacing each one cost forty times as much.
export const visibleText = (html: string): string =>
  withoutTags(withoutElements(withoutElements(withoutElements(html, "script"), "style"), "nav"))
    .replace(/&(?:nbsp|amp|quot|apos|lt|gt);/gi, " ")
    .replace(/\s{2,}|[^\S ]/g, " ")
    .trim();

// Whether some `<name>` tag is followed right after its `>` by text rather
// than by another tag.
const opensOnText = (lower: string, name: string): boolean => {
  for (let tag = nextTag(lower, name, 0); tag; tag = nextTag(lower, name, tag.end + 1))
    if (tag.end + 1 < lower.length && lower.charAt(tag.end + 1) !== "<") return true;
  return false;
};

const PRODUCT_WORDS = ["product", "shop", "item"];

// The `<a>` tags with an href that names a product, a shop or an item. The
// last such href in a tag may run past its `>`, and the tag is then read up
// to that href's closing quote.
const productLinkCount = (lower: string): number => {
  let count = 0;
  for (let tag = nextTag(lower, "a", 0); tag; ) {
    const link = quotedValues(lower, "href=", tag)
      .filter((href) => {
        const address = lower.slice(href.start, href.end);
        return PRODUCT_WORDS.some((word) => address.includes(word));
      })
      .at(-1);
    if (link) count += 1;
    tag = nextTag(lower, "a", Math.max(tag.end, link?.end ?? 0) + 1);
  }
  return count;
};

type Capture = Span & { after: number };

// The last non-empty hreflang value whose `hreflang=` lies within `within`,
// and where the tag that holds it ends: at the first `>` after its closing
// quote, which must exist.
const lastHreflang = (lower: string, within: Span): Capture | undefined => {
  const values = quotedValues(lower, "hreflang=", within).filter(
    (value) => value.end > value.start,
  );
  const last = values.at(-1);
  if (!last) return undefined;
  if (last.end < within.end) return { ...last, after: within.end + 1 };
  const close = lower.indexOf(">", last.end);
  if (close !== -1) return { ...last, after: close + 1 };
  const previous = values.at(-2);
  return previous && { ...previous, after: within.end + 1 };
};

// The hreflang a `<link>` declares after a rel that includes alternate. The
// last such rel is tried first, and it alone can run past the tag's `>`: the
// hreflang is then looked for up to the first `>` after it. Otherwise the
// hreflang is the last one after the first such rel, and there is none when
// that rel is the one that ran past.
const hreflangOf = (lower: string, tag: Span): Capture | undefined => {
  const rels = quotedValues(lower, "rel=", tag).filter((rel) =>
    lower.slice(rel.start, rel.end).includes("alternate"),
  );
  const last = rels.at(-1);
  if (last && last.end > tag.end) {
    const close = lower.indexOf(">", last.end);
    const found =
      close === -1 ? undefined : lastHreflang(lower, { start: last.end + 1, end: close });
    if (found) return found;
  }
  const first = rels[0];
  return first && lastHreflang(lower, { start: first.end + 1, end: tag.end });
};

const hreflangs = (html: string, lower: string): string[] => {
  const found: string[] = [];
  for (let tag = nextTag(lower, "link", 0); tag && tag.end < lower.length; ) {
    const hreflang = hreflangOf(lower, tag);
    if (hreflang) found.push(html.slice(hreflang.start, hreflang.end));
    tag = nextTag(lower, "link", hreflang?.after ?? tag.end + 1);
  }
  return found;
};

export const htmlSignals = (html: string) => {
  const lower = asciiLower(html);
  return {
    textLength: visibleText(html).length,
    hasH1: opensOnText(lower, "h1"),
    hasTitle: opensOnText(lower, "title"),
    hasPrice: /(?:[$€£¥]\s?\d|\d(?:[.,]\d{2})?\s?(?:USD|EUR|GBP|AUD|CAD))/i.test(html),
    productLinkCount: productLinkCount(lower),
    hreflangs: hreflangs(html, lower),
  };
};

export const isChallenge = (status: number, body: string): boolean =>
  [401, 403, 429].includes(status) ||
  /captcha|cf-chl-|challenge-platform|access denied|verify you are human/i.test(
    body.slice(0, 64_000),
  );

export const comparableBodies = (left: string, right: string): boolean => {
  const a = visibleText(left).slice(0, 20_000).toLowerCase();
  const b = visibleText(right).slice(0, 20_000).toLowerCase();
  if (!a || !b) return false;
  const leftTokens = new Set(a.split(/\W+/).filter((token) => token.length > 3));
  const rightTokens = new Set(b.split(/\W+/).filter((token) => token.length > 3));
  if (!leftTokens.size || !rightTokens.size)
    return Math.min(a.length, b.length) / Math.max(a.length, b.length) >= 0.7;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap / Math.min(leftTokens.size, rightTokens.size) >= 0.55;
};
