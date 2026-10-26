import { readHtml, type StartTag } from "./html.js";
import { asciiLower } from "./markup.js";
import { type MarkedPrice, markedPrice, offerPrice, textPrice } from "./price.js";

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
  productFeed: boolean;
  product: boolean;
  availability: boolean;
};

const PRODUCT_WORDS = ["product", "shop", "item"];
const VOID = new Set("area base br col embed hr img input link meta source track wbr".split(" "));
const MICRODATA_PRICES = ["price", "lowPrice", "highPrice"];
const META_AMOUNTS = ["product:price:amount", "og:price:amount"];
const META_CURRENCIES = ["product:price:currency", "og:price:currency"];
const SEEN = /\S/;
const SHADOW_ROOT_MODES = ["open", "closed"];
// A link declares a feed by its media type or by the file it names.
const FEED_TYPES = [
  "application/rss+xml",
  "application/atom+xml",
  "application/xml",
  "text/xml",
  "text/csv",
  "text/tab-separated-values",
];
const FEED_FILE = /\.(?:xml|rss|atom|csv|tsv)$/;
// The feed is the shop's products' when a word of its title or address
// names them (product, Produk, produits, Produkte, prodotti, catalog,
// Katalog, catálogo, merchant), or when its address is in the shop's base,
// in the languages WooCommerce shops write it. A title is the site's name
// too, which may say "shop", so a title counts by the first kind of word
// alone.
const PRODUCT_WORD = /^(?:produ|prodott|cat[aá]log|katalog|merchant)/;
const SHOP_BASES = new Set([
  "shop",
  "store",
  "toko",
  "boutique",
  "tienda",
  "negozio",
  "loja",
  "laden",
  "collections",
]);
// An address as written, where its escapes are well formed.
const decoded = (address: string): string => {
  try {
    return decodeURIComponent(address);
  } catch {
    return address;
  }
};
// A feed titled as one of comments, in the words WordPress titles it with.
const COMMENTS = /comment|koment|kommentar|coment/;
const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
// Microdata properties that identify a product.
const PRODUCT_PROPERTIES = [
  "sku",
  "gtin",
  "gtin8",
  "gtin12",
  "gtin13",
  "gtin14",
  "mpn",
  "productID",
];
const PRODUCT_TYPE = /^https?:\/\/schema\.org\/product$/;

// Whether a `<link>` declares a feed of the shop's products. A page's own
// address plus `feed/` is where WordPress puts the feed of that page's
// comments, a product's reviews among them, so it counts only when its
// title names products, as a shop page's own products feed does. The host
// is left out, since it may name the shop rather than the feed.
const declaresProductFeed = (attributes: ReadonlyMap<string, string>, page?: URL): boolean => {
  if (!tokens(asciiLower(attributes.get("rel") ?? "")).includes("alternate")) return false;
  if (attributes.has("hreflang")) return false;
  let address: URL;
  try {
    address = new URL(attributes.get("href") ?? "", page ?? "https://page.invalid/");
  } catch {
    return false;
  }
  const path = address.pathname.toLowerCase();
  const type =
    asciiLower(attributes.get("type") ?? "")
      .split(";")[0]
      ?.trim() ?? "";
  if (!FEED_TYPES.includes(type) && !FEED_FILE.test(path)) return false;
  const title = attributes.get("title") ?? "";
  if (COMMENTS.test(title.toLowerCase())) return false;
  const titled = words(title).some((word) => PRODUCT_WORD.test(word));
  if (page && address.origin === page.origin) {
    const own = page.pathname.toLowerCase();
    if (path === `${own.endsWith("/") ? own : `${own}/`}feed/`) return titled;
  }
  return (
    titled ||
    words(decoded(path + address.search)).some(
      (word) => PRODUCT_WORD.test(word) || SHOP_BASES.has(word),
    )
  );
};
const DIGIT = /\p{Nd}/u;

const tokens = (value: string | undefined): string[] =>
  value ? value.split(/[\t\n\f\r ]+/).filter(Boolean) : [];

const isJsonLd = (tag: StartTag): boolean =>
  asciiLower(tag.attributes.get("type") ?? "")
    .split(";")[0]
    ?.trim() === "application/ld+json";

const walkPage = (html: string, url?: string): PageReading => {
  let page: URL | undefined;
  try {
    page = url === undefined ? undefined : new URL(url);
  } catch {
    page = undefined;
  }
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
    productFeed: false,
    product: false,
    availability: false,
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
        if (declaresProductFeed(attributes, page)) reading.productFeed = true;
      }
      if (tag.name === "meta") {
        const property = asciiLower(attributes.get("property") ?? attributes.get("name") ?? "");
        const content = attributes.get("content");
        if (META_AMOUNTS.includes(property)) mark(reading.meta, "amount", content);
        if (META_CURRENCIES.includes(property)) mark(reading.meta, "currency", content);
        // Open Graph's product type, and the tags of its product namespace.
        if (
          (property === "og:type" &&
            asciiLower(content ?? "")
              .trim()
              .startsWith("product")) ||
          property.startsWith("product:")
        )
          reading.product = true;
        if (
          (property === "product:availability" || property === "og:availability") &&
          SEEN.test(content ?? "")
        )
          reading.availability = true;
      }
      const itemprop = tokens(attributes.get("itemprop"));
      if (
        itemprop.some((name) => PRODUCT_PROPERTIES.includes(name)) ||
        tokens(asciiLower(attributes.get("itemtype") ?? "")).some((type) => PRODUCT_TYPE.test(type))
      )
        reading.product = true;
      if (itemprop.includes("availability")) reading.availability = true;
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

const isProduct = (record: Record<string, unknown>): boolean =>
  jsonLdTypes(record).some((type) => /(?:^|[/:])Product(?:Group)?$/.test(type));
const statesAvailability = (record: Record<string, unknown>): boolean =>
  typeof record.availability === "string" && SEEN.test(record.availability);

// What the JSON-LD states, from one walk over each script's value: the first
// price an offer states, whether a product is declared, and whether an
// availability is stated, at any depth.
const jsonLdFacts = (values: readonly unknown[]) => {
  let price: ReturnType<typeof offerPrice>;
  let product = false;
  let availability = false;
  const pending: unknown[] = [...values];
  for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
    if (Array.isArray(value)) pending.push(...value);
    else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      price ??= offerPrice(record);
      product ||= isProduct(record);
      availability ||= statesAvailability(record);
      if (price && product && availability) break;
      pending.push(...Object.values(record));
    }
  }
  return { price, product, availability };
};

const signalsOf = (reading: PageReading, jsonLd: readonly unknown[]) => {
  const stated = jsonLdFacts(jsonLd);
  const price =
    stated.price ??
    markedPrice("microdata", reading.microdata) ??
    markedPrice("meta", reading.meta) ??
    textPrice(reading.text);
  return {
    textLength: reading.text.length,
    hasH1: reading.hasH1,
    hasTitle: reading.hasTitle,
    hasPrice: price !== undefined,
    price,
    productLinkCount: reading.productLinkCount,
    hreflangs: reading.hreflangs,
    /** A link to a feed of the shop's products. */
    productFeed: reading.productFeed,
    /** A product declared in Open Graph, microdata or JSON-LD. */
    describesProduct: reading.product || stated.product,
    /** A price or an availability stated in structured data. */
    statesOffer:
      (price !== undefined && price.source !== "text") ||
      reading.availability ||
      stated.availability,
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
 * What the checks read of a page, from one pass over it and one parse of its
 * JSON-LD: the text a reader that runs no scripts sees (character data and
 * the text of `title` and `textarea`, without scripts, styles, comments,
 * template content, SVG or MathML, or navigation), the page's signals, and
 * its JSON-LD as `parseJsonLd` reads it. `url` is the page's address, which
 * tells the feed of its own comments from a feed of the shop's products.
 */
export const readPage = (html: string, url?: string) => {
  const reading = walkPage(html, url);
  const { jsonLd, values } = jsonLdOf(reading.jsonLdScripts);
  return { text: reading.text, signals: signalsOf(reading, values), jsonLd };
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
