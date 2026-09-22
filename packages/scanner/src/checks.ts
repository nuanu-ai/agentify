import {
  CHECK_DEFINITIONS,
  type CheckResult,
  type Segment,
} from "@agentify/scanner-contracts";
import type { FetchArtifact, ScanArtifacts } from "./model.js";
import {
  comparableBodies,
  htmlSignals,
  isChallenge,
  jsonLdTypes,
  parseJsonLd,
  parseSafeJson,
  parseSitemap,
  visibleText,
} from "./parsers.js";
import { explicitAiPolicies, isPathAllowed, parseRobots } from "./robots.js";

export const CHECK_WEIGHTS: readonly number[] = CHECK_DEFINITIONS.map(
  (definition) => definition.nominalWeight,
);

const checkWeight = (id: number): number => {
  const weight = CHECK_WEIGHTS[id - 1];
  if (weight === undefined)
    throw new Error(`check ${id} has no definition, so it has no weight`);
  return weight;
};

type TerminalCheckStatus =
  "pass" | "partial" | "fail" | "unavailable" | "not_applicable";
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

const inaccessible = (artifact?: FetchArtifact): boolean =>
  !artifact ||
  Boolean(artifact.errorCode) ||
  artifact.status === 0 ||
  artifact.status >= 500;
const missing = (artifact?: FetchArtifact): boolean =>
  !artifact || artifact.status === 404 || artifact.status === 410;

const robotsChecks = (artifacts: ScanArtifacts): CheckResult[] => {
  const fetch = artifacts.robots;
  const parsed = parseRobots(fetch.body);
  const common = { durationMs: fetch.durationMs };
  let robots: CheckResult;
  if (fetch.errorCode || fetch.status === 0 || fetch.status >= 500) {
    robots = result({
      id: 1,
      status: "unavailable",
      earnedWeight: 0,
      summaryCode: "robots_unavailable",
      evidence: {},
      userImpactCode: "robots_not_assessed",
      errorCode: fetch.errorCode ?? "robots_http_error",
      ...common,
    });
  } else if (fetch.status === 404 || fetch.status === 410) {
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
  } else if (fetch.status !== 200 || parsed.fatal) {
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
    const partial =
      parsed.malformedDirectives > 0 ||
      /text\/html/i.test(fetch.headers["content-type"] ?? "");
    robots = result({
      id: 1,
      status: partial ? "partial" : "pass",
      earnedWeight: partial ? 2 : 5,
      summaryCode: partial ? "robots_partially_parseable" : "robots_parseable",
      evidence: {
        status: fetch.status,
        size: fetch.decodedBytes,
        sitemap_count: parsed.sitemaps.length,
        group_count: parsed.groups.length,
        malformed_directives: parsed.malformedDirectives,
      },
      userImpactCode: "robots_policy_discoverability",
      fixCode: partial ? "repair_robots" : undefined,
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
  else if (robots.status === "fail" && fetch.status !== 200)
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
        values: Object.entries(parsed.contentSignal ?? {}).map(
          ([key, value]) => `${key}:${value}`,
        ),
      },
      userImpactCode: "content_signal_explicit",
    });
  return [robots, ai, contentSignal];
};

const sitemapCheck = (artifacts: ScanArtifacts): CheckResult => {
  const available = artifacts.sitemap.filter(
    (artifact) => !inaccessible(artifact) && !missing(artifact),
  );
  if (!available.length) {
    if (artifacts.sitemap.some((artifact) => missing(artifact)))
      return result({
        id: 4,
        status: "fail",
        earnedWeight: 0,
        summaryCode: "sitemap_missing",
        userImpactCode: "sitemap_discovery_gap",
        fixCode: "publish_sitemap",
      });
    return result({
      id: 4,
      status: "unavailable",
      earnedWeight: 0,
      summaryCode: "sitemap_unavailable",
      userImpactCode: "sitemap_not_assessed",
      errorCode: artifacts.sitemap[0]?.errorCode ?? "sitemap_unavailable",
    });
  }
  const parsed = available.map((artifact) => parseSitemap(artifact.body));
  const valid = parsed.filter((entry) => entry.valid);
  if (!valid.length)
    return result({
      id: 4,
      status: "fail",
      earnedWeight: 0,
      summaryCode: "sitemap_invalid",
      evidence: { files_checked: available.length },
      userImpactCode: "sitemap_discovery_gap",
      fixCode: "repair_sitemap",
    });
  const lastmods = valid.flatMap((entry) => entry.lastmods);
  const staleCutoff = Date.now() - 180 * 86_400_000;
  const stale = lastmods.filter(
    (value) =>
      !Number.isFinite(Date.parse(value)) || Date.parse(value) < staleCutoff,
  ).length;
  const childUnavailable =
    valid.some((entry) => entry.isIndex) &&
    artifacts.sitemap.some(inaccessible);
  const staleRatio = lastmods.length ? stale / lastmods.length : 1;
  const partial = childUnavailable || !lastmods.length || staleRatio > 0.8;
  return result({
    id: 4,
    status: partial ? "partial" : "pass",
    earnedWeight: partial ? (childUnavailable ? 2 : 4) : 6,
    summaryCode: partial ? "sitemap_partial" : "sitemap_valid",
    evidence: {
      files_checked: artifacts.sitemap.length,
      url_count: valid.flatMap((entry) => entry.urls).length,
      lastmod_count: lastmods.length,
      stale_ratio_percent: Math.round(staleRatio * 100),
    },
    userImpactCode: "sitemap_discovery",
    fixCode: partial ? "improve_sitemap" : undefined,
    durationMs: artifacts.sitemap.reduce(
      (sum, artifact) => sum + artifact.durationMs,
      0,
    ),
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

const verticalProfile = (
  segment: Segment,
  nodes: Record<string, unknown>[],
) => {
  const nodeTypes = nodes.map((node) => ({ node, types: jsonLdTypes(node) }));
  const choose = (...types: string[]) =>
    nodeTypes.find((entry) => entry.types.some((type) => types.includes(type)));
  if (segment === "store")
    return {
      selected: choose("Product"),
      required: [
        "name",
        "image",
        "url",
        "offers.price",
        "offers.priceCurrency",
      ],
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
      recommended: [
        "telephone",
        "openingHoursSpecification",
        "geo",
        "priceRange",
        "makesOffer",
      ],
    };
  const product = choose("Product");
  if (product)
    return {
      selected: product,
      required: [
        "name",
        "image",
        "url",
        "offers.price",
        "offers.priceCurrency",
      ],
      recommended: ["offers.availability"],
    };
  const local = choose("LocalBusiness", "Restaurant", "Hotel", "Store");
  if (local)
    return {
      selected: local,
      required: ["name", "address"],
      recommended: [
        "telephone",
        "openingHoursSpecification",
        "geo",
        "priceRange",
      ],
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
          artifacts.base?.errorCode ??
          artifacts.representative?.errorCode ??
          "base_unavailable",
      }),
      result({
        id: 6,
        status: "unavailable",
        earnedWeight: 0,
        summaryCode: "vertical_jsonld_unavailable",
        userImpactCode: "structured_data_not_assessed",
        errorCode:
          artifacts.base?.errorCode ??
          artifacts.representative?.errorCode ??
          "base_unavailable",
      }),
    ];
  const parsedPages = pages.map((page) => parseJsonLd(page.body));
  const parsed = {
    nodes: parsedPages.flatMap(({ nodes }) => nodes),
    scriptCount: parsedPages.reduce((sum, page) => sum + page.scriptCount, 0),
    invalidCount: parsedPages.reduce((sum, page) => sum + page.invalidCount, 0),
  };
  const presence = parsed.nodes.length
    ? parsed.invalidCount
      ? "partial"
      : "pass"
    : "fail";
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
  const requiredFound = profile.required.filter((field) =>
    fieldPresent(selected.node, field),
  );
  const recommendedFound = profile.recommended.filter((field) =>
    fieldPresent(selected.node, field),
  );
  const requiredRatio = requiredFound.length / profile.required.length;
  const recommendedRatio = recommendedFound.length / profile.recommended.length;
  const complete = requiredRatio === 1 && recommendedRatio >= 0.5;
  const points = complete
    ? 12
    : Math.max(
        3,
        Math.min(
          9,
          Math.round(12 * (requiredRatio * 0.7 + recommendedRatio * 0.3)),
        ),
      );
  return [
    check5,
    result({
      id: 6,
      status: complete ? "pass" : "partial",
      earnedWeight: points,
      summaryCode: complete
        ? "vertical_jsonld_complete"
        : "vertical_jsonld_incomplete",
      evidence: {
        type: jsonLdTypes(selected.node)[0] ?? "unknown",
        required_found: requiredFound,
        required_missing: profile.required.filter(
          (field) => !requiredFound.includes(field),
        ),
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
  const vary = markdown.headers.vary ?? "";
  const representationDiffers = artifacts.base
    ? markdown.body.trim() !== artifacts.base.body.trim()
    : false;
  const semanticParity = artifacts.base
    ? comparableBodies(markdown.body, artifacts.base.body)
    : false;
  const correctType = /text\/markdown/i.test(type);
  const nonEmpty = visibleText(markdown.body).length > 20;
  if (
    markdown.status >= 200 &&
    markdown.status < 300 &&
    correctType &&
    /(?:^|,)\s*accept\s*(?:,|$)/i.test(vary) &&
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
  // v1 artifact set does not fetch a declared .md alternate, so only a real
  // Markdown response can earn partial credit here.
  if (markdown.status >= 200 && markdown.status < 300 && correctType)
    return result({
      id: 7,
      status: "partial",
      earnedWeight: /\*/.test(vary) || !nonEmpty ? 2 : 6,
      summaryCode: "markdown_negotiation_partial",
      evidence: {
        content_type: type,
        vary_accept: /accept/i.test(vary),
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

const llmsCheck = (artifact?: FetchArtifact): CheckResult => {
  if (!artifact || missing(artifact))
    return result({
      id: 8,
      status: "not_applicable",
      earnedWeight: 0,
      summaryCode: "llms_absent",
      userImpactCode: "llms_optional",
      applicable: false,
    });
  if (inaccessible(artifact))
    return result({
      id: 8,
      status: "unavailable",
      earnedWeight: 0,
      summaryCode: "llms_unavailable",
      userImpactCode: "llms_not_assessed",
      errorCode: artifact.errorCode ?? "llms_unavailable",
    });
  const h1 = /^#\s+\S+/m.test(artifact.body);
  const links = /\[[^\]]+\]\(https?:\/\//i.test(artifact.body);
  return result({
    id: 8,
    status: h1 && links ? "pass" : "partial",
    earnedWeight: h1 && links ? 2 : 1,
    summaryCode: h1 && links ? "llms_valid" : "llms_malformed",
    evidence: { has_h1: h1, has_links: links },
    userImpactCode: "llms_informational",
    fixCode: h1 && links ? undefined : "repair_llms",
  });
};

const validDiscovery = (
  artifact: FetchArtifact | undefined,
): Record<string, unknown> | undefined => {
  if (!artifact || artifact.status < 200 || artifact.status >= 300)
    return undefined;
  const parsed = parseSafeJson(artifact.body);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
};

const mcpCheck = (artifacts: ScanArtifacts): CheckResult => {
  const documents = artifacts.mcp
    .map(validDiscovery)
    .filter((value): value is Record<string, unknown> => Boolean(value));
  if (!documents.length) {
    if (artifacts.mcp.some((artifact) => inaccessible(artifact)))
      return result({
        id: 9,
        status: "unavailable",
        earnedWeight: 0,
        summaryCode: "mcp_unavailable",
        userImpactCode: "mcp_not_assessed",
        errorCode: "mcp_unavailable",
      });
    return result({
      id: 9,
      status: "fail",
      earnedWeight: 0,
      summaryCode: "mcp_absent",
      userImpactCode: "mcp_callable_gap",
      fixCode: "publish_mcp_card",
    });
  }
  const valid = documents.some(
    (document) =>
      Boolean(document.endpoint ?? document.url ?? document.transport) &&
      Boolean(document.name ?? document.server ?? document.id),
  );
  return result({
    id: 9,
    status: valid ? "pass" : "partial",
    earnedWeight: valid ? 6 : documents.length > 1 ? 4 : 2,
    summaryCode: valid ? "mcp_card_valid" : "mcp_card_incomplete",
    evidence: {
      documents_found: documents.length,
      identity_present: documents.some((document) =>
        Boolean(document.name ?? document.server ?? document.id),
      ),
      endpoint_present: documents.some((document) =>
        Boolean(document.endpoint ?? document.url ?? document.transport),
      ),
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
  const document = validDiscovery(artifacts.ucp);
  if (!document) {
    if (artifacts.ucp && inaccessible(artifacts.ucp))
      return result({
        id: 10,
        status: "unavailable",
        earnedWeight: 0,
        summaryCode: "ucp_unavailable",
        userImpactCode: "ucp_not_assessed",
        errorCode: artifacts.ucp.errorCode ?? "ucp_unavailable",
      });
    return result({
      id: 10,
      status: "fail",
      earnedWeight: 0,
      summaryCode: "ucp_absent",
      userImpactCode: "ucp_commerce_gap",
      fixCode: "publish_ucp_profile",
    });
  }
  const fields = ["version", "services", "capabilities"].filter((field) =>
    fieldPresent(document, field),
  );
  const endpoint =
    fieldPresent(document, "endpoint") ||
    fieldPresent(document, "transport") ||
    fieldPresent(document, "services.shopping.endpoint");
  const complete = fields.length === 3 && endpoint;
  return result({
    id: 10,
    status: complete ? "pass" : "partial",
    earnedWeight: complete
      ? 6
      : Math.max(2, Math.min(4, fields.length + Number(endpoint))),
    summaryCode: complete ? "ucp_valid" : "ucp_incomplete",
    evidence: {
      fields_present: fields,
      endpoint_present: endpoint,
      signing_keys_present: fieldPresent(document, "signing_keys"),
    },
    userImpactCode: "ucp_commerce_readiness",
    fixCode: complete ? undefined : "complete_ucp_profile",
  });
};

const declaresAuth = (artifacts: ScanArtifacts): boolean => {
  const documents = [
    ...artifacts.mcp,
    ...(artifacts.ucp ? [artifacts.ucp] : []),
  ]
    .map(validDiscovery)
    .filter(Boolean);
  return (
    documents.some((document) =>
      /oauth|bearer|authorization/i.test(JSON.stringify(document)),
    ) ||
    [artifacts.base, ...artifacts.mcp].some((artifact) =>
      /bearer|oauth/i.test(artifact?.headers["www-authenticate"] ?? ""),
    )
  );
};

const oauthCheck = (artifacts: ScanArtifacts): CheckResult => {
  if (!declaresAuth(artifacts))
    return result({
      id: 11,
      status: "not_applicable",
      earnedWeight: 0,
      summaryCode: "oauth_not_declared",
      userImpactCode: "oauth_conditional",
      applicable: false,
    });
  const documents = artifacts.oauth
    .map(validDiscovery)
    .filter((value): value is Record<string, unknown> => Boolean(value));
  if (!documents.length) {
    if (artifacts.oauth.some((artifact) => inaccessible(artifact)))
      return result({
        id: 11,
        status: "unavailable",
        earnedWeight: 0,
        summaryCode: "oauth_unavailable",
        userImpactCode: "oauth_not_assessed",
        errorCode: "oauth_unavailable",
      });
    return result({
      id: 11,
      status: "fail",
      earnedWeight: 0,
      summaryCode: "oauth_metadata_absent",
      userImpactCode: "oauth_discovery_gap",
      fixCode: "publish_oauth_metadata",
    });
  }
  const httpsFields = documents
    .flatMap((document) => [
      document.issuer,
      document.resource,
      document.authorization_endpoint,
      document.token_endpoint,
    ])
    .filter((value): value is string => typeof value === "string");
  const consistent =
    httpsFields.length > 0 &&
    httpsFields.every((value) => value.startsWith("https://"));
  const complete = documents.length >= 2 && consistent;
  return result({
    id: 11,
    status: complete ? "pass" : "partial",
    earnedWeight: complete ? 4 : documents.length >= 2 ? 3 : 1,
    summaryCode: complete ? "oauth_metadata_valid" : "oauth_metadata_partial",
    evidence: { documents_found: documents.length, https_fields: consistent },
    userImpactCode: "oauth_discovery",
    fixCode: complete ? undefined : "complete_oauth_metadata",
  });
};

const ssrCheck = (artifacts: ScanArtifacts): CheckResult => {
  const base = artifacts.base;
  const representative = artifacts.representative;
  const usableBase =
    base && !inaccessible(base) && !isChallenge(base.status, base.body)
      ? base
      : undefined;
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
      errorCode:
        base?.errorCode ?? (base ? "base_blocked" : "robots_disallowed"),
    });
  const baseSignals = htmlSignals(usableBase?.body ?? "");
  const representativeSignals = htmlSignals(usableRepresentative?.body ?? "");
  const baseJsonLd = parseJsonLd(usableBase?.body ?? "").nodes.length > 0;
  const representativeJsonLd =
    parseJsonLd(usableRepresentative?.body ?? "").nodes.length > 0;
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
      : baseSignals.textLength >= 500 &&
        baseSignals.hasH1 &&
        baseSignals.hasTitle;
  const maximumTextLength = Math.max(
    baseSignals.textLength,
    representativeSignals.textLength,
  );
  const anyJsonLd = baseJsonLd || representativeJsonLd;
  const partial = !pass && (maximumTextLength >= 150 || anyJsonLd);
  return result({
    id: 12,
    status: pass ? "pass" : partial ? "partial" : "fail",
    earnedWeight: pass ? 10 : partial ? 4 : 0,
    summaryCode: pass
      ? "ssr_content_substantive"
      : partial
        ? "ssr_content_thin"
        : "ssr_shell_only",
    evidence: {
      visible_text_chars: maximumTextLength,
      has_h1: baseSignals.hasH1 || representativeSignals.hasH1,
      has_title: baseSignals.hasTitle || representativeSignals.hasTitle,
      product_link_count:
        baseSignals.productLinkCount + representativeSignals.productLinkCount,
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
  if (!base || inaccessible(base) || isChallenge(base.status, base.body))
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
    comparableBodies(base.body, probe.body);
  const chatgptAccessible = probeAccessible(chatgpt);
  const claudeAccessible = probeAccessible(claude);
  const count = [chatgptAccessible, claudeAccessible].filter(Boolean).length;
  return result({
    id: 13,
    status: count === 2 ? "pass" : count === 1 ? "partial" : "fail",
    earnedWeight: count === 2 ? 8 : count === 1 ? 4 : 0,
    summaryCode:
      count === 2
        ? "agent_ua_compatible"
        : count === 1
          ? "agent_ua_partial"
          : "agent_ua_blocked",
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
        artifacts.base?.errorCode ??
        artifacts.representative?.errorCode ??
        "base_unavailable",
    });
  const body = pages.map((page) => page.body).join("\n");
  const feedLink =
    /<link\b[^>]*(?:type=["'](?:application\/(?:rss\+xml|atom\+xml|xml)|text\/csv)["']|href=["'][^"']*(?:feed|merchant|products\.(?:xml|csv))[^"']*["'])/i.test(
      body,
    );
  const product =
    /(?:og:type["'][^>]*content=["']product|product:price|\bsku\b|\bgtin\b)/i.test(
      body,
    ) ||
    parseJsonLd(body).nodes.some((node) =>
      jsonLdTypes(node).includes("Product"),
    );
  const priceAvailability =
    /(?:price|availability|in_stock|out_of_stock)/i.test(body);
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
  const document = validDiscovery(artifacts.a2a);
  if (!document) {
    if (artifacts.a2a && inaccessible(artifacts.a2a))
      return result({
        id: 17,
        status: "unavailable",
        earnedWeight: 0,
        summaryCode: "a2a_unavailable",
        userImpactCode: "a2a_not_assessed",
        errorCode: artifacts.a2a.errorCode ?? "a2a_unavailable",
      });
    if (
      artifacts.noncanonicalA2aHint ||
      (artifacts.a2a && !missing(artifacts.a2a))
    )
      return result({
        id: 17,
        status: "partial",
        earnedWeight: 0,
        summaryCode: "a2a_noncanonical_or_malformed",
        userImpactCode: "a2a_informational",
        fixCode: "repair_a2a_card",
      });
    return result({
      id: 17,
      status: "not_applicable",
      earnedWeight: 0,
      summaryCode: "a2a_absent",
      userImpactCode: "a2a_optional",
      applicable: false,
    });
  }
  const valid =
    ["name", "version", "skills"].every((field) =>
      fieldPresent(document, field),
    ) &&
    (fieldPresent(document, "url") ||
      fieldPresent(document, "supportedInterfaces"));
  return result({
    id: 17,
    status: valid ? "pass" : "partial",
    earnedWeight: valid ? 1 : 0,
    summaryCode: valid ? "a2a_valid" : "a2a_malformed",
    evidence: {
      name_present: fieldPresent(document, "name"),
      version_present: fieldPresent(document, "version"),
      interface_present:
        fieldPresent(document, "url") ||
        fieldPresent(document, "supportedInterfaces"),
      skills_present: fieldPresent(document, "skills"),
    },
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
  const tags = htmlSignals(base.body).hreflangs;
  if (tags.length < 2)
    return result({
      id: 18,
      status: "not_applicable",
      earnedWeight: 0,
      summaryCode: "hreflang_single_locale",
      userImpactCode: "hreflang_conditional",
      applicable: false,
    });
  const valid = tags.filter(
    (tag) => tag === "x-default" || /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(tag),
  );
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
  const robotsParsed = parseRobots(artifacts.robots.body);
  const targetPath = new URL(artifacts.canonicalTargetUrl).pathname || "/";
  const targetContentAllowed =
    artifacts.robots.status === 404 ||
    artifacts.robots.status === 410 ||
    (artifacts.robots.status === 200 &&
      !artifacts.robots.errorCode &&
      !robotsParsed.fatal &&
      isPathAllowed(robotsParsed, "agentify-scanner", targetPath));
  const effective = targetContentAllowed
    ? artifacts
    : {
        ...artifacts,
        base: undefined,
        representative: undefined,
        markdown: undefined,
        agentProbes: {},
      };
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
  return checks.sort((left, right) => left.id - right.id);
};
