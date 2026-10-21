import type { CheckResult, Segment } from "@agentify/scanner-contracts";
import { describe, expect, it } from "vitest";
import { evaluateScan } from "./engine.js";
import type { FetchArtifact, ScanArtifacts } from "./model.js";
import { visibleText } from "./parsers.js";
import { baseBlocked, levelForScore, scoreChecks } from "./scoring.js";

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
    artifact("https://example.com/.well-known/mcp/server-card.json", "not found", { status: 404 }),
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

const withBase = (page: string): ScanArtifacts => ({
  ...makeArtifacts("store"),
  base: artifact("https://example.com/", page),
});
const withLlms = (body: string): ScanArtifacts => ({
  ...makeArtifacts("store"),
  llms: artifact("https://example.com/llms.txt", body, {
    headers: { "content-type": "text/markdown" },
  }),
});
const check = (input: ScanArtifacts, id: number) =>
  evaluateScan(input).checks.find((candidate) => candidate.id === id);

describe("what the checks read from the markup real sites write", () => {
  // A page that is the site's own: the same page as the base and as both
  // agent probes, so checks 12 and 13 read only it.
  const asEverywhere = (page: string, status = 200): ScanArtifacts => ({
    ...makeArtifacts("store"),
    base: artifact("https://example.com/", page, { status }),
    agentProbes: {
      chatgpt: artifact("https://example.com/", page, { status }),
      claude: artifact("https://example.com/", page, { status }),
    },
  });
  const assessed = (input: ScanArtifacts) =>
    [12, 13].map((id) => check(input, id)?.status === "unavailable");

  it("reads a page that only mentions a captcha or carries Cloudflare's bot detection", () => {
    // Shopify puts the first script on every store's pages for its forms'
    // captcha; Cloudflare appends the second to tell bots from browsers.
    const shopify = `<script id="captcha-bootstrap">!function(){'use strict';const t='contact',e='account',n='new_comment'}();</script>`;
    const cloudflare = `<script>(function(){function c(){var b=a.contentDocument||a.contentWindow.document;if(b){var d=b.createElement('script');d.innerHTML="var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(a);";b.getElementsByTagName('head')[0].appendChild(d)}}})();</script>`;
    for (const script of [shopify, cloudflare])
      expect(assessed(asEverywhere(html.replace("</body>", `${script}</body>`)))).toEqual([
        false,
        false,
      ]);
  });

  it("takes a challenge served in place of the page for one, by the marks its vendor leaves", () => {
    // Walmart's PerimeterX page, Etsy's DataDome page and Glassdoor's Cloudflare
    // page, as each served them, cut to the marks that name them.
    for (const page of [
      `<html><head><title>Robot or human?</title></head><body><div class="re-captcha"><div id="px-captcha"></div></div></body></html>`,
      `<html><head><title>etsy.com</title></head><body><script data-cfasync="false">var dd={'rt':'c','host':'geo.captcha-delivery.com'}</script><script data-cfasync="false" src="https://ct.captcha-delivery.com/c.js"></script></body></html>`,
      `<html><head><title>Just a moment...</title></head><body><script>(function(){window._cf_chl_opt = {cType: 'managed'};var a = document.createElement('script');a.src = '/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=a462393f6927d7aa';}());</script></body></html>`,
    ])
      for (const status of [200, 403])
        expect(assessed(asEverywhere(page, status))).toEqual([true, true]);
  });

  it("reaches no verdict when the home page was a challenge, and reads nothing off it", () => {
    // Etsy's DataDome page, as it served it to the scanner in place of the
    // home page.
    const challenge = `<html><head><title>etsy.com</title></head><body><script data-cfasync="false">var dd={'rt':'c','host':'geo.captcha-delivery.com'}</script><script data-cfasync="false" src="https://ct.captcha-delivery.com/c.js"></script></body></html>`;
    for (const status of [200, 403]) {
      const evaluation = evaluateScan({
        ...makeArtifacts("store"),
        base: artifact("https://example.com/", challenge, { status }),
      });
      const homePageChecks = [5, 6, 12, 13, 14, 15, 18];
      expect(
        evaluation.checks
          .filter((candidate) => homePageChecks.includes(candidate.id))
          .map((candidate) => [candidate.id, candidate.status]),
      ).toEqual(homePageChecks.map((id) => [id, "unavailable"]));
      expect(evaluation.score).toMatchObject({
        score: null,
        level: "incomplete",
        terminalStatus: "failed",
      });
    }
  });

  it("gives no level when the product page could be read around a challenged home page", () => {
    // The product page carries enough for most checks, so coverage alone
    // would publish a level; the challenge still withholds it.
    const challenge = `<html><head><title>Just a moment...</title></head><body><script>(function(){window._cf_chl_opt = {cType: 'managed'};}());</script></body></html>`;
    const evaluation = evaluateScan({
      ...makeArtifacts("store"),
      base: artifact("https://example.com/", challenge, { status: 403 }),
      representative: artifact("https://example.com/product/widget", html),
    });
    expect(evaluation.score.coverage).toBeGreaterThanOrEqual(0.7);
    expect(evaluation.score).toMatchObject({
      score: null,
      level: "incomplete",
      terminalStatus: "failed",
    });
  });

  it("keeps the verdict of a home page that merely says the words a challenge says", () => {
    const ordinary = evaluateScan(makeArtifacts("store"));
    for (const words of ["Access Denied hacker T-shirt", "Please verify you are human to log in"]) {
      const evaluation = evaluateScan({
        ...makeArtifacts("store"),
        base: artifact("https://example.com/", html.replace("</body>", `<p>${words}</p></body>`)),
      });

      expect(baseBlocked(evaluation.checks), words).toBe(false);
      expect(evaluation.score.score, words).toBe(ordinary.score.score);
    }
    // The same words on an error status are the refusal they say they are.
    const refused = evaluateScan({
      ...makeArtifacts("store"),
      base: artifact("https://example.com/", "<html><body>Access denied</body></html>", {
        status: 405,
      }),
    });
    expect(baseBlocked(refused.checks)).toBe(true);
  });

  it("does not call a home page that could not be reached a block", () => {
    const evaluation = evaluateScan({
      ...makeArtifacts("store"),
      base: artifact("https://example.com/", "Service unavailable", { status: 503 }),
    });
    expect(baseBlocked(evaluation.checks)).toBe(false);
    expect(evaluation.score.terminalStatus).toBe("partial");
  });

  it("finds a feed a page links to by its type or by its address", () => {
    for (const link of [
      '<link rel="alternate" type="application/rss+xml" title="Example &raquo; Feed" href="https://example.com/feed/" />',
      '<link rel="alternate" type="application/atom+xml" title="Feed" href="/blogs/news.atom" />',
      '<link href="/blog_rss.xml" rel="alternate" title="RSS" type="application/rss+xml">',
      "<LINK REL='alternate' HREF='https://example.com/merchant/products.csv'>",
      '<link rel="alternate" type="text/csv" title="Catalog" href="/catalog">',
      '<link rel="alternate" type="application/xml" title="Catalog" href="/catalog">',
      '<link rel="alternate" href="https://example.com/feed/">',
      '<link rel="alternate" href="https://example.com/google-merchant-center">',
      '<link rel="alternate" href="https://example.com/products.xml">',
    ])
      expect(check(withBase(`<head>${link}</head><body>Wool</body>`), 15)?.evidence).toMatchObject({
        feed_link: true,
      });
    expect(
      check(withBase('<link rel="stylesheet" href="/assets/base.css"><p>Wool</p>'), 15)?.status,
    ).toBe("fail");
  });

  it("recognizes a product page by its Open Graph type when it links no feed", () => {
    const page = `<meta property="og:type" content="product"><meta property='og:title' content='Wool Runner'><p>Wool</p>`;
    expect(check(withBase(page), 15)).toMatchObject({
      status: "partial",
      evidence: { feed_link: false, product_identifiers: true },
    });
    const website = `<meta property="og:type" content="website"><p>Wool</p>`;
    expect(check(withBase(website), 15)?.status).toBe("fail");
    const singleQuoted = `<meta property='og:type' content='product'><p>Wool</p>`;
    expect(check(withBase(singleQuoted), 15)?.evidence).toMatchObject({
      product_identifiers: true,
    });
    // A product value in another tag, such as Twitter's product card, is not
    // an Open Graph type.
    const card = `<meta property="og:type" content="website"><meta name="twitter:card" content="product"><p>Wool</p>`;
    expect(check(withBase(card), 15)?.status).toBe("fail");
  });

  it("counts an llms.txt link only when it leads to an absolute address", () => {
    const absolute = `# llms.txt\n\n> A proposal.\n\n## Docs\n\n- [llms.txt proposal](https://llmstxt.org/index.md): The proposal for llms.txt\n`;
    expect(check(withLlms(absolute), 8)?.evidence).toEqual({ has_h1: true, has_links: true });
    const relative = "# Example\n\n## Docs\n\n- [Catalog](/catalog.md): every product\n";
    expect(check(withLlms(relative), 8)?.evidence).toEqual({ has_h1: true, has_links: false });
    const plain = "# Example\n\n- [Catalog](http://example.com/catalog.md)\n";
    expect(check(withLlms(plain), 8)?.evidence).toEqual({ has_h1: true, has_links: true });
    const untitled = "# Example\n\n- [](https://example.com/catalog.md)\n";
    expect(check(withLlms(untitled), 8)?.evidence).toEqual({ has_h1: true, has_links: false });
  });
});

describe("OAuth discovery evidence", () => {
  const declared = (): ScanArtifacts => ({
    ...makeArtifacts("owner"),
    mcp: [artifact("https://example.com/.well-known/mcp.json", '{"authorization":"oauth2"}')],
  });
  const missing = (path: string) =>
    artifact(`https://example.com/.well-known/${path}`, "", { status: 404 });
  const metadata = () =>
    artifact(
      "https://example.com/.well-known/oauth-authorization-server",
      JSON.stringify({
        issuer: "https://example.com",
        authorization_endpoint: "https://example.com/oauth/authorize",
        token_endpoint: "https://example.com/oauth/token",
      }),
    );

  it.each([
    { oauth: [] as FetchArtifact[] },
    { oauth: [missing("oauth-authorization-server")] },
    { oauth: [metadata()] },
  ])("does not claim missing metadata from an incomplete set of answers: %j", ({ oauth }) => {
    const input = { ...declared(), oauth };
    const evaluation = evaluateScan(input);
    const checked = evaluation.checks.find(({ id }) => id === 11);
    expect(checked).toMatchObject({ status: "unavailable", errorCode: "oauth_fetch_incomplete" });
    expect(checked?.fixCode).toBeUndefined();
    expect(evaluation.findings.negativeCheckIds).not.toContain(11);
    expect(evaluation.score.coverage).toBeLessThan(1);
  });

  it("keeps one observed document without calling an unanswered document missing", () => {
    const input = declared();
    input.oauth = [
      metadata(),
      artifact("https://example.com/.well-known/oauth-protected-resource", "", {
        status: 0,
        errorCode: "fetch_timeout",
      }),
    ];
    const checked = check(input, 11);
    expect(checked).toMatchObject({
      status: "unavailable",
      errorCode: "fetch_timeout",
      evidence: { documents_found: 1 },
    });
    expect(checked?.fixCode).toBeUndefined();
  });

  it("reports metadata missing after both discovery locations answered not found", () => {
    const input = declared();
    input.oauth = [missing("oauth-authorization-server"), missing("oauth-protected-resource")];
    expect(check(input, 11)).toMatchObject({ status: "fail", fixCode: "publish_oauth_metadata" });
  });

  it("keeps a confirmed missing document actionable when the other was found", () => {
    const input = declared();
    input.oauth = [metadata(), missing("oauth-protected-resource")];
    expect(check(input, 11)).toMatchObject({
      status: "partial",
      fixCode: "complete_oauth_metadata",
    });
  });
});

describe("a scan of a truncated HTML response", () => {
  const plain = "<html><head><title>Coffee</title></head><body><h1>Coffee</h1>";
  const productData = (evaluation: ReturnType<typeof evaluateScan>) =>
    evaluation.checks.filter(({ id }) => [5, 6, 15].includes(id));

  it.each(["base", "representative"] as const)(
    "does not call product data absent beyond the unread part of the %s page",
    (page) => {
      const input = withBase(plain);
      input[page] = artifact(`https://example.com/${page}`, plain, { truncated: true });
      const evaluation = evaluateScan(input);

      for (const checked of productData(evaluation)) {
        expect(checked).toMatchObject({
          status: "unavailable",
          earnedWeight: 0,
          errorCode: "html_truncated",
          evidence: { truncated: true },
        });
        expect(checked.fixCode).toBeUndefined();
        expect(evaluation.findings.negativeCheckIds).not.toContain(checked.id);
      }
      expect(evaluation.score.coverage).toBeLessThan(1);
      expect(evaluation.score.terminalStatus).toBe("partial");
      if (page === "base") {
        expect(evaluation.checks.find(({ id }) => id === 14)).toMatchObject({
          status: "fail",
          evidence: { truncated: true },
        });
      }
    },
  );

  it.each(["base", "representative"] as const)(
    "credits complete product data already read from a truncated %s page",
    (page) => {
      const input = withBase(plain);
      input[page] = artifact(`https://example.com/${page}`, html, { truncated: true });
      for (const checked of productData(evaluateScan(input))) {
        expect(checked.status).toBe("pass");
        expect(checked.earnedWeight).toBe(checked.applicableWeight);
        expect(checked.evidence.truncated).toBe(true);
      }
    },
  );

  it("uses a complete product page even when the home page was cut short", () => {
    const input = withBase(plain);
    input.base = artifact("https://example.com/", plain, { truncated: true });
    input.representative = artifact("https://example.com/products/widget", html);
    expect(productData(evaluateScan(input)).map(({ status }) => status)).toEqual([
      "pass",
      "pass",
      "pass",
    ]);
  });

  it.each([
    { "@type": "Organization", name: "Fixture Store", url: "https://example.com/" },
    { "@type": "Product", name: "Widget" },
  ])(
    "keeps observed JSON-LD but does not infer missing product facts from a prefix: %j",
    (node) => {
      const input = withBase(plain);
      input.base = artifact(
        "https://example.com/",
        `${plain}<script type="application/ld+json">${JSON.stringify(node)}</script>`,
        { truncated: true },
      );
      const evaluated = productData(evaluateScan(input));
      expect(evaluated.find(({ id }) => id === 5)?.status).toBe("pass");
      for (const id of node["@type"] === "Product" ? [15] : [6, 15]) {
        const checked = evaluated.find((candidate) => candidate.id === id);
        expect(checked).toMatchObject({ status: "unavailable", errorCode: "html_truncated" });
        expect(checked?.fixCode).toBeUndefined();
      }
      if (node["@type"] === "Product") {
        expect(evaluated.find(({ id }) => id === 6)).toMatchObject({
          status: "partial",
          evidence: { required_missing: expect.arrayContaining(["image", "offers.price"]) },
        });
      }
    },
  );

  it("does not call a JSON-LD block invalid when the read stopped inside it", () => {
    const input = withBase(plain);
    input.base = artifact(
      "https://example.com/",
      `${plain}<script type="application/ld+json">{"@type":"Product","name":"Widget`,
      { truncated: true },
    );
    expect(productData(evaluateScan(input)).map(({ status }) => status)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
  });

  it("records a malformed block without claiming there is no valid block in the unread tail", () => {
    const input = withBase(plain);
    input.base = artifact(
      "https://example.com/",
      `${plain}<script type="application/ld+json">{"@type":</script>`,
      { truncated: true },
    );
    expect(productData(evaluateScan(input)).find(({ id }) => id === 5)).toMatchObject({
      status: "unavailable",
      evidence: { invalid_script_count: 1 },
    });
  });

  it("still reports missing product data when the whole page was read", () => {
    const input = withBase(`${plain}</body></html>`);
    const evaluation = evaluateScan(input);
    expect(productData(evaluation).map(({ status }) => status)).toEqual(["fail", "fail", "fail"]);
    expect(evaluation.checks.find(({ id }) => id === 14)?.status).toBe("pass");
  });

  it.each([7, 12, 13, 18])(
    "does not infer missing HTML content for check %i from a prefix",
    (id) => {
      const input = withBase(plain);
      input.base = artifact("https://example.com/", plain, { truncated: true });
      const checked = check(input, id);
      expect(checked).toMatchObject({ status: "unavailable", errorCode: "html_truncated" });
      expect(checked?.applicableWeight).toBeGreaterThan(0);
      expect(checked?.fixCode).toBeUndefined();
    },
  );

  it("keeps sufficient content and successful comparisons already proved by the prefix", () => {
    const input = withBase(html);
    input.base = artifact("https://example.com/", html, { truncated: true });
    input.markdown = artifact("https://example.com/", visibleText(html), {
      headers: { "content-type": "text/markdown", vary: "Accept" },
    });
    for (const id of [7, 12, 13, 18]) {
      expect(check(input, id)).toMatchObject({ status: "pass", evidence: { truncated: true } });
    }
  });

  it("keeps a proven Markdown header error even when its body was truncated", () => {
    const input = makeArtifacts("store");
    input.markdown = artifact("https://example.com/", "# Store", {
      headers: { "content-type": "text/markdown", vary: "Accept-Encoding" },
      truncated: true,
    });
    expect(check(input, 7)?.status).toBe("partial");
  });

  it("keeps an unusably short complete Markdown response despite truncated HTML", () => {
    const input = withBase(plain);
    input.base = artifact("https://example.com/", plain, { truncated: true });
    input.markdown = artifact("https://example.com/", "# x", {
      headers: { "content-type": "text/markdown", vary: "Accept" },
    });
    expect(check(input, 7)).toMatchObject({
      status: "partial",
      evidence: { non_empty: false },
      fixCode: "repair_markdown_negotiation",
    });
  });

  it("does not judge a short Markdown prefix as the whole representation", () => {
    const input = makeArtifacts("store");
    input.markdown = artifact("https://example.com/", "# x", {
      headers: { "content-type": "text/markdown", vary: "Accept" },
      truncated: true,
    });
    expect(check(input, 7)).toMatchObject({ status: "unavailable", errorCode: "html_truncated" });
  });

  it.each([
    { status: 403, body: "Forbidden", baseTruncated: false },
    { status: 200, body: '<div id="px-captcha"></div>', baseTruncated: true },
  ])("keeps a proven agent refusal while the other comparison is unknown: %j", (refusal) => {
    const input = makeArtifacts("store");
    input.base = artifact("https://example.com/", html, { truncated: refusal.baseTruncated });
    input.agentProbes = {
      chatgpt: artifact("https://example.com/", refusal.body, { status: refusal.status }),
      claude: artifact("https://example.com/", plain, { truncated: !refusal.baseTruncated }),
    };
    const checked = check(input, 13);
    expect(checked).toMatchObject({
      status: "fail",
      summaryCode: "agent_ua_refusal_observed",
      evidence: { chatgpt_probe_accessible: false, claude_probe_unassessed: true, truncated: true },
      fixCode: "allow_agent_user_agents",
    });
    expect(checked?.evidence.claude_probe_accessible).toBeUndefined();
    expect(evaluateScan(input).findings.negativeCheckIds).toContain(13);
  });

  it("keeps proven user-agent refusals even when the plain response was truncated", () => {
    const input = withBase(plain);
    input.base = artifact("https://example.com/", plain, { truncated: true });
    input.agentProbes = {
      chatgpt: artifact("https://example.com/", "Forbidden", { status: 403 }),
      claude: artifact("https://example.com/", "Forbidden", { status: 403 }),
    };
    expect(check(input, 13)?.status).toBe("fail");
  });

  it("keeps malformed language alternatives already found in a prefix", () => {
    const input = withBase(plain);
    input.base = artifact("https://example.com/", html.replace('hreflang="de"', 'hreflang="?"'), {
      truncated: true,
    });
    expect(check(input, 18)?.status).toBe("partial");
  });
});

describe("a scan of pages as large as the fetch admits", () => {
  // What the checks read themselves, at the sizes the fetch admits: a feed
  // link and an Open Graph type in a page of up to 2 MiB, and a link in an
  // llms.txt of up to 512 KiB.
  const pageCap = 2 * 1024 * 1024;
  const textCap = 512 * 1024;
  const budgetMs = 500;
  const fill = (unit: string, room: number): string =>
    unit.repeat(Math.floor((room - 256) / unit.length));
  const scan = (input: ScanArtifacts) => {
    const started = performance.now();
    const evaluation = evaluateScan(input);
    return { evaluation, ms: performance.now() - started };
  };
  const checkIn = (evaluation: ReturnType<typeof evaluateScan>, id: number) =>
    evaluation.checks.find((candidate) => candidate.id === id);

  it("finds the feed link after link tags that run on for megabytes", () => {
    const closed = scan(
      withBase(
        `${fill("<link ", pageCap)}><link rel="alternate" type="application/rss+xml" href="/feed/">`,
      ),
    );
    expect(checkIn(closed.evaluation, 15)?.evidence).toMatchObject({ feed_link: true });
    expect(closed.ms).toBeLessThan(budgetMs);
    const unclosed = scan(withBase(fill('<link href="', pageCap)));
    expect(checkIn(unclosed.evaluation, 15)?.status).toBe("fail");
    expect(unclosed.ms).toBeLessThan(budgetMs);
  });

  it("recognizes a product page after an Open Graph tag that runs on for megabytes", () => {
    const page = `${fill('<meta property="og:type" ', pageCap)}><meta property="og:type" content="product">`;
    const { evaluation, ms } = scan(withBase(page));
    expect(checkIn(evaluation, 15)?.evidence).toMatchObject({
      feed_link: false,
      product_identifiers: true,
    });
    expect(ms).toBeLessThan(budgetMs);
  });

  it("finds the llms.txt link after brackets that never lead anywhere", () => {
    const closed = scan(
      withLlms(
        `# Catalog\n\n${fill("[", textCap)}]x\n- [Catalog](https://example.com/catalog.md)\n`,
      ),
    );
    expect(checkIn(closed.evaluation, 8)?.evidence).toEqual({ has_h1: true, has_links: true });
    expect(closed.ms).toBeLessThan(budgetMs);
    const unclosed = scan(withLlms(`# Catalog\n\n${fill("[", textCap)}`));
    expect(checkIn(unclosed.evaluation, 8)?.evidence).toEqual({ has_h1: true, has_links: false });
    expect(unclosed.ms).toBeLessThan(budgetMs);
  });

  it("reads each page once, however many rounds evaluate the scan", () => {
    const card = (index: number) =>
      `<div class="product-card"><a href="/products/item-${index}"><img src="/files/item-${index}.jpg" alt="Item ${index}" width="360" height="360"><h3>Item ${index}</h3><span class="price">$${(index % 90) + 10}.00</span><p>Solid oak, oiled finish, ships in five working days.</p></a><button type="button">Add to cart</button></div>\n`;
    const page = `${html.replace("</main></body></html>", "")}${fill(card(1), pageCap)}</main></body></html>`;
    // Every page is its own fetch, as the worker makes them.
    const input: ScanArtifacts = {
      ...makeArtifacts("store"),
      base: artifact("https://example.com/", page),
      agentProbes: {
        chatgpt: artifact("https://example.com/", page),
        claude: artifact("https://example.com/", page),
      },
      representative: artifact("https://example.com/product/widget", page),
    };

    const first = scan({ ...input }).ms;
    const later = [2, 3, 4].reduce((sum) => sum + scan({ ...input }).ms, 0);
    // Reading the pages again would cost each later round about what the
    // first one cost.
    expect(later).toBeLessThan(first);
  });
});

describe("a scan evaluated again", () => {
  it("says the same of the same pages when they are evaluated in a later round", () => {
    const input: ScanArtifacts = {
      ...makeArtifacts("store"),
      representative: artifact("https://example.com/product/widget", html),
    };

    const first = evaluateScan(input);
    // A new set for every round, as the worker builds one: what carries over
    // is the pages, not the object that holds them.
    for (const again of [2, 3, 4].map(() => evaluateScan({ ...input }))) {
      expect(again).toStrictEqual(first);
    }
  });
});

describe("18-check engine", () => {
  it("evaluates each canonical check once and keeps nominal weights at 100", () => {
    const evaluation = evaluateScan(makeArtifacts("store"));
    expect(evaluation.checks.map((check) => check.id)).toEqual(
      Array.from({ length: 18 }, (_, index) => index + 1),
    );
    expect(evaluation.checks.reduce((sum, check) => sum + check.nominalWeight, 0)).toBe(100);
    expect(evaluation.score.nominalWeight).toBe(100);
  });

  it("does not penalize non-store, no-auth, missing optional files or single locale", () => {
    const input = makeArtifacts("owner");
    input.llms = artifact("https://example.com/llms.txt", "not found", {
      status: 404,
    });
    input.a2a = artifact("https://example.com/.well-known/agent-card.json", "not found", {
      status: 404,
    });
    input.base = artifact(
      "https://example.com/",
      html.replace(/<link rel="alternate" hreflang="de"[^>]+>/, ""),
    );
    const checks = evaluateScan(input).checks;
    expect(checks.find((check) => check.id === 10)?.status).toBe("not_applicable");
    expect(checks.find((check) => check.id === 11)?.status).toBe("not_applicable");
    expect(checks.find((check) => check.id === 15)?.status).toBe("not_applicable");
    expect(checks.find((check) => check.id === 8)?.status).toBe("not_applicable");
    expect(checks.find((check) => check.id === 17)?.status).toBe("not_applicable");
    expect(checks.find((check) => check.id === 18)?.status).toBe("not_applicable");
  });

  it("does not ask the owner to repair a robots.txt for its comment lines", () => {
    const input = makeArtifacts("store");
    input.robots = artifact(
      "https://example.com/robots.txt",
      `# we use Shopify as our ecommerce platform\n#\n\n${robots}`,
      { headers: { "content-type": "text/plain" } },
    );
    const check = evaluateScan(input).checks.find((candidate) => candidate.id === 1);
    expect(check).toMatchObject({ status: "pass", summaryCode: "robots_parseable" });
    expect(check?.fixCode).toBeUndefined();
  });

  it("names the network failure that kept robots.txt from being read, not robots.txt", () => {
    const input = makeArtifacts("store");
    input.robots = artifact("https://example.com/robots.txt", "", {
      status: 0,
      errorCode: "fetch_timeout",
    });
    expect(evaluateScan(input).checks.find((check) => check.id === 12)?.errorCode).toBe(
      "fetch_timeout",
    );
  });

  it("does not call a sitemap missing when robots.txt kept the scanner off a declared one", () => {
    const input = makeArtifacts("store");
    input.sitemap = [
      artifact("https://example.com/feeds/sitemap.xml", "", {
        status: 0,
        errorCode: "robots_disallowed",
      }),
      artifact("https://example.com/sitemap.xml", "not found", { status: 404 }),
    ];
    expect(evaluateScan(input).checks.find((check) => check.id === 4)).toMatchObject({
      status: "unavailable",
      errorCode: "robots_disallowed",
    });
  });

  it("keeps a defect the home page shows though robots.txt kept the product page out", () => {
    const input = makeArtifacts("store");
    input.base = artifact(
      "https://example.com/",
      html.replace(
        /<script type="application\/ld\+json">.*?<\/script>/,
        '<script type="application/ld+json">{"@type":</script>',
      ),
    );
    input.representative = artifact("https://example.com/products/widget", "", {
      status: 0,
      errorCode: "robots_disallowed",
    });
    expect(evaluateScan(input).checks.find((check) => check.id === 5)).toMatchObject({
      status: "fail",
      summaryCode: "jsonld_absent_or_invalid",
    });
  });

  it("names robots.txt among the reasons a discovery document went unread", () => {
    const input = makeArtifacts("store");
    input.mcp = [
      artifact("https://example.com/.well-known/mcp.json", "", {
        status: 0,
        errorCode: "fetch_timeout",
      }),
      artifact("https://example.com/.well-known/mcp/server-card.json", "", {
        status: 0,
        errorCode: "robots_disallowed",
      }),
    ];
    expect(evaluateScan(input).checks.find((check) => check.id === 9)?.errorCode).toBe(
      "robots_disallowed",
    );
  });

  it("does not assess content for a target whose robots decision was left open", () => {
    const input = makeArtifacts("store");
    input.canonicalTargetUrl = `https://example.com/${"a".repeat(1_500)}`;
    input.robots = artifact(
      "https://example.com/robots.txt",
      `User-agent: *\n${"Allow: *aaaaab\n".repeat(30_000)}`,
      { headers: { "content-type": "text/plain" } },
    );
    expect(evaluateScan(input).checks.find((check) => check.id === 12)).toMatchObject({
      status: "unavailable",
      errorCode: "robots_unavailable",
    });
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
    expect(evaluation.checks.find((check) => check.id === 12)?.status).toBe("unavailable");
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

    expect(evaluateScan(input).checks.find((check) => check.id === 7)).toMatchObject({
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

    expect(evaluateScan(input).checks.find((check) => check.id === 7)).toMatchObject({
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

    expect(evaluateScan(input).checks.find((check) => check.id === 7)).toMatchObject({
      status: "pass",
      earnedWeight: 8,
      summaryCode: "markdown_negotiation_valid",
      evidence: { differentiated: true, semantic_parity: true },
    });
  });

  it("keeps unrelated Markdown partial even when its headers are valid", () => {
    const input = makeArtifacts("owner");

    expect(evaluateScan(input).checks.find((check) => check.id === 7)).toMatchObject({
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
    input.representative = artifact("https://example.com/products/widget", html);
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
  ])("maps score %s to %s", (score, level) => expect(levelForScore(score, 1)).toBe(level));

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

    expect(scoreChecks([check(1, "pass", 70, 70), check(2, "fail", 30, 0)])).toMatchObject({
      score: 70,
      coverage: 1,
      level: "ahead_of_market",
      terminalStatus: "completed",
      applicableWeight: 100,
      assessedWeight: 100,
      earnedWeight: 70,
    });

    expect(scoreChecks([check(1, "pass", 30, 30), check(2, "unavailable", 70, 0)])).toMatchObject({
      score: 100,
      coverage: 0.3,
      level: "incomplete",
      terminalStatus: "partial",
    });

    expect(scoreChecks([check(1, "pass", 29, 29), check(2, "unavailable", 71, 0)])).toMatchObject({
      score: null,
      coverage: 0.29,
      level: "incomplete",
      terminalStatus: "failed",
    });

    expect(
      scoreChecks([check(1, "unavailable", 0, 0), check(2, "unavailable", 0, 0)]),
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
