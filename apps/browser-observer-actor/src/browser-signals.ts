import { createHash } from "node:crypto";

import type { Page } from "playwright";

export type MetadataSnapshot = {
  canonical: string | null;
  hreflangCount: number;
  jsonLdCount: number;
  currencies: string[];
  availability: string[];
  priceCount: number;
  hasContact: boolean;
  hasOpeningHours: boolean;
};

export type PageSignals = {
  renderedTextChars: number;
  rawTextChars: number;
  landmarkCounts: Record<string, number>;
  headingLevelCounts: Record<string, number>;
  interactiveControlCount: number;
  unnamedControlCount: number;
  formControlCount: number;
  unlabeledFormControlCount: number;
  formSemanticIssueCount: number;
  webmcpPresent: boolean;
  webmcpToolCount: number;
  challengeKind: string | null;
  hiddenInstructionCount: number;
  apiDiscoveryCount: number;
  licenseLinkCount: number;
  ariaRoleCounts: Record<string, number>;
  renderedMetadata: MetadataSnapshot;
  rawMetadata: MetadataSnapshot;
  visibleFacts: {
    currencies: string[];
    availability: string[];
  };
  titleSignature: string;
};

const decodeEntities = (value: string): string =>
  value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_match, hex, decimal) => {
      const value = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : " ";
    });

// The raw HTML is bounded only by the run's byte budget, and reading it is
// synchronous work no deadline can interrupt. A regular expression that looks
// for a closer from every opener is quadratic on a page of openers that never
// close — `<!--` repeated for 256 KiB took ten seconds — so the markup is
// walked with indexOf instead, and a construct left open ends the walk: once
// one opener finds no closer, none after it can either. Names are compared
// with ASCII letters folded, as the case-insensitive expressions this
// replaces did, and nothing else is folded.

const RAW_TEXT_ELEMENTS = ["script", "style", "noscript", "template"] as const;
const STRUCTURED_DATA_TYPE = "application/ld+json";

/** What `\s` matches, and `trim` removes: white space and line terminators. */
const isWhitespaceCode = (code: number): boolean =>
  code === 32 ||
  (code >= 9 && code <= 13) ||
  code === 0xa0 ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200a) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x202f ||
  code === 0x205f ||
  code === 0x3000 ||
  code === 0xfeff;

const isWordCode = (code: number): boolean =>
  (code >= 48 && code <= 57) ||
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  code === 95;

/** Whether the lowercase ASCII `word` is at `index`, ASCII letters compared without case. */
const hasWordAt = (text: string, index: number, word: string): boolean => {
  if (index < 0 || index + word.length > text.length) return false;
  for (let offset = 0; offset < word.length; offset += 1) {
    const code = text.charCodeAt(index + offset);
    if ((code >= 65 && code <= 90 ? code + 32 : code) !== word.charCodeAt(offset)) return false;
  }
  return true;
};

/** Whether `name` is at `index` and ends there as a word does. */
const hasNameAt = (text: string, index: number, name: string): boolean =>
  hasWordAt(text, index, name) &&
  (index + name.length >= text.length || !isWordCode(text.charCodeAt(index + name.length)));

/** Where the first `</name>` of one of `names` at or after `from` ends, or -1. */
const closerEnd = (text: string, from: number, names: readonly string[]): number => {
  for (let at = text.indexOf("</", from); at !== -1; at = text.indexOf("</", at + 1)) {
    for (const name of names) {
      if (hasWordAt(text, at + 2, name) && text.charCodeAt(at + 2 + name.length) === 62) {
        return at + 3 + name.length;
      }
    }
  }
  return -1;
};

/** Each comment replaced by a space. */
const withoutComments = (html: string): string => {
  const parts: string[] = [];
  let position = 0;
  for (let open = html.indexOf("<!--"); open !== -1; open = html.indexOf("<!--", position)) {
    const close = html.indexOf("-->", open + 4);
    if (close === -1) break;
    parts.push(html.slice(position, open), " ");
    position = close + 3;
  }
  parts.push(html.slice(position));
  return parts.join("");
};

const rawTextElementAt = (text: string, index: number): string | undefined => {
  // Most brackets open something else: `s`, `n` and `t`, in either case, are
  // the only letters a raw-text element's name starts with.
  const first = text.charCodeAt(index) | 0x20;
  if (first !== 115 && first !== 110 && first !== 116) return undefined;
  for (const name of RAW_TEXT_ELEMENTS) {
    if (hasNameAt(text, index, name)) return name;
  }
  return undefined;
};

/** Each script, style, noscript and template element, with its content, replaced by a space. */
const withoutRawTextElements = (html: string): string => {
  const parts: string[] = [];
  let position = 0;
  for (let open = html.indexOf("<"); open !== -1; open = html.indexOf("<", open + 1)) {
    const name = rawTextElementAt(html, open + 1);
    if (name === undefined) continue;
    const tagEnd = html.indexOf(">", open + 1 + name.length);
    if (tagEnd === -1) break;
    const end = closerEnd(html, tagEnd + 1, RAW_TEXT_ELEMENTS);
    if (end === -1) break;
    parts.push(html.slice(position, open), " ");
    position = end;
    open = end - 1;
  }
  parts.push(html.slice(position));
  return parts.join("");
};

/** Each tag replaced by a space; `<>` is not a tag. */
const withoutTags = (html: string): string => {
  const parts: string[] = [];
  let position = 0;
  for (let open = html.indexOf("<"); open !== -1; open = html.indexOf("<", open + 1)) {
    const close = html.indexOf(">", open + 1);
    if (close === -1) break;
    if (close === open + 1) continue;
    parts.push(html.slice(position, open), " ");
    position = close + 1;
    open = close;
  }
  parts.push(html.slice(position));
  return parts.join("");
};

/** The length of `text` with each run of white space made one space, and trimmed. */
const collapsedLength = (text: string): number => {
  let length = 0;
  let spaceBefore = false;
  for (let index = 0; index < text.length; index += 1) {
    if (isWhitespaceCode(text.charCodeAt(index))) {
      spaceBefore = length > 0;
    } else {
      length += spaceBefore ? 2 : 1;
      spaceBefore = false;
    }
  }
  return length;
};

export const rawTextCharacterCount = (html: string): number =>
  collapsedLength(decodeEntities(withoutTags(withoutRawTextElements(withoutComments(html)))));

const attribute = (tag: string, name: string): string | null => {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
};

const normalizeFact = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/schema\.org\//, "");

const collectStructuredFacts = (
  value: unknown,
  result: {
    currencies: Set<string>;
    availability: Set<string>;
    priceCount: number;
    hasContact: boolean;
    hasOpeningHours: boolean;
  },
  depth = 0,
): void => {
  if (depth > 20 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) {
      collectStructuredFacts(item, result, depth + 1);
    }
    return;
  }
  for (const [key, item] of Object.entries(value).slice(0, 300)) {
    const normalizedKey = key.toLowerCase();
    if (typeof item === "string") {
      if (normalizedKey === "pricecurrency" && /^[a-z]{3}$/i.test(item)) {
        result.currencies.add(item.toUpperCase());
      } else if (normalizedKey === "availability") {
        result.availability.add(normalizeFact(item));
      } else if (normalizedKey === "price" && item.trim()) {
        result.priceCount += 1;
      } else if (
        normalizedKey === "telephone" ||
        normalizedKey === "email" ||
        normalizedKey === "contactpoint"
      ) {
        result.hasContact = true;
      } else if (normalizedKey.startsWith("openinghours")) {
        result.hasOpeningHours = true;
      }
    } else if (typeof item === "number" && normalizedKey === "price") {
      result.priceCount += 1;
    }
    collectStructuredFacts(item, result, depth + 1);
  }
};

const metadataFromJsonLd = (
  jsonLdValues: readonly string[],
): Omit<MetadataSnapshot, "canonical" | "hreflangCount" | "jsonLdCount"> => {
  const result = {
    currencies: new Set<string>(),
    availability: new Set<string>(),
    priceCount: 0,
    hasContact: false,
    hasOpeningHours: false,
  };
  for (const raw of jsonLdValues.slice(0, 50)) {
    if (raw.length > 512 * 1024) continue;
    try {
      collectStructuredFacts(JSON.parse(raw), result);
    } catch {
      // Invalid structured data is counted by the HTTP scanner; the Actor only
      // compares facts that can be parsed safely.
    }
  }
  return {
    currencies: [...result.currencies].sort().slice(0, 20),
    availability: [...result.availability].sort().slice(0, 20),
    priceCount: result.priceCount,
    hasContact: result.hasContact,
    hasOpeningHours: result.hasOpeningHours,
  };
};

/** The first `limit` `<link …>` tags, whole. */
const linkTags = (html: string, limit: number): string[] => {
  const tags: string[] = [];
  for (let open = html.indexOf("<"); open !== -1 && tags.length < limit; ) {
    if (hasNameAt(html, open + 1, "link")) {
      const close = html.indexOf(">", open + 5);
      if (close === -1) break;
      tags.push(html.slice(open, close + 1));
      open = html.indexOf("<", close + 1);
    } else {
      open = html.indexOf("<", open + 1);
    }
  }
  return tags;
};

/**
 * Whether the opening tag between `from` and its `>` at `to` says, anywhere
 * in it, `type = application/ld+json`, bare or in either quotes.
 */
const declaresStructuredData = (html: string, from: number, to: number): boolean => {
  const skipWhitespace = (index: number): number => {
    let cursor = index;
    while (cursor < to && isWhitespaceCode(html.charCodeAt(cursor))) cursor += 1;
    return cursor;
  };
  for (let at = from; at < to; at += 1) {
    if (!hasWordAt(html, at, "type")) continue;
    const equals = skipWhitespace(at + 4);
    if (html.charAt(equals) !== "=") continue;
    const value = skipWhitespace(equals + 1);
    const quote = html.charAt(value);
    if (quote === '"' || quote === "'") {
      const valueEnd = value + 1 + STRUCTURED_DATA_TYPE.length;
      if (hasWordAt(html, value + 1, STRUCTURED_DATA_TYPE) && html.charAt(valueEnd) === quote) {
        return true;
      }
    } else if (hasWordAt(html, value, STRUCTURED_DATA_TYPE)) {
      return true;
    }
  }
  return false;
};

/** The contents of the first `limit` structured-data scripts. */
const structuredDataBlocks = (html: string, limit: number): string[] => {
  const blocks: string[] = [];
  for (let open = html.indexOf("<"); open !== -1 && blocks.length < limit; ) {
    if (!hasNameAt(html, open + 1, "script")) {
      open = html.indexOf("<", open + 1);
      continue;
    }
    const tagEnd = html.indexOf(">", open + 7);
    if (tagEnd === -1) break;
    // Every opener inside this tag shares its `>`, so none of them can say
    // more than it does.
    if (!declaresStructuredData(html, open + 7, tagEnd)) {
      open = html.indexOf("<", tagEnd + 1);
      continue;
    }
    const end = closerEnd(html, tagEnd + 1, ["script"]);
    if (end === -1) break;
    blocks.push(html.slice(tagEnd + 1, end - "</script>".length));
    open = html.indexOf("<", end);
  }
  return blocks;
};

export const extractRawMetadata = (html: string, baseUrl: string): MetadataSnapshot => {
  let canonical: string | null = null;
  let hreflangCount = 0;
  for (const tag of linkTags(html, 2_000)) {
    const rel = (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("alternate") && attribute(tag, "hreflang")) {
      hreflangCount += 1;
    }
    if (!canonical && rel.includes("canonical")) {
      const href = attribute(tag, "href");
      if (href) {
        try {
          const parsed = new URL(href, baseUrl);
          canonical = `${parsed.origin}${parsed.pathname}`;
        } catch {
          canonical = null;
        }
      }
    }
  }
  const jsonLdValues = structuredDataBlocks(html, 50);
  return {
    canonical,
    hreflangCount,
    jsonLdCount: jsonLdValues.length,
    ...metadataFromJsonLd(jsonLdValues),
  };
};

// The pattern captures one mandatory group, so a match without it is a broken
// pattern rather than a snapshot we could not read.
const captured = (match: RegExpMatchArray): string => {
  const value = match[1];
  if (value === undefined) throw new Error("the pattern matched without filling its capture group");
  return value;
};

const countAriaRoles = (snapshot: string): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const match of snapshot.matchAll(/^\s*-\s+([a-z][a-z0-9_-]*)\b/gim)) {
    const role = captured(match).toLowerCase();
    counts[role] = (counts[role] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 50),
  );
};

type DomSnapshot = Omit<
  PageSignals,
  "rawTextChars" | "rawMetadata" | "ariaRoleCounts" | "titleSignature"
> & { title: string };

export const collectPageSignals = async (options: {
  page: Page;
  rawHtml: string;
  rawUrl: string;
  timeoutMs: number;
}): Promise<PageSignals> => {
  const dom = await options.page.evaluate<DomSnapshot>(() => {
    const normalizedText = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const accessibleName = (element: Element): string => {
      const direct =
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.getAttribute("alt");
      if (normalizedText(direct)) return normalizedText(direct);
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ");
        if (normalizedText(text)) return normalizedText(text);
      }
      if (element instanceof HTMLInputElement) {
        const labelText = [...(element.labels ?? [])]
          .map((label) => label.textContent ?? "")
          .join(" ");
        if (normalizedText(labelText)) return normalizedText(labelText);
        if (["button", "submit", "reset"].includes(element.type)) {
          return normalizedText(element.value);
        }
      }
      if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
        const labelText = [...(element.labels ?? [])]
          .map((label) => label.textContent ?? "")
          .join(" ");
        if (normalizedText(labelText)) return normalizedText(labelText);
      }
      return normalizedText(element.textContent);
    };

    const count = (selector: string): number => document.querySelectorAll(selector).length;
    const landmarkCounts: Record<string, number> = {
      banner: count("header,[role=banner]"),
      complementary: count("aside,[role=complementary]"),
      contentinfo: count("footer,[role=contentinfo]"),
      main: count("main,[role=main]"),
      navigation: count("nav,[role=navigation]"),
      region: count("section[aria-label],section[aria-labelledby],[role=region]"),
    };
    const headingLevelCounts: Record<string, number> = {};
    for (let level = 1; level <= 6; level += 1) {
      headingLevelCounts[`h${level}`] = count(`h${level},[role=heading][aria-level="${level}"]`);
    }

    const interactive = [
      ...document.querySelectorAll(
        "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[tabindex]",
      ),
    ].slice(0, 100_000);
    const formControls = [...document.querySelectorAll("input,select,textarea,button")].slice(
      0,
      100_000,
    );
    const formSemanticIssue = (element: Element): boolean => {
      if (!accessibleName(element)) return true;
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
      ) {
        if (!normalizedText(element.getAttribute("name"))) return true;
      }
      if (element instanceof HTMLInputElement) {
        const identityLike =
          ["email", "tel", "password"].includes(element.type) ||
          /(?:^|[-_])(name|email|phone|tel|address|postal|country)(?:$|[-_])/i.test(
            `${element.name} ${element.id}`,
          );
        if (identityLike && !element.hasAttribute("autocomplete")) return true;
      }
      return false;
    };

    const modelContext = (document as Document & { modelContext?: unknown }).modelContext;
    let webmcpToolCount = 0;
    if (modelContext && typeof modelContext === "object") {
      const tools = (modelContext as { tools?: unknown }).tools;
      if (Array.isArray(tools)) webmcpToolCount = tools.length;
      else if (
        tools &&
        typeof tools === "object" &&
        typeof (tools as { size?: unknown }).size === "number"
      ) {
        webmcpToolCount = (tools as { size: number }).size;
      }
    }

    const jsonLdValues = [
      ...document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'),
    ]
      .slice(0, 50)
      .map((script) => script.textContent ?? "");
    const structured = {
      currencies: new Set<string>(),
      availability: new Set<string>(),
      priceCount: 0,
      hasContact: false,
      hasOpeningHours: false,
    };
    const visit = (value: unknown, depth = 0): void => {
      if (depth > 20 || !value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 200)) visit(item, depth + 1);
        return;
      }
      for (const [key, item] of Object.entries(value).slice(0, 300)) {
        const normalizedKey = key.toLowerCase();
        if (typeof item === "string") {
          if (normalizedKey === "pricecurrency" && /^[a-z]{3}$/i.test(item)) {
            structured.currencies.add(item.toUpperCase());
          } else if (normalizedKey === "availability") {
            structured.availability.add(
              item
                .trim()
                .toLowerCase()
                .replace(/^https?:\/\/schema\.org\//, ""),
            );
          } else if (normalizedKey === "price" && item.trim()) {
            structured.priceCount += 1;
          } else if (
            normalizedKey === "telephone" ||
            normalizedKey === "email" ||
            normalizedKey === "contactpoint"
          ) {
            structured.hasContact = true;
          } else if (normalizedKey.startsWith("openinghours")) {
            structured.hasOpeningHours = true;
          }
        } else if (typeof item === "number" && normalizedKey === "price") {
          structured.priceCount += 1;
        }
        visit(item, depth + 1);
      }
    };
    for (const value of jsonLdValues) {
      if (value.length > 512 * 1024) continue;
      try {
        visit(JSON.parse(value));
      } catch {
        // Invalid JSON-LD is handled by the canonical HTTP scanner.
      }
    }

    const canonicalElement = document.querySelector<HTMLLinkElement>('link[rel~="canonical"]');
    let canonical: string | null = null;
    if (canonicalElement?.href) {
      try {
        const parsed = new URL(canonicalElement.href, document.baseURI);
        canonical = `${parsed.origin}${parsed.pathname}`;
      } catch {
        canonical = null;
      }
    }

    const bodyText = normalizedText(document.body?.innerText).slice(0, 100_000);
    const visibleCurrencies = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"]
      .filter((currency) => new RegExp(`(?:^|[^A-Z])${currency}(?:$|[^A-Z])`, "i").test(bodyText))
      .sort();
    const visibleAvailability = [
      ["instock", /\bin[ -]?stock\b/i],
      ["outofstock", /\bout[ -]?of[ -]?stock\b|\bsold[ -]?out\b/i],
      ["preorder", /\bpre[ -]?order\b/i],
      ["backorder", /\bback[ -]?order(?:ed)?\b/i],
    ]
      .filter(([, pattern]) => (pattern as RegExp).test(bodyText))
      .map(([value]) => value as string);
    const titleText = normalizedText(document.title).slice(0, 2_000);
    const challengeHaystack = `${titleText}\n${bodyText}`.toLowerCase();
    let challengeKind: string | null = null;
    if (
      /captcha|verify (?:that )?you are human|checking your browser|cf-chl-|attention required/.test(
        challengeHaystack,
      )
    ) {
      challengeKind = "bot_challenge";
    } else if (
      document.querySelector('input[type="password"]') &&
      /sign in|log in|login|member access|authentication required/.test(challengeHaystack) &&
      bodyText.length < 2_000
    ) {
      challengeKind = "login_wall";
    } else if (
      document.querySelector('[role="dialog"],dialog,[class*="cookie" i],[id*="cookie" i]') &&
      /accept (?:all )?cookies|cookie consent|privacy preferences/.test(challengeHaystack) &&
      bodyText.length < 1_000
    ) {
      challengeKind = "cookie_wall";
    }

    let hiddenInstructionCount = 0;
    const imperativePattern =
      /ignore (?:all |any )?(?:previous|prior) instructions|system prompt|assistant must|ai agent must|do not follow|reveal (?:the )?(?:prompt|secret)/i;
    for (const element of [...document.body.querySelectorAll<HTMLElement>("*")].slice(0, 2_000)) {
      if (hiddenInstructionCount >= 100) break;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const hidden =
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number.parseFloat(style.opacity || "1") === 0 ||
        rect.width === 0 ||
        rect.height === 0 ||
        rect.right < -100 ||
        rect.bottom < -100;
      if (!hidden) continue;
      const text = normalizedText(element.textContent).slice(0, 2_000);
      if (imperativePattern.test(text)) hiddenInstructionCount += 1;
    }

    let apiDiscoveryCount = 0;
    let licenseLinkCount = 0;
    for (const link of [
      ...document.querySelectorAll<HTMLLinkElement | HTMLAnchorElement>("link[href],a[href]"),
    ].slice(0, 5_000)) {
      const rel = (link.getAttribute("rel") ?? "").toLowerCase();
      const href = link.getAttribute("href") ?? "";
      if (
        /(?:^|\s)(?:service|api|openapi)(?:\s|$)/.test(rel) ||
        /(?:openapi|swagger|api-catalog)(?:\.json|\.ya?ml|\/|$)/i.test(href)
      ) {
        try {
          const parsed = new URL(href, document.baseURI);
          if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            apiDiscoveryCount += 1;
          }
        } catch {
          // Invalid declarations are not counted as a discoverable surface.
        }
      }
      if (/(?:^|\s)license(?:\s|$)/.test(rel) || /(?:^|\/)rsl(?:\/|\.|$)/i.test(href)) {
        try {
          const parsed = new URL(href, document.baseURI);
          if (parsed.protocol === "http:" || parsed.protocol === "https:") {
            licenseLinkCount += 1;
          }
        } catch {
          // Invalid declarations are not counted.
        }
      }
    }

    return {
      title: titleText,
      renderedTextChars: bodyText.length,
      landmarkCounts,
      headingLevelCounts,
      interactiveControlCount: interactive.length,
      unnamedControlCount: interactive.filter((element) => !accessibleName(element)).length,
      formControlCount: formControls.length,
      unlabeledFormControlCount: formControls.filter((element) => !accessibleName(element)).length,
      formSemanticIssueCount: formControls.filter(formSemanticIssue).length,
      webmcpPresent: modelContext !== undefined,
      webmcpToolCount: Math.max(0, Math.min(10_000, webmcpToolCount)),
      challengeKind,
      hiddenInstructionCount,
      apiDiscoveryCount,
      licenseLinkCount,
      renderedMetadata: {
        canonical,
        hreflangCount: document.querySelectorAll("link[hreflang]").length,
        jsonLdCount: jsonLdValues.length,
        currencies: [...structured.currencies].sort().slice(0, 20),
        availability: [...structured.availability].sort().slice(0, 20),
        priceCount: structured.priceCount,
        hasContact: structured.hasContact,
        hasOpeningHours: structured.hasOpeningHours,
      },
      visibleFacts: {
        currencies: visibleCurrencies,
        availability: visibleAvailability,
      },
    };
  });

  let ariaSnapshot = "";
  try {
    ariaSnapshot = await options.page.locator("body").ariaSnapshot({
      timeout: Math.min(2_000, options.timeoutMs),
    });
  } catch {
    // A missing accessibility snapshot degrades only this aggregate signal.
  }

  const { title, ...safeDom } = dom;
  return {
    ...safeDom,
    rawTextChars: rawTextCharacterCount(options.rawHtml),
    rawMetadata: extractRawMetadata(options.rawHtml, options.rawUrl),
    ariaRoleCounts: countAriaRoles(ariaSnapshot),
    titleSignature: createHash("sha256").update(title.toLowerCase()).digest("hex"),
  };
};
