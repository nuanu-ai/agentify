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
  const urls = [...body.matchAll(/<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi)]
    .slice(0, 5000)
    .map((match) => decodeXml(match[1]!.trim()))
    .filter((value) => /^https?:\/\//i.test(value));
  const lastmods = [
    ...body.matchAll(/<lastmod(?:\s[^>]*)?>([\s\S]*?)<\/lastmod>/gi),
  ]
    .slice(0, 5000)
    .map((match) => match[1]!.trim());
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
    return (
      value.length <= 10_000 &&
      value.every((entry) => validateJsonShape(entry, depth + 1))
    );
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      entries.length <= 10_000 &&
      entries.every(
        ([key, entry]) =>
          !blockedJsonKey.has(key) && validateJsonShape(entry, depth + 1),
      )
    );
  }
  return true;
};

export const parseSafeJson = (
  body: string,
  maxBytes = 1_048_576,
): unknown | undefined => {
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
  const graph = Array.isArray(record["@graph"])
    ? record["@graph"].flatMap(flattenJsonLd)
    : [];
  return [record, ...graph];
};

export const parseJsonLd = (html: string): JsonLdResult => {
  const scripts = [
    ...html.matchAll(
      /<script\b[^>]*type\s*=\s*["']application\/ld\+json(?:;[^"']*)?["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ];
  const nodes: Record<string, unknown>[] = [];
  let invalidCount = 0;
  for (const script of scripts) {
    const parsed = parseSafeJson(script[1]!, 524_288);
    if (parsed === undefined) invalidCount += 1;
    else nodes.push(...flattenJsonLd(parsed));
  }
  return { nodes, scriptCount: scripts.length, invalidCount };
};

export const jsonLdTypes = (node: Record<string, unknown>): string[] => {
  const type = node["@type"];
  if (typeof type === "string") return [type];
  return Array.isArray(type)
    ? type.filter((entry): entry is string => typeof entry === "string")
    : [];
};

export const visibleText = (html: string): string =>
  html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|quot|apos|lt|gt);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

export const htmlSignals = (html: string) => ({
  textLength: visibleText(html).length,
  hasH1: /<h1\b[^>]*>[^<]+/i.test(html),
  hasTitle: /<title\b[^>]*>[^<]+/i.test(html),
  hasPrice: /(?:[$€£¥]\s?\d|\d(?:[.,]\d{2})?\s?(?:USD|EUR|GBP|AUD|CAD))/i.test(
    html,
  ),
  productLinkCount: [
    ...html.matchAll(
      /<a\b[^>]*href=["'][^"']*(?:product|shop|item)[^"']*["']/gi,
    ),
  ].length,
  hreflangs: [
    ...html.matchAll(
      /<link\b[^>]*rel=["'][^"']*alternate[^"']*["'][^>]*hreflang=["']([^"']+)["'][^>]*>/gi,
    ),
  ].map((match) => match[1]!),
});

export const isChallenge = (status: number, body: string): boolean =>
  [401, 403, 429].includes(status) ||
  /captcha|cf-chl-|challenge-platform|access denied|verify you are human/i.test(
    body.slice(0, 64_000),
  );

export const comparableBodies = (left: string, right: string): boolean => {
  const a = visibleText(left).slice(0, 20_000).toLowerCase();
  const b = visibleText(right).slice(0, 20_000).toLowerCase();
  if (!a || !b) return false;
  const leftTokens = new Set(
    a.split(/\W+/).filter((token) => token.length > 3),
  );
  const rightTokens = new Set(
    b.split(/\W+/).filter((token) => token.length > 3),
  );
  if (!leftTokens.size || !rightTokens.size)
    return Math.min(a.length, b.length) / Math.max(a.length, b.length) >= 0.7;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap / Math.min(leftTokens.size, rightTokens.size) >= 0.55;
};
