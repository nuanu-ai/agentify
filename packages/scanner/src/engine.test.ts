import type { CheckResult, Segment } from "@agentify/scanner-contracts";
import { describe, expect, it } from "vitest";
import { evaluateScan } from "./engine.js";
import type { FetchArtifact, ScanArtifacts } from "./model.js";
import { levelForScore, scoreChecks } from "./scoring.js";

const artifact = (
  url: string,
  body: string,
  overrides: Partial<FetchArtifact> = {},
): FetchArtifact => ({
  url,
  status: 200,
  headers: { "content-type": "text/html" },
  body,
  decodedBytes: Buffer.byteLength(body),
  truncated: false,
  durationMs: 100,
  ttfbMs: 50,
  ...overrides,
});

const robots = `User-agent: *\nAllow: /\nContent-Signal: search=yes, ai-input=no, ai-train=no\n${[
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "PerplexityBot",
  "Google-Extended",
]
  .map((agent) => `User-agent: ${agent}\nAllow: /`)
  .join("\n")}`;

const html = `<!doctype html><html><head><title>Fixture Store</title><link rel="alternate" hreflang="en" href="https://example.com/en"><link rel="alternate" hreflang="de" href="https://example.com/de"><script src="https://cdn.shopify.com/a.js"></script><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name: "Widget", image: "https://example.com/a.jpg", url: "https://example.com/product/widget", offers: { price: "19", priceCurrency: "USD", availability: "InStock" } })}</script></head><body><h1>Fixture Store</h1><main>${"Substantive deterministic product information for machines. ".repeat(12)}<a href="/product/widget">Widget $19 USD</a><meta property="product:price:amount" content="19"><link rel="alternate" type="application/xml" href="/products.xml"></main></body></html>`;

const makeArtifacts = (segment: Segment): ScanArtifacts => ({
  segment,
  canonicalTargetUrl: "https://example.com/",
  robots: artifact("https://example.com/robots.txt", robots, {
    headers: { "content-type": "text/plain" },
  }),
  base: artifact("https://example.com/", html, {
    headers: { "content-type": "text/html", vary: "Accept" },
  }),
  markdown: artifact(
    "https://example.com/",
    `# Fixture\n\n${"Markdown product catalog. ".repeat(20)}`,
    { headers: { "content-type": "text/markdown", vary: "Accept" } },
  ),
  agentProbes: {
    chatgpt: artifact("https://example.com/", html),
    claude: artifact("https://example.com/", html),
  },
  sitemap: [
    artifact(
      "https://example.com/sitemap.xml",
      `<urlset><url><loc>https://example.com/product/widget</loc><lastmod>${new Date().toISOString()}</lastmod></url></urlset>`,
      { headers: { "content-type": "application/xml" } },
    ),
  ],
  llms: artifact(
    "https://example.com/llms.txt",
    "# Example\n\n- [Catalog](https://example.com/catalog)",
    { headers: { "content-type": "text/markdown" } },
  ),
  mcp: [
    artifact(
      "https://example.com/.well-known/mcp.json",
      '{"name":"MCP","endpoint":"https://example.com/mcp"}',
      { headers: { "content-type": "application/json" } },
    ),
    artifact(
      "https://example.com/.well-known/mcp/server-card.json",
      "not found",
      { status: 404 },
    ),
  ],
  ...(segment === "store"
    ? {
        ucp: artifact(
          "https://example.com/.well-known/ucp",
          '{"version":"1","endpoint":"https://example.com/ucp","services":{"shopping":{}},"capabilities":["catalog"]}',
          { headers: { "content-type": "application/json" } },
        ),
      }
    : {}),
  oauth: [],
  a2a: artifact(
    "https://example.com/.well-known/agent-card.json",
    '{"name":"Agent","version":"1","url":"https://example.com/a2a","skills":["catalog"]}',
    { headers: { "content-type": "application/json" } },
  ),
});

describe("18-check engine", () => {
  it("evaluates each canonical check once and keeps nominal weights at 100", () => {
    const evaluation = evaluateScan(makeArtifacts("store"));
    expect(evaluation.checks.map((check) => check.id)).toEqual(
      Array.from({ length: 18 }, (_, index) => index + 1),
    );
    expect(
      evaluation.checks.reduce((sum, check) => sum + check.nominalWeight, 0),
    ).toBe(100);
    expect(evaluation.score.nominalWeight).toBe(100);
    expect(evaluation.fingerprint.platform).toMatchObject({ value: "Shopify" });
  });

  it("does not penalize non-store, no-auth, missing optional files or single locale", () => {
    const input = makeArtifacts("owner");
    input.llms = artifact("https://example.com/llms.txt", "not found", {
      status: 404,
    });
    input.a2a = artifact(
      "https://example.com/.well-known/agent-card.json",
      "not found",
      { status: 404 },
    );
    input.base = artifact(
      "https://example.com/",
      html.replace(/<link rel="alternate" hreflang="de"[^>]+>/, ""),
    );
    const checks = evaluateScan(input).checks;
    expect(checks.find((check) => check.id === 10)?.status).toBe(
      "not_applicable",
    );
    expect(checks.find((check) => check.id === 11)?.status).toBe(
      "not_applicable",
    );
    expect(checks.find((check) => check.id === 15)?.status).toBe(
      "not_applicable",
    );
    expect(checks.find((check) => check.id === 8)?.status).toBe(
      "not_applicable",
    );
    expect(checks.find((check) => check.id === 17)?.status).toBe(
      "not_applicable",
    );
    expect(checks.find((check) => check.id === 18)?.status).toBe(
      "not_applicable",
    );
  });

  it("turns unavailable checks into coverage loss, not score loss", () => {
    const input = makeArtifacts("store");
    input.base = artifact("https://example.com/", "", {
      status: 0,
      errorCode: "fetch_timeout",
    });
    input.markdown = artifact("https://example.com/", "", {
      status: 0,
      errorCode: "fetch_timeout",
    });
    input.agentProbes = {};
    const evaluation = evaluateScan(input);
    expect(evaluation.checks.find((check) => check.id === 12)?.status).toBe(
      "unavailable",
    );
    expect(evaluation.score.coverage).toBeLessThan(1);
    expect(evaluation.score.terminalStatus).toBe("partial");
  });

  it("does not award Markdown credit for an unrelated alternate link", () => {
    const input = makeArtifacts("owner");
    input.base = artifact("https://example.com/", html, {
      headers: {
        "content-type": "text/html",
        link: '<https://example.com/feed.xml>; rel="alternate"; type="application/xml"',
      },
    });
    input.markdown = artifact("https://example.com/", html, {
      headers: { "content-type": "text/html" },
    });

    expect(
      evaluateScan(input).checks.find((check) => check.id === 7),
    ).toMatchObject({
      status: "fail",
      earnedWeight: 0,
      summaryCode: "markdown_negotiation_absent",
    });
  });

  it("does not award Markdown credit to an HTTP error representation", () => {
    const input = makeArtifacts("owner");
    input.markdown = artifact(
      "https://example.com/",
      "# Rate limited\n\nThis is an error response, not a usable representation.",
      {
        status: 429,
        headers: { "content-type": "text/markdown", vary: "Accept" },
      },
    );

    expect(
      evaluateScan(input).checks.find((check) => check.id === 7),
    ).toMatchObject({
      status: "fail",
      earnedWeight: 0,
      summaryCode: "markdown_negotiation_absent",
    });
  });

  it("passes a distinct Markdown representation with semantic HTML parity", () => {
    const input = makeArtifacts("owner");
    input.markdown = artifact(
      "https://example.com/",
      `# Fixture Store\n\n${"Substantive deterministic product information for machines. ".repeat(12)}\n\n[Widget — $19 USD](https://example.com/product/widget)`,
      {
        headers: { "content-type": "text/markdown", vary: "Accept" },
      },
    );

    expect(
      evaluateScan(input).checks.find((check) => check.id === 7),
    ).toMatchObject({
      status: "pass",
      earnedWeight: 8,
      summaryCode: "markdown_negotiation_valid",
      evidence: { differentiated: true, semantic_parity: true },
    });
  });

  it("keeps unrelated Markdown partial even when its headers are valid", () => {
    const input = makeArtifacts("owner");

    expect(
      evaluateScan(input).checks.find((check) => check.id === 7),
    ).toMatchObject({
      status: "partial",
      earnedWeight: 6,
      evidence: { differentiated: true, semantic_parity: false },
    });
  });

  it("uses the representative store detail for JSON-LD, SSR and feed checks", () => {
    const input = makeArtifacts("store");
    input.base = artifact(
      "https://example.com/",
      "<html><head><title>Store</title></head><body><h1>Store</h1><main>Short catalog shell.</main></body></html>",
    );
    input.representative = artifact(
      "https://example.com/products/widget",
      html,
    );
    const checks = evaluateScan(input).checks;
    expect(checks.find((check) => check.id === 5)?.status).toBe("pass");
    expect(checks.find((check) => check.id === 6)?.status).toBe("pass");
    expect(checks.find((check) => check.id === 12)?.status).toBe("pass");
    expect(checks.find((check) => check.id === 15)?.status).not.toBe("fail");
  });

  it.each([
    [24, "invisible"],
    [25, "readable"],
    [49, "readable"],
    [50, "callable_ready"],
    [69, "callable_ready"],
    [70, "ahead_of_market"],
  ])("maps score %s to %s", (score, level) =>
    expect(levelForScore(score, 1)).toBe(level),
  );

  it("keeps the published level available at exactly seventy percent coverage", () => {
    expect(levelForScore(70, 0.7)).toBe("ahead_of_market");
    expect(levelForScore(70, 0.699)).toBe("incomplete");
  });

  it("derives score and terminal state from assessed applicable weight", () => {
    const check = (
      id: 1 | 2,
      status: "pass" | "fail" | "unavailable",
      applicableWeight: number,
      earnedWeight: number,
    ): CheckResult => ({
      id,
      status,
      nominalWeight: applicableWeight,
      applicableWeight,
      earnedWeight,
      summaryCode: "test",
      evidence: {},
      userImpactCode: "test",
      durationMs: 0,
    });

    expect(
      scoreChecks([check(1, "pass", 70, 70), check(2, "fail", 30, 0)]),
    ).toMatchObject({
      score: 70,
      coverage: 1,
      level: "ahead_of_market",
      terminalStatus: "completed",
      applicableWeight: 100,
      assessedWeight: 100,
      earnedWeight: 70,
    });

    expect(
      scoreChecks([check(1, "pass", 30, 30), check(2, "unavailable", 70, 0)]),
    ).toMatchObject({
      score: 100,
      coverage: 0.3,
      level: "incomplete",
      terminalStatus: "partial",
    });

    expect(
      scoreChecks([check(1, "pass", 29, 29), check(2, "unavailable", 71, 0)]),
    ).toMatchObject({
      score: null,
      coverage: 0.29,
      level: "incomplete",
      terminalStatus: "failed",
    });

    expect(
      scoreChecks([
        check(1, "unavailable", 0, 0),
        check(2, "unavailable", 0, 0),
      ]),
    ).toMatchObject({
      score: null,
      coverage: 0,
      assessedWeight: 0,
      terminalStatus: "failed",
    });
  });

  it("hides score below 0.30 coverage", () => {
    const checks: CheckResult[] = Array.from({ length: 18 }, (_, index) => ({
      id: (index + 1) as CheckResult["id"],
      status: index === 0 ? "pass" : "unavailable",
      nominalWeight: index === 0 ? 5 : 95 / 17,
      applicableWeight: index === 0 ? 5 : 95 / 17,
      earnedWeight: index === 0 ? 5 : 0,
      summaryCode: "test",
      evidence: {},
      userImpactCode: "test",
      durationMs: 0,
    }));
    expect(scoreChecks(checks)).toMatchObject({
      score: null,
      terminalStatus: "failed",
      level: "incomplete",
    });
  });
});
