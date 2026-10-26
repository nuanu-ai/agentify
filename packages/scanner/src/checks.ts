import { CHECK_DEFINITIONS, type CheckResult, type Segment } from "@agentify/scanner-contracts";
import { authSchemes, mediaType, varyNames } from "./http-fields.js";
import { asciiLower, isQuote, nextTag, quotedValues, type Span } from "./markup.js";
import type { FetchArtifact, ScanArtifacts } from "./model.js";
import {
  comparableTexts,
  htmlSignals,
  isChallenge,
  type JsonLdResult,
  jsonLdTypes,
  parseJsonLd,
  parseSitemap,
  type SitemapResult,
  visibleText,
} from "./parsers.js";
import {
  type DocumentReading,
  isWebPage,
  jsonDocumentOf,
  type Reading,
  readingOf,
} from "./reading.js";
import {
  explicitAiPolicies,
  isPathAllowed,
  parseRobots,
  type RobotsParseResult,
} from "./robots.js";

export const CHECK_WEIGHTS: readonly number[] = CHECK_DEFINITIONS.map(
  (definition) => definition.nominalWeight,
);

const checkWeight = (id: number): number => {
  const weight = CHECK_WEIGHTS[id - 1];
  if (weight === undefined) throw new Error(`check ${id} has no definition, so it has no weight`);
  return weight;
};

type TerminalCheckStatus = "pass" | "partial" | "fail" | "unavailable" | "not_applicable";
type ResultInput = {
  id: number;
  status: TerminalCheckStatus;
  earnedWeight: number;
  summaryCode: string;
  evidence?: Record<string, string | number | boolean | string[]>;
  userImpactCode: string;
  fixCode?: string;
  durationMs?: number;
  errorCode?: string;
  applicable?: boolean;
};

const result = ({
  id,
  status,
  earnedWeight,
  summaryCode,
  evidence = {},
  userImpactCode,
  fixCode,
  durationMs = 0,
  errorCode,
  applicable = status !== "not_applicable",
}: ResultInput): CheckResult => ({
  id: id as CheckResult["id"],
  status,
  nominalWeight: checkWeight(id),
  applicableWeight: applicable ? checkWeight(id) : 0,
  earnedWeight,
  summaryCode,
  evidence,
  userImpactCode,
  ...(fixCode ? { fixCode } : {}),
  durationMs,
  ...(errorCode ? { errorCode } : {}),
});

/**
 * The error code of every check that needed the home page when the site
 * answered it with a bot challenge or a refusal (401, 403 or 429) in its
 * place.
 */
export const BASE_BLOCKED = "base_blocked";

const inaccessible = (artifact?: FetchArtifact): boolean =>
  !artifact || Boolean(artifact.errorCode) || artifact.status === 0 || artifact.status >= 500;
const ROBOTS_CODES = new Set(["robots_disallowed", "robots_unavailable"]);

type Unknown = Extract<Reading | DocumentReading, { state: "cut" | "unread" }>;
const isUnknown = (reading: Reading | DocumentReading): reading is Unknown =>
  reading.state === "cut" || reading.state === "unread";
// Why none of several documents can be judged: robots.txt first, since the
// owner can act on it, then a document cut at the read limit, then whatever
// else kept the first one from being read.
const firstUnknown = (readings: readonly (Reading | DocumentReading)[]): Unknown | undefined => {
  const unknown = readings.filter(isUnknown);
  return (
    unknown.find((reading) => reading.state === "unread" && ROBOTS_CODES.has(reading.errorCode)) ??
    unknown.find((reading) => reading.state === "cut") ??
    unknown[0]
  );
};

/**
 * The result of a check that needed a document the scanner did not read
 * whole: cut at the read limit, which the result names, or not answered, with
 * the status the site answered when there was one. Either way no verdict is
 * given, so the check lowers coverage, not the score.
 */
const unjudged = (
  id: number,
  reading: Unknown,
  unread: Readonly<{ summaryCode: string; userImpactCode: string }>,
  evidence: CheckResult["evidence"] = {},
): CheckResult =>
  reading.state === "cut"
    ? result({
        id,
        status: "unavailable",
        earnedWeight: 0,
        summaryCode: "document_truncated",
        userImpactCode: unread.userImpactCode,
        errorCode: "document_truncated",
        evidence: { ...evidence, truncated: true, read_limit: reading.readLimit },
      })
    : result({
        id,
        status: "unavailable",
        earnedWeight: 0,
        summaryCode: unread.summaryCode,
        userImpactCode: unread.userImpactCode,
        errorCode: reading.errorCode,
        evidence: { ...evidence, ...(reading.status ? { status: reading.status } : {}) },
      });

// A scan evaluates its checks several times as its requests complete, all
// over one robots.txt artifact, which the site may have filled to the fetch
// limit: it is parsed, and each path decided, once per artifact.
type RobotsReading = { parsed: RobotsParseResult; verdicts: Map<string, boolean | undefined> };
const robotsReadings = new WeakMap<FetchArtifact, RobotsReading>();
const readRobots = (robots: FetchArtifact): RobotsReading => {
  let reading = robotsReadings.get(robots);
  if (!reading) {
    reading = { parsed: parseRobots(robots.body), verdicts: new Map() };
    robotsReadings.set(robots, reading);
  }
  return reading;
};
const scannerVerdict = (reading: RobotsReading, path: string): boolean | undefined => {
  if (!reading.verdicts.has(path))
    reading.verdicts.set(path, isPathAllowed(reading.parsed, "agentify-scanner", path));
  return reading.verdicts.get(path);
};

// The same scan is evaluated several times over the same artifacts, and
// several checks read the same page: each artifact's visible text, signals,
// JSON-LD and sitemap are read once, since a page of up to 2 MiB can cost a
// reader a noticeable part of a second.
type PageReading = {
  text?: string;
  signals?: ReturnType<typeof htmlSignals>;
  jsonLd?: JsonLdResult;
  sitemap?: ReturnType<typeof parseSitemap>;
};
const pageReadings = new WeakMap<FetchArtifact, PageReading>();
const pageReadingOf = (artifact: FetchArtifact): PageReading => {
  let reading = pageReadings.get(artifact);
  if (!reading) {
    reading = {};
    pageReadings.set(artifact, reading);
  }
  return reading;
};
const textOf = (artifact: FetchArtifact): string =>
  (pageReadingOf(artifact).text ??= visibleText(artifact.body));
const signalsOf = (artifact: FetchArtifact) =>
  (pageReadingOf(artifact).signals ??= htmlSignals(artifact.body, textOf(artifact)));
const jsonLdOf = (artifact: FetchArtifact): JsonLdResult =>
  (pageReadingOf(artifact).jsonLd ??= parseJsonLd(artifact.body));
const sitemapOf = (artifact: FetchArtifact) =>
  (pageReadingOf(artifact).sitemap ??= parseSitemap(artifact.body));
const NO_SIGNALS = htmlSignals("");

const robotsChecks = (artifacts: ScanArtifacts): CheckResult[] => {
  const fetch = artifacts.robots;
  const { parsed } = readRobots(fetch);
  const common = { durationMs: fetch.durationMs };
  const reading = readingOf(fetch, "robots_http_error");
  const read = reading.state === "whole" || reading.state === "cut" ? reading : undefined;
  let robots: CheckResult;
  if (reading.state === "unread" && (reading.status === undefined || reading.status >= 500)) {
    robots = unjudged(1, reading, {
      summaryCode: "robots_unavailable",
      userImpactCode: "robots_not_assessed",
    });
  } else if (reading.state === "absent" || (read && isWebPage(read.artifact.body))) {
    robots = result({
      id: 1,
      status: "fail",
      earnedWeight: 0,
      summaryCode: "robots_missing",
      evidence: { status: fetch.status },
      userImpactCode: "robots_missing_impact",
      fixCode: "publish_robots",
      ...common,
    });
  } else if (fetch.status !== 200) {
    // Crawlers take a robots.txt answered with a refusal as no rules at all.
    robots = result({
      id: 1,
      status: "fail",
      earnedWeight: 0,
      summaryCode: "robots_refused",
      evidence: { status: fetch.status },
      userImpactCode: "robots_missing_impact",
      fixCode: "serve_robots",
      ...common,
    });
  } else if (parsed.fatal) {
    robots = result({
      id: 1,
      status: "fail",
      earnedWeight: 0,
      summaryCode: "robots_invalid",
      evidence: { status: fetch.status },
      userImpactCode: "robots_invalid_impact",
      fixCode: "repair_robots",
      ...common,
    });
  } else {
    const contentType = fetch.headers["content-type"] ?? "";
    const [summaryCode, fixCode] =
      reading.state === "cut"
        ? ["robots_too_large", "shorten_robots"]
        : parsed.malformedDirectives > 0
          ? ["robots_partially_parseable", "repair_robots"]
          : mediaType(contentType) === "text/html"
            ? ["robots_wrong_media_type", "serve_robots_as_text"]
            : ["robots_parseable", undefined];
    robots = result({
      id: 1,
      status: fixCode ? "partial" : "pass",
      earnedWeight: fixCode ? 2 : 5,
      summaryCode,
      evidence: {
        status: fetch.status,
        size: fetch.decodedBytes,
        sitemap_count: parsed.sitemaps.length,
        group_count: parsed.groups.length,
        malformed_directives: parsed.malformedDirectives,
        ...(summaryCode === "robots_wrong_media_type" ? { content_type: contentType } : {}),
        ...(reading.state === "cut" ? { truncated: true, read_limit: reading.readLimit } : {}),
      },
      userImpactCode: "robots_policy_discoverability",
      fixCode,
      ...common,
    });
  }

  const policies = explicitAiPolicies(parsed);
  const providerCount = Object.keys(policies).length;
  let ai: CheckResult;
  if (robots.status === "unavailable")
    ai = result({
      id: 2,
      status: "unavailable",
      earnedWeight: 0,
      summaryCode: "ai_policy_unavailable",
      userImpactCode: "ai_policy_not_assessed",
      errorCode: robots.errorCode,
    });
  else if (robots.summaryCode === "robots_missing" || robots.summaryCode === "robots_refused")
    ai = result({
      id: 2,
      status: "fail",
      earnedWeight: 0,
      summaryCode: "ai_policy_absent",
      userImpactCode: "ai_policy_ambiguity",
      fixCode: "declare_ai_policy",
    });
  else
    ai = result({
      id: 2,
      status: providerCount === 4 ? "pass" : providerCount ? "partial" : "fail",
      earnedWeight: providerCount * 2,
      summaryCode:
        providerCount === 4
          ? "ai_policy_explicit"
          : providerCount
            ? "ai_policy_partial"
            : "ai_policy_absent",
      evidence: {
        provider_count: providerCount,
        providers: Object.keys(policies),
        policy_tokens: Object.values(policies).flat(),
      },
      userImpactCode: "ai_policy_ambiguity",
      fixCode: providerCount === 4 ? undefined : "declare_ai_policy",
    });

  let contentSignal: CheckResult;
  if (robots.status === "unavailable")
    contentSignal = result({
      id: 3,
      status: "unavailable",
      earnedWeight: 0,
      summaryCode: "content_signal_unavailable",
      userImpactCode: "content_signal_not_assessed",
      errorCode: robots.errorCode,
    });
  else if (!parsed.contentSignal && !parsed.contentSignalMalformed)
    contentSignal = result({
      id: 3,
      status: "fail",
      earnedWeight: 0,
      summaryCode: "content_signal_absent",
      userImpactCode: "content_signal_ambiguity",
      fixCode: "publish_content_signal",
    });
  else if (parsed.contentSignalMalformed)
    contentSignal = result({
      id: 3,
      status: "partial",
      earnedWeight: 2,
      summaryCode: "content_signal_partial",
      evidence: { valid_keys: Object.keys(parsed.contentSignal ?? {}) },
      userImpactCode: "content_signal_ambiguity",
      fixCode: "repair_content_signal",
    });
  else
    contentSignal = result({
      id: 3,
      status: "pass",
      earnedWeight: 4,
      summaryCode: "content_signal_parseable",
      evidence: {
        keys: Object.keys(parsed.contentSignal ?? {}),
        values: Object.entries(parsed.contentSignal ?? {}).map(([key, value]) => `${key}:${value}`),
      },
      userImpactCode: "content_signal_explicit",
    });
  return [robots, ai, contentSignal];
};

// What one sitemap request came to. A cut answer whose part read already
// holds entries is judged by them; one that does not is as unknown as an
// answer that never came.
type SitemapOutcome = Readonly<
  { artifact: FetchArtifact } & (
    | { kind: "sitemap"; parsed: SitemapResult; readLimit?: string }
    | { kind: "unread"; reading: Unknown }
    | { kind: "doctype" }
    | { kind: "missing"; status: number }
    | { kind: "empty" | "not_sitemap" }
  )
>;

const sitemapOutcome = (artifact: FetchArtifact): SitemapOutcome => {
  const reading = readingOf(artifact, "sitemap_unavailable");
  if (reading.state === "absent") return { artifact, kind: "missing", status: reading.status };
  if (reading.state === "unread") return { artifact, kind: "unread", reading };
  if (isWebPage(artifact.body)) return { artifact, kind: "not_sitemap" };
  const parsed = sitemapOf(artifact);
  // The scanner does not read XML that declares a document type, whose
  // entities could expand without bound.
  if (parsed.errorCode === "xml_entity_blocked") return { artifact, kind: "doctype" };
  if (parsed.valid)
    return {
      artifact,
      kind: "sitemap",
      parsed,
      ...(reading.state === "cut" ? { readLimit: reading.readLimit } : {}),
    };
  if (reading.state === "cut") return { artifact, kind: "unread", reading };
  return { artifact, kind: parsed.errorCode === "sitemap_empty" ? "empty" : "not_sitemap" };
};

const SITEMAP_FIXES: Readonly<Record<string, string>> = {
  sitemap_entries_missing: "fix_listed_sitemaps",
  sitemap_no_lastmod: "add_sitemap_lastmod",
  sitemap_stale: "refresh_sitemap_lastmod",
};

const sitemapCheck = (artifacts: ScanArtifacts): CheckResult => {
  const durationMs = artifacts.sitemap.reduce((sum, artifact) => sum + artifact.durationMs, 0);
  const outcomes = artifacts.sitemap.map(sitemapOutcome);
  const sitemaps = outcomes.flatMap((outcome) => (outcome.kind === "sitemap" ? [outcome] : []));
  if (!sitemaps.length) {
    // That no usable sitemap exists is said only once every sitemap asked
    // for has been read.
    const unknown = outcomes.length
      ? firstUnknown(
          outcomes.flatMap((outcome) => (outcome.kind === "unread" ? [outcome.reading] : [])),
        )
      : ({ state: "unread", errorCode: "sitemap_unavailable" } as const);
    if (unknown)
      return unjudged(4, unknown, {
        summaryCode: "sitemap_unavailable",
        userImpactCode: "sitemap_not_assessed",
      });
    if (outcomes.some((outcome) => outcome.kind === "doctype"))
      return result({
        id: 4,
        status: "unavailable",
        earnedWeight: 0,
        summaryCode: "sitemap_doctype",
        userImpactCode: "sitemap_not_assessed",
        errorCode: "sitemap_doctype",
        durationMs,
      });
    const [summaryCode, fixCode] = outcomes.some((outcome) => outcome.kind === "empty")
      ? ["sitemap_empty", "add_sitemap_entries"]
      : outcomes.some((outcome) => outcome.kind === "not_sitemap")
        ? ["sitemap_not_sitemap", "serve_sitemap"]
        : ["sitemap_missing", "publish_sitemap"];
    return result({
      id: 4,
      status: "fail",
      earnedWeight: 0,
      summaryCode,
      userImpactCode: "sitemap_discovery_gap",
      fixCode,
      durationMs,
    });
  }
  // A sitemap is named by where it was listed, since its address cannot be
  // shown in the evidence.
  const indexes = sitemaps.filter(({ parsed }) => parsed.isIndex).map(({ parsed }) => parsed.urls);
  const declared = readRobots(artifacts.robots).parsed.sitemaps;
  const named = (outcome: SitemapOutcome): string => {
    const listed = indexes.map((urls) => urls.indexOf(outcome.artifact.url)).find((at) => at >= 0);
    const place =
      listed !== undefined
        ? `entry ${listed + 1} of the sitemap index`
        : declared.includes(outcome.artifact.url)
          ? `sitemap ${declared.indexOf(outcome.artifact.url) + 1} declared in robots.txt`
          : "the sitemap address";
    const reason =
      outcome.kind === "missing"
        ? `HTTP ${outcome.status}`
        : outcome.kind === "unread"
          ? outcome.reading.state === "cut"
            ? `larger than ${outcome.reading.readLimit}`
            : outcome.reading.status
              ? `HTTP ${outcome.reading.status}`
              : outcome.reading.errorCode
          : outcome.kind === "doctype"
            ? "declares a document type"
            : outcome.kind === "empty"
              ? "no entries"
              : "not a sitemap";
    return `${place}: ${reason}`;
  };
  const missing = outcomes
    .filter(({ kind }) => kind === "missing" || kind === "empty" || kind === "not_sitemap")
    .map(named);
  const unread = outcomes.filter(({ kind }) => kind === "unread" || kind === "doctype").map(named);
  const lastmods = sitemaps.flatMap(({ parsed }) => parsed.lastmods);
  const staleCutoff = Date.now() - 180 * 86_400_000;
  const stale = lastmods.filter(
    (value) => !Number.isFinite(Date.parse(value)) || Date.parse(value) < staleCutoff,
  ).length;
  const cause = missing.length
    ? "sitemap_entries_missing"
    : !lastmods.length
      ? "sitemap_no_lastmod"
      : stale * 5 > lastmods.length * 4
        ? "sitemap_stale"
        : undefined;
  const readLimit = sitemaps.find((sitemap) => sitemap.readLimit)?.readLimit;
  return result({
    id: 4,
    status: cause ? "partial" : "pass",
    earnedWeight: cause === "sitemap_entries_missing" ? 2 : cause ? 4 : 6,
    summaryCode: cause ?? "sitemap_valid",
    evidence: {
      files_checked: artifacts.sitemap.length,
      entries_read: sitemaps.flatMap(({ parsed }) => parsed.urls).length,
      lastmod_count: lastmods.length,
      stale_lastmod_count: stale,
      ...(missing.length ? { sitemaps_missing: missing } : {}),
      ...(unread.length ? { sitemaps_unread: unread } : {}),
      ...(readLimit ? { truncated: true, read_limit: readLimit } : {}),
    },
    userImpactCode: "sitemap_discovery",
    fixCode: cause ? SITEMAP_FIXES[cause] : undefined,
    durationMs,
  });
};

const fieldPresent = (node: Record<string, unknown>, path: string): boolean => {
  let current: unknown = node;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return false;
    current = (current as Record<string, unknown>)[part];
    if (Array.isArray(current)) current = current[0];
  }
  return current !== undefined && current !== null && current !== "";
};

const verticalProfile = (segment: Segment, nodes: Record<string, unknown>[]) => {
  const nodeTypes = nodes.map((node) => ({ node, types: jsonLdTypes(node) }));
  const choose = (...types: string[]) =>
    nodeTypes.find((entry) => entry.types.some((type) => types.includes(type)));
  if (segment === "store")
    return {
      selected: choose("Product"),
      required: ["name", "image", "url", "offers.price", "offers.priceCurrency"],
      recommended: ["offers.availability"],
    };
  if (segment === "local")
    return {
      selected: nodeTypes.find((entry) =>
        entry.types.some(
          (type) =>
            type === "LocalBusiness" ||
            type.endsWith("Business") ||
            ["Restaurant", "Hotel", "Dentist", "Store"].includes(type),
        ),
      ),
      required: ["name", "address"],
      recommended: ["telephone", "openingHoursSpecification", "geo", "priceRange", "makesOffer"],
    };
  const product = choose("Product");
  if (product)
    return {
      selected: product,
      required: ["name", "image", "url", "offers.price", "offers.priceCurrency"],
      recommended: ["offers.availability"],
    };
  const local = choose("LocalBusiness", "Restaurant", "Hotel", "Store");
  if (local)
    return {
      selected: local,
      required: ["name", "address"],
      recommended: ["telephone", "openingHoursSpecification", "geo", "priceRange"],
    };
  const article = choose("Article", "NewsArticle", "BlogPosting");
  if (article)
    return {
      selected: article,
      required: ["headline", "image", "datePublished"],
      recommended: ["author", "dateModified"],
    };
  return {
    selected: choose("Organization", "WebSite"),
    required: ["name", "url"],
    recommended: ["contactPoint", "sameAs", "logo"],
  };
};

const jsonLdChecks = (artifacts: ScanArtifacts): CheckResult[] => {
  const pages = [artifacts.base, artifacts.representative].filter(
    (page): page is FetchArtifact => Boolean(page) && !inaccessible(page),
  );
  if (!pages.length)
    return [
      result({
        id: 5,
        status: "unavailable",
        earnedWeight: 0,
        summaryCode: "jsonld_unavailable",
        userImpactCode: "structured_data_not_assessed",
        errorCode:
          artifacts.base?.errorCode ?? artifacts.representative?.errorCode ?? "base_unavailable",
      }),
      result({
        id: 6,
        status: "unavailable",
        earnedWeight: 0,
        summaryCode: "vertical_jsonld_unavailable",
        userImpactCode: "structured_data_not_assessed",
        errorCode:
          artifacts.base?.errorCode ?? artifacts.representative?.errorCode ?? "base_unavailable",
      }),
    ];
  const parsedPages = pages.map(jsonLdOf);
  const parsed = {
    nodes: parsedPages.flatMap(({ nodes }) => nodes),
    scriptCount: parsedPages.reduce((sum, page) => sum + page.scriptCount, 0),
    invalidCount: parsedPages.reduce((sum, page) => sum + page.invalidCount, 0),
  };
  const presence = parsed.nodes.length ? (parsed.invalidCount ? "partial" : "pass") : "fail";
  const check5 = result({
    id: 5,
    status: presence,
    earnedWeight: presence === "pass" ? 10 : presence === "partial" ? 4 : 0,
    summaryCode:
      presence === "pass"
        ? "jsonld_present"
        : presence === "partial"
          ? "jsonld_partially_parseable"
          : "jsonld_absent_or_invalid",
    evidence: {
      script_count: parsed.scriptCount,
      node_count: parsed.nodes.length,
      invalid_script_count: parsed.invalidCount,
      pages_checked: pages.length,
    },
    userImpactCode: "structured_data_machine_readability",
    fixCode: presence === "pass" ? undefined : "publish_valid_jsonld",
    durationMs: pages.reduce((sum, page) => sum + page.durationMs, 0),
  });
  if (!parsed.nodes.length)
    return [
      check5,
      result({
        id: 6,
        status: "fail",
        earnedWeight: 0,
        summaryCode: "vertical_jsonld_missing",
        userImpactCode: "vertical_data_gap",
        fixCode: "publish_vertical_jsonld",
      }),
    ];
  const profile = verticalProfile(artifacts.segment, parsed.nodes);
  const selected = profile.selected;
  if (!selected)
    return [
      check5,
      result({
        id: 6,
        status: "fail",
        earnedWeight: 0,
        summaryCode: "vertical_jsonld_wrong_type",
        evidence: {
          types: [...new Set(parsed.nodes.flatMap(jsonLdTypes))].slice(0, 20),
        },
        userImpactCode: "vertical_data_gap",
        fixCode: "publish_vertical_jsonld",
      }),
    ];
  const requiredFound = profile.required.filter((field) => fieldPresent(selected.node, field));
  const recommendedFound = profile.recommended.filter((field) =>
    fieldPresent(selected.node, field),
  );
  const requiredRatio = requiredFound.length / profile.required.length;
  const recommendedRatio = recommendedFound.length / profile.recommended.length;
  const complete = requiredRatio === 1 && recommendedRatio >= 0.5;
  const points = complete
    ? 12
    : Math.max(3, Math.min(9, Math.round(12 * (requiredRatio * 0.7 + recommendedRatio * 0.3))));
  return [
    check5,
    result({
      id: 6,
      status: complete ? "pass" : "partial",
      earnedWeight: points,
      summaryCode: complete ? "vertical_jsonld_complete" : "vertical_jsonld_incomplete",
      evidence: {
        type: jsonLdTypes(selected.node)[0] ?? "unknown",
        required_found: requiredFound,
        required_missing: profile.required.filter((field) => !requiredFound.includes(field)),
        recommended_found: recommendedFound,
      },
      userImpactCode: "vertical_data_machine_readability",
      fixCode: complete ? undefined : "complete_vertical_jsonld",
    }),
  ];
};

const markdownCheck = (artifacts: ScanArtifacts): CheckResult => {
  const markdown = artifacts.markdown;
  if (!markdown || inaccessible(markdown))
    return result({
      id: 7,
      status: "unavailable",
      earnedWeight: 0,
      summaryCode: "markdown_unavailable",
      userImpactCode: "markdown_not_assessed",
      errorCode: markdown?.errorCode ?? "markdown_unavailable",
    });
  const type = markdown.headers["content-type"] ?? "";
  const vary = varyNames(markdown.headers.vary);
  const representationDiffers = artifacts.base
    ? markdown.body.trim() !== artifacts.base.body.trim()
    : false;
  const semanticParity = artifacts.base
    ? comparableTexts(textOf(markdown), textOf(artifacts.base))
    : false;
  const correctType = mediaType(type) === "text/markdown";
  const nonEmpty = textOf(markdown).length > 20;
  if (
    markdown.status >= 200 &&
    markdown.status < 300 &&
    correctType &&
    vary.includes("accept") &&
    representationDiffers &&
    semanticParity &&
    nonEmpty
  )
    return result({
      id: 7,
      status: "pass",
      earnedWeight: 8,
      summaryCode: "markdown_negotiation_valid",
      evidence: {
        content_type: type,
        vary_accept: true,
        differentiated: true,
        semantic_parity: true,
      },
      userImpactCode: "markdown_available",
    });
  // A generic Link: rel=alternate is not evidence of a working Markdown
  // representation (it is commonly a locale, feed, or XML alternate). The
  // scan does not fetch a declared .md alternate, so only a real Markdown
  // response can earn partial credit here.
  if (markdown.status >= 200 && markdown.status < 300 && correctType)
    return result({
      id: 7,
      status: "partial",
      earnedWeight: vary.includes("*") || !nonEmpty ? 2 : 6,
      summaryCode: "markdown_negotiation_partial",
      evidence: {
        content_type: type,
        vary_accept: vary.includes("accept"),
        differentiated: representationDiffers,
        semantic_parity: semanticParity,
        non_empty: nonEmpty,
      },
      userImpactCode: "markdown_incomplete",
      fixCode: "repair_markdown_negotiation",
    });
  return result({
    id: 7,
    status: "fail",
    earnedWeight: 0,
    summaryCode: "markdown_negotiation_absent",
    evidence: { content_type: type },
    userImpactCode: "markdown_absent",
    fixCode: "add_markdown_negotiation",
  });
};

// Whether a Markdown link leads to an absolute address: a bracketed text of
// at least one character, then `(http://` or `(https://`.
const linksAbsolutely = (text: string): boolean => {
  const lower = asciiLower(text);
  for (let open = lower.indexOf("["); open !== -1; ) {
    const close = lower.indexOf("]", open + 1);
    if (close === -1) return false;
    if (
      close > open + 1 &&
      (lower.startsWith("(http://", close + 1) || lower.startsWith("(https://", close + 1))
    )
      return true;
    open = lower.indexOf("[", close + 1);
  }
  return false;
};

const llmsCheck = (artifact?: FetchArtifact): CheckResult => {
  const reading = readingOf(artifact, "llms_unavailable");
  if (
    reading.state === "absent" ||
    ((reading.state === "whole" || reading.state === "cut") && isWebPage(reading.artifact.body))
  )
    return result({
      id: 8,
      status: "not_applicable",
      earnedWeight: 0,
      summaryCode: "llms_absent",
      userImpactCode: "llms_optional",
      applicable: false,
    });
  if (reading.state === "unread")
    return unjudged(8, reading, {
      summaryCode: "llms_unavailable",
      userImpactCode: "llms_not_assessed",
    });
  const h1 = /^#\s+\S+/m.test(reading.artifact.body);
  const links = linksAbsolutely(reading.artifact.body);
  // The part read proves a heading and a link it holds, not their absence.
  if (reading.state === "cut" && !(h1 && links))
    return unjudged(8, reading, {
      summaryCode: "llms_unavailable",
      userImpactCode: "llms_not_assessed",
    });
  return result({
    id: 8,
    status: h1 && links ? "pass" : "partial",
    earnedWeight: h1 && links ? 2 : 1,
    summaryCode: h1 && links ? "llms_valid" : "llms_malformed",
    evidence: {
      has_h1: h1,
      has_links: links,
      ...(reading.state === "cut" ? { truncated: true, read_limit: reading.readLimit } : {}),
    },
    userImpactCode: "llms_informational",
    fixCode: h1 && links ? undefined : "repair_llms",
  });
};

const documentsOf = (artifacts: readonly FetchArtifact[], unreadCode: string) => {
  const readings = artifacts.map((artifact) => jsonDocumentOf(artifact, unreadCode));
  return {
    readings,
    documents: readings.flatMap((reading) => (reading.state === "document" ? [reading.value] : [])),
    // A verdict that no usable document exists needs every location answered.
    unknown: readings.length
      ? firstUnknown(readings)
      : ({ state: "unread", errorCode: unreadCode } as const),
    malformed: readings.some((reading) => reading.state === "malformed"),
  };
};

const unparseable = (
  id: number,
  status: "fail" | "partial",
  summaryCode: string,
  userImpactCode: string,
): CheckResult =>
  result({
    id,
    status,
    earnedWeight: 0,
    summaryCode,
    userImpactCode,
    fixCode: "repair_document_json",
  });

const mcpCheck = (artifacts: ScanArtifacts): CheckResult => {
  const { documents, unknown, malformed } = documentsOf(artifacts.mcp, "mcp_unavailable");
  if (!documents.length) {
    if (unknown)
      return unjudged(9, unknown, {
        summaryCode: "mcp_unavailable",
        userImpactCode: "mcp_not_assessed",
      });
    if (malformed) return unparseable(9, "fail", "mcp_card_unparseable", "mcp_callable_gap");
    return result({
      id: 9,
      status: "fail",
      earnedWeight: 0,
      summaryCode: "mcp_absent",
      userImpactCode: "mcp_callable_gap",
      fixCode: "publish_mcp_card",
    });
  }
  // The fields of the most nearly complete card found.
  const fieldsMissing = documents
    .map((document) => [
      ...((document.name ?? document.server ?? document.id) ? [] : ["name"]),
      ...((document.endpoint ?? document.url ?? document.transport) ? [] : ["endpoint"]),
    ])
    .reduce((fewest, missing) => (missing.length < fewest.length ? missing : fewest));
  const valid = fieldsMissing.length === 0;
  return result({
    id: 9,
    status: valid ? "pass" : "partial",
    earnedWeight: valid ? 6 : documents.length > 1 ? 4 : 2,
    summaryCode: valid ? "mcp_card_valid" : "mcp_card_incomplete",
    evidence: {
      documents_found: documents.length,
      ...(valid ? {} : { fields_missing: fieldsMissing }),
    },
    userImpactCode: "mcp_callable_readiness",
    fixCode: valid ? undefined : "complete_mcp_card",
  });
};

const ucpCheck = (artifacts: ScanArtifacts): CheckResult => {
  if (artifacts.segment !== "store")
    return result({
      id: 10,
      status: "not_applicable",
      earnedWeight: 0,
      summaryCode: "ucp_not_store",
      userImpactCode: "ucp_store_only",
      applicable: false,
    });
  const reading = jsonDocumentOf(artifacts.ucp, "ucp_unavailable");
  if (isUnknown(reading))
    return unjudged(10, reading, {
      summaryCode: "ucp_unavailable",
      userImpactCode: "ucp_not_assessed",
    });
  if (reading.state === "malformed")
    return unparseable(10, "fail", "ucp_profile_unparseable", "ucp_commerce_gap");
  if (reading.state === "absent")
    return result({
      id: 10,
      status: "fail",
      earnedWeight: 0,
      summaryCode: "ucp_absent",
      userImpactCode: "ucp_commerce_gap",
      fixCode: "publish_ucp_profile",
    });
  const document = reading.value;
  const fields = ["version", "services", "capabilities"].filter((field) =>
    fieldPresent(document, field),
  );
  const endpoint =
    fieldPresent(document, "endpoint") ||
    fieldPresent(document, "transport") ||
    fieldPresent(document, "services.shopping.endpoint");
  const complete = fields.length === 3 && endpoint;
  const fieldsMissing = [
    ...["version", "services", "capabilities"].filter((field) => !fields.includes(field)),
    ...(endpoint ? [] : ["endpoint"]),
  ];
  return result({
    id: 10,
    status: complete ? "pass" : "partial",
    earnedWeight: complete ? 6 : Math.max(2, Math.min(4, fields.length + Number(endpoint))),
    summaryCode: complete ? "ucp_valid" : "ucp_incomplete",
    evidence: {
      fields_present: fields,
      ...(complete ? {} : { fields_missing: fieldsMissing }),
      signing_keys_present: fieldPresent(document, "signing_keys"),
    },
    userImpactCode: "ucp_commerce_readiness",
    fixCode: complete ? undefined : "complete_ucp_profile",
  });
};

const DECLARES_AUTH = /oauth|bearer|authorization/i;
const authCards = (artifacts: Pick<ScanArtifacts, "mcp" | "ucp">): FetchArtifact[] => [
  ...artifacts.mcp,
  ...(artifacts.ucp ? [artifacts.ucp] : []),
];

/** Whether a discovery document or an HTTP challenge declares authorization. */
export const declaresAuth = (artifacts: Pick<ScanArtifacts, "base" | "mcp" | "ucp">): boolean =>
  documentsOf(authCards(artifacts), "card_unavailable").documents.some((document) =>
    DECLARES_AUTH.test(JSON.stringify(document)),
  ) ||
  [artifacts.base, ...artifacts.mcp].some((artifact) =>
    authSchemes(artifact?.headers["www-authenticate"]).some(
      (scheme) => scheme === "bearer" || scheme === "oauth",
    ),
  );

const oauthCheck = (artifacts: ScanArtifacts): CheckResult => {
  if (!declaresAuth(artifacts)) {
    // A card the scanner could not read may declare a sign-in it cannot see.
    const unread = documentsOf(authCards(artifacts), "card_unavailable").readings.find(isUnknown);
    if (unread)
      return unjudged(11, unread, {
        summaryCode: "oauth_unavailable",
        userImpactCode: "oauth_not_assessed",
      });
    return result({
      id: 11,
      status: "not_applicable",
      earnedWeight: 0,
      summaryCode: "oauth_not_declared",
      userImpactCode: "oauth_conditional",
      applicable: false,
    });
  }
  const { readings, documents, unknown, malformed } = documentsOf(
    artifacts.oauth,
    "oauth_fetch_incomplete",
  );
  if (artifacts.oauth.length < 2)
    return result({
      id: 11,
      status: "unavailable",
      earnedWeight: 0,
      summaryCode: "oauth_unavailable",
      evidence: { documents_found: documents.length },
      userImpactCode: "oauth_not_assessed",
      errorCode: "oauth_fetch_incomplete",
    });
  if (unknown)
    return unjudged(
      11,
      unknown,
      { summaryCode: "oauth_unavailable", userImpactCode: "oauth_not_assessed" },
      { documents_found: documents.length },
    );
  if (!documents.length)
    return malformed
      ? unparseable(11, "fail", "oauth_metadata_unparseable", "oauth_discovery_gap")
      : result({
          id: 11,
          status: "fail",
          earnedWeight: 0,
          summaryCode: "oauth_metadata_absent",
          userImpactCode: "oauth_discovery_gap",
          fixCode: "publish_oauth_metadata",
        });
  const httpsFields = documents.flatMap((document) =>
    ["issuer", "resource", "authorization_endpoint", "token_endpoint"].flatMap((field) =>
      typeof document[field] === "string" ? [[field, document[field] as string] as const] : [],
    ),
  );
  const notHttps = httpsFields
    .filter(([, value]) => !value.startsWith("https://"))
    .map(([field]) => field);
  const consistent = httpsFields.length > 0 && notHttps.length === 0;
  const documentsMissing = artifacts.oauth
    .filter((_, index) => readings[index]?.state !== "document")
    .map((artifact) =>
      artifact.url.includes("oauth-protected-resource")
        ? "protected resource metadata"
        : "authorization server metadata",
    );
  const complete = documents.length >= 2 && consistent;
  return result({
    id: 11,
    status: complete ? "pass" : "partial",
    earnedWeight: complete ? 4 : documents.length >= 2 ? 3 : 1,
    summaryCode: complete ? "oauth_metadata_valid" : "oauth_metadata_partial",
    evidence: {
      documents_found: documents.length,
      https_fields: consistent,
      ...(documentsMissing.length ? { documents_missing: documentsMissing } : {}),
      ...(notHttps.length ? { fields_not_https: notHttps } : {}),
    },
    userImpactCode: "oauth_discovery",
    fixCode: complete ? undefined : "complete_oauth_metadata",
  });
};

const ssrCheck = (artifacts: ScanArtifacts): CheckResult => {
  const base = artifacts.base;
  const representative = artifacts.representative;
  const usableBase = base && !inaccessible(base) ? base : undefined;
  const usableRepresentative =
    representative &&
    !inaccessible(representative) &&
    !isChallenge(representative.status, representative.body)
      ? representative
      : undefined;
  if (!usableBase && !(artifacts.segment === "store" && usableRepresentative))
    return result({
      id: 12,
      status: "unavailable",
      earnedWeight: 0,
      summaryCode: "ssr_unavailable",
      userImpactCode: "ssr_not_assessed",
      errorCode: base?.errorCode ?? "base_unavailable",
    });
  const baseSignals = usableBase ? signalsOf(usableBase) : NO_SIGNALS;
  const representativeSignals = usableRepresentative ? signalsOf(usableRepresentative) : NO_SIGNALS;
  const baseJsonLd = usableBase ? jsonLdOf(usableBase).nodes.length > 0 : false;
  const representativeJsonLd = usableRepresentative
    ? jsonLdOf(usableRepresentative).nodes.length > 0
    : false;
  const storeHomepagePass =
    baseSignals.textLength >= 300 &&
    (baseSignals.productLinkCount > 0 || (baseSignals.hasPrice && baseJsonLd));
  const representativePass =
    representativeSignals.textLength >= 150 &&
    representativeSignals.hasPrice &&
    (representativeJsonLd || representativeSignals.hasH1);
  const pass =
    artifacts.segment === "store"
      ? storeHomepagePass || representativePass
      : baseSignals.textLength >= 500 && baseSignals.hasH1 && baseSignals.hasTitle;
  const maximumTextLength = Math.max(baseSignals.textLength, representativeSignals.textLength);
  const anyJsonLd = baseJsonLd || representativeJsonLd;
  const partial = !pass && (maximumTextLength >= 150 || anyJsonLd);
  return result({
    id: 12,
    status: pass ? "pass" : partial ? "partial" : "fail",
    earnedWeight: pass ? 10 : partial ? 4 : 0,
    summaryCode: pass ? "ssr_content_substantive" : partial ? "ssr_content_thin" : "ssr_shell_only",
    evidence: {
      visible_text_chars: maximumTextLength,
      has_h1: baseSignals.hasH1 || representativeSignals.hasH1,
      has_title: baseSignals.hasTitle || representativeSignals.hasTitle,
      product_link_count: baseSignals.productLinkCount + representativeSignals.productLinkCount,
      has_price_signal: baseSignals.hasPrice || representativeSignals.hasPrice,
      has_jsonld: anyJsonLd,
      representative_checked: Boolean(usableRepresentative),
    },
    userImpactCode: "ssr_machine_readability",
    fixCode: pass ? undefined : "render_substantive_html",
  });
};

const agentUaCheck = (artifacts: ScanArtifacts): CheckResult => {
  const base = artifacts.base;
  if (!base || inaccessible(base))
    return result({
      id: 13,
      status: "unavailable",
      earnedWeight: 0,
      summaryCode: "agent_ua_neutral_unavailable",
      userImpactCode: "agent_ua_not_assessed",
      errorCode: base?.errorCode ?? "neutral_unavailable",
    });
  const chatgpt = artifacts.agentProbes.chatgpt;
  const claude = artifacts.agentProbes.claude;
  // robots.txt kept a request out by the rules it keeps for the agent the
  // request names, while its rules for the scanner let the scanner in: the
  // notice telling the owner to allow the scanner would not explain it, so
  // the check carries a code of its own and names the agents it kept out.
  const keptOut = (probe?: FetchArtifact) => probe?.errorCode === "agent_robots_disallowed";
  if (keptOut(chatgpt) || keptOut(claude))
    return result({
      id: 13,
      status: "unavailable",
      earnedWeight: 0,
      summaryCode: "agent_ua_robots_disallowed",
      evidence: {
        chatgpt_robots_disallowed: keptOut(chatgpt),
        claude_robots_disallowed: keptOut(claude),
      },
      userImpactCode: "agent_ua_not_assessed",
      errorCode: "agent_robots_disallowed",
    });
  if (!chatgpt || !claude || inaccessible(chatgpt) || inaccessible(claude))
    return result({
      id: 13,
      status: "unavailable",
      earnedWeight: 0,
      summaryCode: "agent_ua_probe_unavailable",
      userImpactCode: "agent_ua_not_assessed",
      errorCode: "agent_probe_unavailable",
    });
  const probeAccessible = (probe: typeof chatgpt): boolean =>
    probe.status >= 200 &&
    probe.status < 300 &&
    !isChallenge(probe.status, probe.body) &&
    comparableTexts(textOf(base), textOf(probe));
  const chatgptAccessible = probeAccessible(chatgpt);
  const claudeAccessible = probeAccessible(claude);
  const count = [chatgptAccessible, claudeAccessible].filter(Boolean).length;
  return result({
    id: 13,
    status: count === 2 ? "pass" : count === 1 ? "partial" : "fail",
    earnedWeight: count === 2 ? 8 : count === 1 ? 4 : 0,
    summaryCode:
      count === 2 ? "agent_ua_compatible" : count === 1 ? "agent_ua_partial" : "agent_ua_blocked",
    evidence: {
      chatgpt_probe_accessible: chatgptAccessible,
      claude_probe_accessible: claudeAccessible,
    },
    userImpactCode: "agent_ua_accessibility",
    fixCode: count === 2 ? undefined : "allow_agent_user_agents",
  });
};

const performanceCheck = (artifacts: ScanArtifacts): CheckResult => {
  const base = artifacts.base;
  if (!base || inaccessible(base))
    return result({
      id: 14,
      status: "unavailable",
      earnedWeight: 0,
      summaryCode: "page_performance_unavailable",
      userImpactCode: "page_performance_not_assessed",
      errorCode: base?.errorCode ?? "base_unavailable",
    });
  if (base.truncated || base.durationMs >= 8_000)
    return result({
      id: 14,
      status: "fail",
      earnedWeight: 0,
      summaryCode: "page_performance_limit_exceeded",
      evidence: {
        decoded_bytes: base.decodedBytes,
        ttfb_ms: base.ttfbMs,
        total_ms: base.durationMs,
        truncated: base.truncated,
      },
      userImpactCode: "page_performance_agent_cost",
      fixCode: "reduce_page_weight_latency",
    });
  const weight = base.decodedBytes < 2 * 1024 * 1024;
  const timing = base.ttfbMs < 1_500 && base.durationMs < 4_000;
  return result({
    id: 14,
    status: weight && timing ? "pass" : weight || timing ? "partial" : "fail",
    earnedWeight: weight && timing ? 4 : weight || timing ? 2 : 0,
    summaryCode:
      weight && timing
        ? "page_performance_within_budget"
        : weight || timing
          ? "page_performance_partial"
          : "page_performance_slow_heavy",
    evidence: {
      decoded_bytes: base.decodedBytes,
      ttfb_ms: base.ttfbMs,
      total_ms: base.durationMs,
      single_region_measurement: true,
    },
    userImpactCode: "page_performance_agent_cost",
    fixCode: weight && timing ? undefined : "reduce_page_weight_latency",
  });
};

const FEED_TYPES = ["application/rss+xml", "application/atom+xml", "application/xml", "text/csv"];
const FEED_ADDRESSES = ["feed", "merchant", "products.xml", "products.csv"];

// Whether some `<link>` declares a feed, by a feed's media type or by an
// address that names one. `lower` is the page through asciiLower.
const linksFeed = (lower: string): boolean => {
  const text = (span: Span): string => lower.slice(span.start, span.end);
  for (let tag = nextTag(lower, "link", 0); tag; tag = nextTag(lower, "link", tag.end + 1)) {
    if (quotedValues(lower, "type=", tag).some((type) => FEED_TYPES.includes(text(type))))
      return true;
    if (
      quotedValues(lower, "href=", tag).some((href) => {
        const address = text(href);
        return FEED_ADDRESSES.some((word) => address.includes(word));
      })
    )
      return true;
  }
  return false;
};

// Whether an Open Graph type of product is declared: `og:type` and a quote,
// then, before the next `>`, a content attribute whose quoted value begins
// with "product". `lower` is the page through asciiLower.
const declaresProduct = (lower: string): boolean => {
  for (let at = lower.indexOf("og:type"); at !== -1; ) {
    const quote = at + "og:type".length;
    if (!isQuote(lower.charCodeAt(quote))) {
      at = lower.indexOf("og:type", at + 1);
      continue;
    }
    const close = lower.indexOf(">", quote + 1);
    const rest = lower.slice(quote + 1, close === -1 ? lower.length : close);
    if (rest.includes('content="product') || rest.includes("content='product")) return true;
    if (close === -1) return false;
    at = lower.indexOf("og:type", close + 1);
  }
  return false;
};

const feedCheck = (artifacts: ScanArtifacts): CheckResult => {
  if (artifacts.segment !== "store")
    return result({
      id: 15,
      status: "not_applicable",
      earnedWeight: 0,
      summaryCode: "feed_not_store",
      userImpactCode: "feed_store_only",
      applicable: false,
    });
  const pages = [artifacts.base, artifacts.representative].filter(
    (page): page is FetchArtifact => Boolean(page) && !inaccessible(page),
  );
  if (!pages.length)
    return result({
      id: 15,
      status: "unavailable",
      earnedWeight: 0,
      summaryCode: "feed_unavailable",
      userImpactCode: "feed_not_assessed",
      errorCode:
        artifacts.base?.errorCode ?? artifacts.representative?.errorCode ?? "base_unavailable",
    });
  const body = pages.map((page) => page.body).join("\n");
  const lower = asciiLower(body);
  const feedLink = linksFeed(lower);
  const product =
    declaresProduct(lower) ||
    /(?:product:price|\bsku\b|\bgtin\b)/i.test(body) ||
    pages.some((page) =>
      jsonLdOf(page).nodes.some((node) => jsonLdTypes(node).includes("Product")),
    );
  const priceAvailability = /(?:price|availability|in_stock|out_of_stock)/i.test(body);
  if (feedLink)
    return result({
      id: 15,
      status: "pass",
      earnedWeight: 4,
      summaryCode: "feed_discoverable",
      evidence: {
        feed_link: true,
        product_identifiers: product,
        price_availability: priceAvailability,
      },
      userImpactCode: "feed_machine_discovery",
    });
  if (product)
    return result({
      id: 15,
      status: "partial",
      earnedWeight: priceAvailability ? 3 : 1,
      summaryCode: "feed_machine_signals_only",
      evidence: {
        feed_link: false,
        product_identifiers: product,
        price_availability: priceAvailability,
      },
      userImpactCode: "feed_machine_discovery",
      fixCode: "publish_product_feed",
    });
  return result({
    id: 15,
    status: "fail",
    earnedWeight: 0,
    summaryCode: "feed_signals_absent",
    userImpactCode: "feed_machine_discovery_gap",
    fixCode: "publish_product_feed",
  });
};

const fingerprintCheck = (): CheckResult =>
  result({
    id: 16,
    status: "pass",
    earnedWeight: 0,
    summaryCode: "fingerprint_observed",
    userImpactCode: "fingerprint_informational",
    applicable: true,
  });

const a2aCheck = (artifacts: ScanArtifacts): CheckResult => {
  const reading = jsonDocumentOf(artifacts.a2a, "a2a_unavailable");
  if (isUnknown(reading))
    return unjudged(17, reading, {
      summaryCode: "a2a_unavailable",
      userImpactCode: "a2a_not_assessed",
    });
  if (reading.state === "malformed")
    return unparseable(17, "partial", "a2a_card_unparseable", "a2a_informational");
  if (reading.state === "absent")
    return result({
      id: 17,
      status: "not_applicable",
      earnedWeight: 0,
      summaryCode: "a2a_absent",
      userImpactCode: "a2a_optional",
      applicable: false,
    });
  const document = reading.value;
  const fieldsMissing = [
    ...["name", "version", "skills"].filter((field) => !fieldPresent(document, field)),
    ...(fieldPresent(document, "url") || fieldPresent(document, "supportedInterfaces")
      ? []
      : ["url or supportedInterfaces"]),
  ];
  const valid = fieldsMissing.length === 0;
  return result({
    id: 17,
    status: valid ? "pass" : "partial",
    earnedWeight: valid ? 1 : 0,
    summaryCode: valid ? "a2a_valid" : "a2a_card_incomplete",
    evidence: valid ? {} : { fields_missing: fieldsMissing },
    userImpactCode: "a2a_informational",
    fixCode: valid ? undefined : "repair_a2a_card",
  });
};

const hreflangCheck = (artifacts: ScanArtifacts): CheckResult => {
  const base = artifacts.base;
  if (!base || inaccessible(base))
    return result({
      id: 18,
      status: "unavailable",
      earnedWeight: 0,
      summaryCode: "hreflang_unavailable",
      userImpactCode: "hreflang_not_assessed",
      errorCode: base?.errorCode ?? "base_unavailable",
    });
  const tags = signalsOf(base).hreflangs;
  if (tags.length < 2)
    return result({
      id: 18,
      status: "not_applicable",
      earnedWeight: 0,
      summaryCode: "hreflang_single_locale",
      userImpactCode: "hreflang_conditional",
      applicable: false,
    });
  const valid = tags.filter((tag) => tag === "x-default" || /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(tag));
  const duplicate = new Set(tags).size !== tags.length;
  const complete = valid.length === tags.length && !duplicate;
  return result({
    id: 18,
    status: complete ? "pass" : "partial",
    earnedWeight: complete ? 2 : 1,
    summaryCode: complete ? "hreflang_valid" : "hreflang_partial",
    evidence: {
      locale_count: tags.length,
      valid_locale_count: valid.length,
      duplicate,
    },
    userImpactCode: "locale_discovery",
    fixCode: complete ? undefined : "repair_hreflang",
  });
};

export const evaluateChecks = (artifacts: ScanArtifacts): CheckResult[] => {
  const robotsReading = readRobots(artifacts.robots);
  const robotsParsed = robotsReading.parsed;
  const targetUrl = new URL(artifacts.canonicalTargetUrl);
  const targetPath = `${targetUrl.pathname || "/"}${targetUrl.search}`;
  const robotsMissing = artifacts.robots.status === 404 || artifacts.robots.status === 410;
  const robotsReadable =
    artifacts.robots.status === 200 && !artifacts.robots.errorCode && !robotsParsed.fatal;
  const targetVerdict = robotsMissing
    ? true
    : robotsReadable
      ? scannerVerdict(robotsReading, targetPath)
      : undefined;
  const targetContentAllowed = targetVerdict === true;
  // A robots.txt the network kept from being read names that failure.
  const robotsBlockedCode =
    targetVerdict === false
      ? "robots_disallowed"
      : artifacts.robots.status === 0 && artifacts.robots.errorCode
        ? artifacts.robots.errorCode
        : "robots_unavailable";
  // Content robots.txt kept the scanner from reads as a request that never
  // happened, carrying the reason, so every check that needed it names it.
  const withheld: FetchArtifact = {
    url: artifacts.canonicalTargetUrl,
    status: 0,
    headers: {},
    body: "",
    decodedBytes: 0,
    truncated: false,
    durationMs: 0,
    ttfbMs: 0,
    errorCode: robotsBlockedCode,
  };
  // A store's structured data and feed may live only on its product pages, so
  // a product page the scanner could not read leaves that data unassessed,
  // with the reason, rather than absent.
  const representative = targetContentAllowed ? artifacts.representative : undefined;
  const productUnread =
    representative && (inaccessible(representative) || representative.status >= 400)
      ? (representative.errorCode ?? "product_page_unavailable")
      : undefined;
  // A home page answered with a bot challenge in its place was not read: no
  // check measures the challenge as if it were the site, and each that
  // needed the home page says it was blocked.
  const challenged =
    targetContentAllowed &&
    artifacts.base &&
    !artifacts.base.errorCode &&
    isChallenge(artifacts.base.status, artifacts.base.body)
      ? { ...artifacts.base, errorCode: BASE_BLOCKED }
      : undefined;
  const readable = challenged ? { ...artifacts, base: challenged } : artifacts;
  const effective = !targetContentAllowed
    ? {
        ...artifacts,
        base: withheld,
        representative: undefined,
        markdown: withheld,
        agentProbes: {},
      }
    : productUnread
      ? { ...readable, representative: undefined }
      : readable;
  const checks = [
    ...robotsChecks(artifacts),
    sitemapCheck(artifacts),
    ...jsonLdChecks(effective),
    markdownCheck(effective),
    llmsCheck(artifacts.llms),
    mcpCheck(artifacts),
    ucpCheck(artifacts),
    oauthCheck(artifacts),
    ssrCheck(effective),
    agentUaCheck(effective),
    performanceCheck(effective),
    feedCheck(effective),
    fingerprintCheck(),
    a2aCheck(artifacts),
    hreflangCheck(effective),
  ];
  const baseTruncated = Boolean(effective.base?.truncated && !inaccessible(effective.base));
  const pagesTruncated =
    baseTruncated ||
    Boolean(effective.representative?.truncated && !inaccessible(effective.representative));
  const comparisonTruncated = (probe?: FetchArtifact): boolean =>
    Boolean(
      probe &&
        (baseTruncated || probe.truncated) &&
        !inaccessible(probe) &&
        probe.status >= 200 &&
        probe.status < 300 &&
        !isChallenge(probe.status, probe.body),
    );
  return checks
    .map((check) => {
      const absence = PRODUCT_PAGE_ABSENCES[check.id];
      if (productUnread && absence?.absent(check))
        return result({
          id: check.id,
          status: "unavailable",
          earnedWeight: 0,
          summaryCode: absence.summaryCode,
          userImpactCode: absence.userImpactCode,
          errorCode: productUnread,
        });

      let truncated = false;
      let uncertain = false;
      switch (check.id) {
        case 5:
          truncated = pagesTruncated;
          uncertain = check.summaryCode === "jsonld_absent_or_invalid";
          break;
        case 6:
          truncated = pagesTruncated;
          uncertain = Boolean(absence?.absent(check));
          break;
        case 7:
          truncated = baseTruncated || Boolean(effective.markdown?.truncated);
          uncertain =
            check.summaryCode === "markdown_negotiation_partial" &&
            !(check.evidence.non_empty === false && !effective.markdown?.truncated) &&
            varyNames(effective.markdown?.headers.vary).includes("accept");
          break;
        case 12:
          truncated = artifacts.segment === "store" ? pagesTruncated : baseTruncated;
          uncertain = check.status === "fail" || check.status === "partial";
          break;
        case 13: {
          truncated =
            baseTruncated ||
            Boolean(
              effective.agentProbes.chatgpt?.truncated || effective.agentProbes.claude?.truncated,
            );
          const chatgptUnassessed =
            check.evidence.chatgpt_probe_accessible === false &&
            comparisonTruncated(effective.agentProbes.chatgpt);
          const claudeUnassessed =
            check.evidence.claude_probe_accessible === false &&
            comparisonTruncated(effective.agentProbes.claude);
          uncertain = chatgptUnassessed || claudeUnassessed;
          const refusalObserved =
            (check.evidence.chatgpt_probe_accessible === false && !chatgptUnassessed) ||
            (check.evidence.claude_probe_accessible === false && !claudeUnassessed);
          if (uncertain && refusalObserved) {
            const evidence: CheckResult["evidence"] = { ...check.evidence, truncated: true };
            if (chatgptUnassessed) {
              delete evidence.chatgpt_probe_accessible;
              evidence.chatgpt_probe_unassessed = true;
            }
            if (claudeUnassessed) {
              delete evidence.claude_probe_accessible;
              evidence.claude_probe_unassessed = true;
            }
            return { ...check, summaryCode: "agent_ua_refusal_observed", evidence };
          }
          break;
        }
        case 15:
          truncated = artifacts.segment === "store" && pagesTruncated;
          uncertain = check.status === "fail" || check.status === "partial";
          break;
        case 18:
          truncated = baseTruncated;
          uncertain = check.status === "not_applicable";
          break;
      }
      if (!truncated) return check;
      const evidence = { ...check.evidence, truncated: true };
      // A prefix proves what it contains, not what the rest of the page lacks.
      return uncertain
        ? result({
            id: check.id,
            status: "unavailable",
            earnedWeight: 0,
            summaryCode: "html_truncated",
            userImpactCode: "html_not_assessed",
            errorCode: "html_truncated",
            evidence,
            durationMs: check.durationMs,
          })
        : { ...check, evidence };
    })
    .sort((left, right) => left.id - right.id);
};

const PRODUCT_PAGE_ABSENCES: Record<
  number,
  { absent: (check: CheckResult) => boolean; summaryCode: string; userImpactCode: string }
> = {
  5: {
    absent: (check) =>
      check.summaryCode === "jsonld_absent_or_invalid" && check.evidence.script_count === 0,
    summaryCode: "jsonld_unavailable",
    userImpactCode: "structured_data_not_assessed",
  },
  6: {
    absent: (check) =>
      check.summaryCode === "vertical_jsonld_missing" ||
      check.summaryCode === "vertical_jsonld_wrong_type",
    summaryCode: "vertical_jsonld_unavailable",
    userImpactCode: "structured_data_not_assessed",
  },
  15: {
    absent: (check) => check.summaryCode === "feed_signals_absent",
    summaryCode: "feed_unavailable",
    userImpactCode: "feed_not_assessed",
  },
};
