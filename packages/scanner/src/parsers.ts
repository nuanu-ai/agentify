import { readHtml, type StartTag } from "./html.js";
import { asciiLower } from "./markup.js";
import { jsonLdPrice, type MarkedPrice, markedPrice, textPrice } from "./price.js";

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

// The text of each `<name>…</name>` element outside a comment, in turn, the
// opening tag allowed attributes after a space, up to `limit` of them. The
// next opening and the next comment are each looked for once and kept while
// they lie ahead, so a sitemap of many comments is walked once.
const elementTexts = (xml: string, lower: string, name: string, limit: number): string[] => {
  const opening = `<${name}`;
  const closing = `</${name}>`;
  const texts: string[] = [];
  let from = 0;
  let open = -2;
  let comment = -2;
  while (texts.length < limit) {
    if (open !== -1 && open < from) open = lower.indexOf(opening, from);
    if (open === -1) break;
    if (comment !== -1 && comment < from) comment = lower.indexOf("<!--", from);
    if (comment !== -1 && comment < open) {
      const end = lower.indexOf("-->", comment + 4);
      if (end === -1) break;
      from = end + 3;
      continue;
    }
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

// An element's text: a CDATA section's as written, any other with its
// entities decoded.
const xmlText = (text: string): string => {
  const value = text.trim();
  return value.startsWith("<![CDATA[") && value.endsWith("]]>")
    ? value.slice(9, -3).trim()
    : decodeXml(value);
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
    .map(xmlText)
    .filter((value) => /^https?:\/\//i.test(value));
  const lastmods = elementTexts(body, lower, "lastmod", 5000).map(xmlText);
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

export const jsonLdTypes = (node: Record<string, unknown>): string[] => {
  const type = node["@type"];
  if (typeof type === "string") return [type];
  return Array.isArray(type)
    ? type.filter((entry): entry is string => typeof entry === "string")
    : [];
};

// What the checks read of a page, all in one pass over it.
type PageReading = {
  text: string;
  hasTitle: boolean;
  hasH1: boolean;
  productLinkCount: number;
  hreflangs: string[];
  jsonLdScripts: string[];
  microdata: MarkedPrice;
  meta: MarkedPrice;
};

const PRODUCT_WORDS = ["product", "shop", "item"];
const VOID = new Set("area base br col embed hr img input link meta source track wbr".split(" "));
const MICRODATA_PRICES = ["price", "lowPrice", "highPrice"];
const META_AMOUNTS = ["product:price:amount", "og:price:amount"];
const META_CURRENCIES = ["product:price:currency", "og:price:currency"];
const SEEN = /\S/;
const SHADOW_ROOT_MODES = ["open", "closed"];
const DIGIT = /\p{Nd}/u;

const tokens = (value: string | undefined): string[] =>
  value ? value.split(/[\t\n\f\r ]+/).filter(Boolean) : [];

const isJsonLd = (tag: StartTag): boolean =>
  asciiLower(tag.attributes.get("type") ?? "")
    .split(";")[0]
    ?.trim() === "application/ld+json";

const walkPage = (html: string): PageReading => {
  const pieces: string[] = [];
  let joined = false;
  const reading: PageReading = {
    text: "",
    hasTitle: false,
    hasH1: false,
    productLinkCount: 0,
    hreflangs: [],
    jsonLdScripts: [],
    microdata: {},
    meta: {},
  };
  // Template content is inert, unless the template is a declarative shadow
  // root, which the browser attaches and shows. Navigation is not the page's
  // own content, and a microdata value without a content attribute is the
  // text of its element.
  const templates: boolean[] = [];
  let inert = 0;
  let nav = 0;
  let h1 = 0;
  let capture: { name: string; depth: number; key: keyof MarkedPrice; text: string } | undefined;
  const visible = (text: string) => {
    if (nav > 0) return;
    if (joined) pieces[pieces.length - 1] += text;
    else pieces.push(text);
    joined = true;
  };
  // The first amount that holds a digit, and the first currency written.
  const mark = (target: MarkedPrice, key: keyof MarkedPrice, value: string | undefined) => {
    if (value === undefined || target[key] !== undefined) return;
    if ((key === "amount" ? DIGIT : SEEN).test(value)) target[key] = value;
  };
  readHtml(html, {
    text: (text, foreign) => {
      if (inert > 0 || foreign) return;
      visible(text);
      if (h1 > 0 && SEEN.test(text)) reading.hasH1 = true;
      if (capture && capture.text.length < 200) capture.text += text;
    },
    startTag: (tag) => {
      joined = false;
      if (tag.name === "template") {
        const shadow = SHADOW_ROOT_MODES.includes(
          asciiLower(
            tag.attributes.get("shadowrootmode") ?? tag.attributes.get("shadowroot") ?? "",
          ),
        );
        templates.push(!shadow);
        if (!shadow) inert += 1;
      }
      if (inert > 0) return;
      if (capture?.name === tag.name && !VOID.has(tag.name)) capture.depth += 1;
      const { attributes } = tag;
      if (tag.name === "a") {
        const href = asciiLower(attributes.get("href") ?? "");
        if (PRODUCT_WORDS.some((word) => href.includes(word))) reading.productLinkCount += 1;
      }
      if (tag.foreign) return;
      if (tag.name === "nav") nav += 1;
      if (tag.name === "h1") h1 += 1;
      if (
        tag.name === "link" &&
        tokens(asciiLower(attributes.get("rel") ?? "")).includes("alternate")
      ) {
        const hreflang = attributes.get("hreflang");
        if (hreflang) reading.hreflangs.push(hreflang);
      }
      if (tag.name === "meta") {
        const property = asciiLower(attributes.get("property") ?? attributes.get("name") ?? "");
        if (META_AMOUNTS.includes(property))
          mark(reading.meta, "amount", attributes.get("content"));
        if (META_CURRENCIES.includes(property))
          mark(reading.meta, "currency", attributes.get("content"));
      }
      const itemprop = tokens(attributes.get("itemprop"));
      const key = itemprop.some((name) => MICRODATA_PRICES.includes(name))
        ? "amount"
        : itemprop.includes("priceCurrency")
          ? "currency"
          : undefined;
      if (!key || reading.microdata[key] !== undefined) return;
      const value = attributes.get("content") ?? attributes.get("value");
      if (value !== undefined) mark(reading.microdata, key, value);
      else if (!capture && !VOID.has(tag.name))
        capture = { name: tag.name, depth: 1, key, text: "" };
    },
    endTag: (name) => {
      joined = false;
      if (name === "template" && templates.pop()) inert -= 1;
      if (inert > 0) return;
      if (name === "nav" && nav > 0) nav -= 1;
      if (name === "h1" && h1 > 0) h1 -= 1;
      if (capture?.name === name && --capture.depth === 0) {
        mark(reading.microdata, capture.key, capture.text);
        capture = undefined;
      }
    },
    content: (tag, text) => {
      joined = false;
      if (inert > 0) return;
      if (tag.name === "script") {
        if (isJsonLd(tag)) reading.jsonLdScripts.push(text);
        return;
      }
      if (tag.name === "title" && SEEN.test(text)) reading.hasTitle = true;
      if (tag.name === "title" || tag.name === "textarea" || tag.name === "xmp") {
        visible(text);
        joined = false;
      }
    },
  });
  // Every run of whitespace becomes one space. A single space is left alone
  // rather than replaced by itself, which on a page of single-spaced words is
  // many times cheaper.
  reading.text = pieces
    .join(" ")
    .replace(/\s{2,}|[^\S ]/g, " ")
    .trim();
  return reading;
};

// The JSON-LD of a page's scripts, and each script's value as parsed, which
// is walked once where the flattened nodes would repeat a nested graph's
// members once for each graph around them.
const jsonLdOf = (scripts: readonly string[]): { jsonLd: JsonLdResult; values: unknown[] } => {
  const values: unknown[] = [];
  const nodes: Record<string, unknown>[] = [];
  let invalidCount = 0;
  for (const script of scripts) {
    const parsed = parseSafeJson(script, 524_288);
    if (parsed === undefined) invalidCount += 1;
    else {
      values.push(parsed);
      for (const node of flattenJsonLd(parsed)) nodes.push(node);
    }
  }
  return { jsonLd: { nodes, scriptCount: scripts.length, invalidCount }, values };
};

const signalsOf = (reading: PageReading, text: string, jsonLd: readonly unknown[]) => {
  const price =
    jsonLdPrice(jsonLd) ??
    markedPrice("microdata", reading.microdata) ??
    markedPrice("meta", reading.meta) ??
    textPrice(text);
  return {
    textLength: text.length,
    hasH1: reading.hasH1,
    hasTitle: reading.hasTitle,
    hasPrice: price !== undefined,
    price,
    productLinkCount: reading.productLinkCount,
    hreflangs: reading.hreflangs,
  };
};

/**
 * The JSON-LD of every `<script type="application/ld+json">` whose end the
 * page reaches. A script the page ends inside is not counted, since its JSON
 * is cut.
 */
export const parseJsonLd = (html: string): JsonLdResult =>
  jsonLdOf(walkPage(html).jsonLdScripts).jsonLd;

/**
 * The text a reader that runs no scripts sees: character data and the text
 * of `title` and `textarea`, without scripts, styles, comments, template
 * content, SVG or MathML, or navigation.
 */
export const visibleText = (html: string): string => walkPage(html).text;

// `text` is the page's visible text, for a caller that has read it already.
export const htmlSignals = (html: string, text?: string) => {
  const reading = walkPage(html);
  return signalsOf(reading, text ?? reading.text, jsonLdOf(reading.jsonLdScripts).values);
};

/**
 * What `visibleText`, `htmlSignals` and `parseJsonLd` say of a page, from one
 * pass over it and one parse of its JSON-LD.
 */
export const readPage = (html: string) => {
  const reading = walkPage(html);
  const { jsonLd, values } = jsonLdOf(reading.jsonLdScripts);
  return { text: reading.text, signals: signalsOf(reading, reading.text, values), jsonLd };
};

// A bot challenge served in place of the page: a 401, 403 or 429, or a
// vendor's interstitial mark on any status. Words such as "access denied"
// count only on an error status, since on a 200 they are as often a product's
// name or a help text. A page merely naming a captcha, as every Shopify page
// does, or loading Cloudflare's background detection, is the page itself.
export const isChallenge = (status: number, body: string): boolean => {
  const head = body.slice(0, 64_000);
  return (
    [401, 403, 429].includes(status) ||
    /px-captcha|captcha-delivery\.com|_cf_chl_opt/i.test(head) ||
    (status >= 400 && /access denied|verify you are human/i.test(head))
  );
};

// Whether two pages say much the same, given their visible text.
export const comparableTexts = (left: string, right: string): boolean => {
  const a = left.slice(0, 20_000).toLowerCase();
  const b = right.slice(0, 20_000).toLowerCase();
  if (!a || !b) return false;
  const leftTokens = new Set(a.split(/\W+/).filter((token) => token.length > 3));
  const rightTokens = new Set(b.split(/\W+/).filter((token) => token.length > 3));
  if (!leftTokens.size || !rightTokens.size)
    return Math.min(a.length, b.length) / Math.max(a.length, b.length) >= 0.7;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap / Math.min(leftTokens.size, rightTokens.size) >= 0.55;
};
