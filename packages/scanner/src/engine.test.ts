import { gzipSync } from "node:zlib";
import type { CheckResult, Segment } from "@agentify/scanner-contracts";
import { describe, expect, it } from "vitest";
import { evaluateScan } from "./engine.js";
import type { FetchArtifact, ScanArtifacts } from "./model.js";
import { readPage } from "./parsers.js";
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

  it("finds a product feed a page links to, by a feed's type or file and an address or title that names products", () => {
    for (const link of [
      // WooCommerce links its products feed from the shop's pages, with the
      // ampersand of the query written as a character reference.
      '<link rel="alternate" type="application/rss+xml" title="Toko Kain &raquo; Products Feed" href="https://example.com/shop/feed/" />',
      '<link rel="alternate" type="application/rss+xml" title="Toko Kain" href="https://example.com/?post_type=product&#038;feed=rss2" />',
      "<LINK REL='alternate' HREF='https://example.com/merchant/products.csv'>",
      '<link rel="alternate" type="text/csv" title="Catalog" href="/catalog">',
      '<link rel="alternate" type="application/xml" title="Catalog" href="/catalog">',
      '<link rel="alternate" href="https://example.com/products.xml">',
      '<link rel="alternate" type="application/atom+xml" href="/collections/all.atom">',
    ])
      expect(check(withBase(`<head>${link}</head><body>Wool</body>`), 15)).toMatchObject({
        status: "pass",
        earnedWeight: 4,
        evidence: { feed_link: true },
      });
  });

  it("takes no blog's feed, stylesheet, or link in a comment or a script for a product feed", () => {
    for (const head of [
      // WordPress links the posts' and the comments' feeds from every page.
      `<link rel="alternate" type="application/rss+xml" title="Example &raquo; Feed" href="https://example.com/feed/" />
<link rel="alternate" type="application/rss+xml" title="Example &raquo; Comments Feed" href="https://example.com/comments/feed/" />`,
      '<link rel="alternate" type="application/atom+xml" title="Feed" href="/blogs/news.atom" />',
      // A site named for its shop still links its posts' feed.
      '<link rel="alternate" type="application/rss+xml" title="Example Shop &raquo; Feed" href="https://example.com/feed/" />',
      // A language alternate of the catalogue is a page, not a feed.
      '<link rel="alternate" hreflang="de" href="https://example.com/de/collections/all">',
      '<link rel="stylesheet" href="/assets/feedback.css">',
      '<!-- <link rel="alternate" type="application/rss+xml" title="Products Feed" href="/shop/feed/"> -->',
      `<script>document.head.insertAdjacentHTML("beforeend", '<link rel="alternate" type="application/rss+xml" title="Products Feed" href="/shop/feed/">');</script>`,
    ])
      expect(check(withBase(`<head>${head}</head><body>Wool</body>`), 15)).toMatchObject({
        status: "fail",
        earnedWeight: 0,
      });
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

  it("recognizes a product page by its Open Graph type in any attribute order or quoting", () => {
    for (const meta of [
      '<meta content="product" property="og:type">',
      "<meta property=og:type content=product>",
      '<meta property="og:type" content="product.item">',
    ])
      expect(check(withBase(`<head>${meta}</head><body>Wool</body>`), 15)).toMatchObject({
        status: "partial",
        earnedWeight: 1,
        evidence: { feed_link: false, product_identifiers: true, price_availability: false },
      });
  });

  it("takes no word in a page's markup, scripts or text for a product, a price or an availability", () => {
    const page = `<style>.price,.availability{color:#212a2f}</style>
<script>var sku = "KT-01"; dataLayer.push({ gtin: "8992761002013", availability: "in_stock", price: 19 });</script>
<div class="product-price in_stock">Ask us about any SKU or GTIN, and product:price questions.</div>`;
    expect(check(withBase(page), 15)).toMatchObject({ status: "fail", earnedWeight: 0 });
  });

  it("takes a price shown only in the text for no structured offer", () => {
    const page = `<meta property="og:type" content="product"><h1>Wool Runner</h1><p class="price">$98.00</p>`;
    expect(check(withBase(page), 15)).toMatchObject({
      status: "partial",
      earnedWeight: 1,
      evidence: { product_identifiers: true, price_availability: false },
    });
  });

  it("reads a product's identifiers, price and availability from microdata", () => {
    const page = `<div itemscope itemtype="https://schema.org/Product"><h1 itemprop="name">Wool Runner</h1><span itemprop="sku">WR-01</span>
<div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><link itemprop="availability" href="https://schema.org/InStock"><span itemprop="price" content="98.00">$98.00</span></div></div>`;
    expect(check(withBase(page), 15)).toMatchObject({
      status: "partial",
      earnedWeight: 3,
      evidence: { feed_link: false, product_identifiers: true, price_availability: true },
    });
  });

  it("reads a product's identifiers from microdata on its offer alone", () => {
    const page = `<div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><meta itemprop="sku" content="KT-01"><meta itemprop="gtin13" content="8992761002013"></div><p>Kain Tenun Ikat</p>`;
    expect(check(withBase(page), 15)).toMatchObject({
      status: "partial",
      earnedWeight: 1,
      evidence: { product_identifiers: true, price_availability: false },
    });
  });

  it("reads a sold-out product's availability from JSON-LD when it states no price", () => {
    const product = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Kain Tenun Ikat",
      offers: { "@type": "Offer", availability: "https://schema.org/OutOfStock" },
    };
    const page = `<script type="application/ld+json">${JSON.stringify(product)}</script><h1>Kain Tenun Ikat</h1><p>Sold out</p>`;
    expect(check(withBase(page), 15)).toMatchObject({
      status: "partial",
      earnedWeight: 3,
      evidence: { product_identifiers: true, price_availability: true },
    });
  });

  // The pages below are what the platforms serve, anonymized and cut to the
  // parts the check reads.
  it("scores a WooCommerce product page by its JSON-LD, not by the blog's feeds", () => {
    const offer = {
      "@context": "https://schema.org/",
      "@type": "Product",
      "@id": "https://example.com/product/kain-tenun-ikat/#product",
      name: "Kain Tenun Ikat",
      sku: "KT-01",
      offers: [
        {
          "@type": "Offer",
          price: "150000",
          priceValidUntil: "2027-12-31",
          priceSpecification: { price: "150000", priceCurrency: "IDR" },
          priceCurrency: "IDR",
          availability: "http://schema.org/InStock",
          url: "https://example.com/product/kain-tenun-ikat/",
        },
      ],
    };
    const page = `<head><link rel="alternate" type="application/rss+xml" title="Toko Kain &raquo; Feed" href="https://example.com/feed/" />
<link rel="alternate" type="application/rss+xml" title="Toko Kain &raquo; Comments Feed" href="https://example.com/comments/feed/" /></head>
<body class="product-template-default single single-product woocommerce"><h1 class="product_title entry-title">Kain Tenun Ikat</h1>
<p class="price"><span class="woocommerce-Price-amount amount"><bdi><span class="woocommerce-Price-currencySymbol">Rp</span>150.000</bdi></span></p>
<p class="stock in-stock">12 in stock</p><script type="application/ld+json">${JSON.stringify(offer)}</script></body>`;
    expect(check(withBase(page), 15)).toMatchObject({
      status: "partial",
      earnedWeight: 3,
      evidence: { feed_link: false, product_identifiers: true, price_availability: true },
    });
  });

  it("scores a Shopify product page by its Open Graph and JSON-LD facts", () => {
    const product = {
      "@context": "http://schema.org/",
      "@type": "Product",
      name: "Wool Runner",
      url: "https://example.com/products/wool-runner",
      sku: "WR-01",
      offers: [
        {
          "@type": "Offer",
          availability: "http://schema.org/InStock",
          price: 98.0,
          priceCurrency: "USD",
        },
      ],
    };
    const page = `<head><meta property="og:type" content="product"><meta property="og:price:amount" content="98.00"><meta property="og:price:currency" content="USD">
<link rel="alternate" type="application/json+oembed" href="https://example.com/products/wool-runner.oembed"></head>
<body><h1 class="product__title">Wool Runner</h1><script type="application/ld+json">${JSON.stringify(product)}</script></body>`;
    expect(check(withBase(page), 15)).toMatchObject({
      status: "partial",
      earnedWeight: 3,
      evidence: { feed_link: false, product_identifiers: true, price_availability: true },
    });
  });

  it("scores a WordPress blog that links its posts' feed as having no product feed", () => {
    const page = `<head><link rel="alternate" type="application/rss+xml" title="Example &raquo; Feed" href="https://example.com/feed/" />
<meta property="og:type" content="article"></head><body><article><h1>Choosing a pricing table</h1><div class="price-table">Our plans</div></article></body>`;
    expect(check(withBase(page), 15)).toMatchObject({ status: "fail", earnedWeight: 0 });
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
      evidence: { unparseable_blocks: 1 },
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
    input.markdown = artifact("https://example.com/", readPage(html).text, {
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
        `${fill("<link ", pageCap)}><link rel="alternate" type="application/rss+xml" title="Products Feed" href="/shop/feed/">`,
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
      summaryCode: "jsonld_unparseable",
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

  const markdownAnswer = (status: number): ScanArtifacts => ({
    ...makeArtifacts("owner"),
    markdown: artifact(
      "https://example.com/",
      "# Rate limited\n\nThis is an error response, not a usable representation.",
      { status, headers: { "content-type": "text/markdown", vary: "Accept" } },
    ),
  });

  it.each([408, 429, 431, 451])(
    "gives no Markdown verdict when the request for it was answered with %i, and names the status",
    (status) => {
      const checked = check(markdownAnswer(status), 7);
      expect(checked).toMatchObject({
        status: "unavailable",
        earnedWeight: 0,
        evidence: { status },
      });
      expect(checked?.fixCode).toBeUndefined();
    },
  );

  it.each([401, 403, 404, 406])(
    "does not award Markdown credit to an answer of %i, which an agent asking meets too",
    (status) => {
      expect(check(markdownAnswer(status), 7)).toMatchObject({
        status: "fail",
        earnedWeight: 0,
        summaryCode: "markdown_negotiation_absent",
        evidence: { status },
      });
    },
  );

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

  it("reads a Markdown answer as text, whatever markup its prose or code mentions", () => {
    // Markdown that names a `<textarea>` or a `<script>` tag in inline code,
    // read as HTML, opens one and hides everything after it.
    const input = makeArtifacts("owner");
    input.markdown = artifact(
      "https://example.com/",
      `Leave a \`<textarea>\` for notes, and add the \`<script>\` tag the widget needs.\n\n# Fixture Store\n\n${"Substantive deterministic product information for machines. ".repeat(12)}`,
      { headers: { "content-type": "text/markdown", vary: "Accept" } },
    );
    expect(evaluateScan(input).checks.find((check) => check.id === 7)).toMatchObject({
      status: "pass",
      earnedWeight: 8,
      evidence: { semantic_parity: true },
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

describe("headers that carry a list of values", () => {
  const negotiated = (vary: string): ScanArtifacts => ({
    ...makeArtifacts("owner"),
    markdown: artifact(
      "https://example.com/",
      `# Fixture\n\n${"Markdown product catalog. ".repeat(20)}`,
      { headers: { "content-type": "text/markdown; charset=utf-8", vary } },
    ),
  });

  it.each(["Accept-Encoding", "X-Accept", "accept-language, Origin"])(
    "does not take Vary: %s for a response that varies by Accept",
    (vary) => {
      expect(check(negotiated(vary), 7)?.evidence.vary_accept).toBe(false);
    },
  );

  it.each(["Accept", "accept", "Accept-Encoding, Accept", "Origin ,ACCEPT", ", Accept ,"])(
    "takes Vary: %s for a response that varies by Accept",
    (vary) => {
      expect(check(negotiated(vary), 7)?.evidence.vary_accept).toBe(true);
    },
  );

  it("gives a response that varies by everything the least partial credit", () => {
    expect(check(negotiated("Accept-Encoding, *"), 7)?.earnedWeight).toBe(2);
    expect(check(negotiated("Accept-Encoding"), 7)?.earnedWeight).toBe(6);
  });

  it("does not take a word inside a challenge's parameters for an OAuth sign-in", () => {
    const challenged = (challenge: string): ScanArtifacts => ({
      ...makeArtifacts("owner"),
      base: artifact("https://example.com/", html, {
        headers: { "content-type": "text/html", "www-authenticate": challenge },
      }),
    });
    expect(check(challenged('Basic realm="oauth bearer area"'), 11)?.status).toBe("not_applicable");
    expect(check(challenged('Basic realm="a", Bearer realm="api"'), 11)?.status).toBe(
      "unavailable",
    );
    expect(check(challenged('bearer error="invalid_token"'), 11)?.status).toBe("unavailable");
    expect(check(challenged('Basic realm="staff, bearer tokens only"'), 11)?.status).toBe(
      "not_applicable",
    );
  });
});

describe("a discovery document read whole, cut, refused, malformed or not there", () => {
  const MIB = 1024 * 1024;
  const json = (path: string, body: string, overrides: Partial<FetchArtifact> = {}) =>
    artifact(`https://example.com/.well-known/${path}`, body, {
      headers: { "content-type": "application/json" },
      ...overrides,
    });
  // A document of exactly `size` bytes, its padding inside a string field.
  const sized = (fields: Record<string, unknown>, size: number): string => {
    const shell = JSON.stringify({ ...fields, padding: "" });
    return JSON.stringify({ ...fields, padding: "x".repeat(size - Buffer.byteLength(shell)) });
  };
  const card = { name: "Store MCP", endpoint: "https://example.com/mcp" };
  const cutAt = (body: string, limit: number) =>
    ({ body: body.slice(0, limit), decodedBytes: limit, truncated: true }) as const;
  const notFound = (path: string) => json(path, "", { status: 404 });
  const withMcp = (first: FetchArtifact): ScanArtifacts => ({
    ...makeArtifacts("store"),
    mcp: [first, notFound("mcp/server-card.json")],
  });

  it("judges a card of exactly the read limit, and calls one byte more too large, naming the limit", () => {
    expect(check(withMcp(json("mcp.json", sized(card, MIB))), 9)).toMatchObject({
      status: "pass",
    });
    expect(check(withMcp(json("mcp.json", "", cutAt(sized(card, MIB + 1), MIB))), 9)).toMatchObject(
      {
        status: "fail",
        earnedWeight: 0,
        summaryCode: "document_too_large",
        evidence: { truncated: true, read_limit: "1 MiB" },
        fixCode: "shrink_document",
      },
    );
  });

  it.each([
    ["a UCP profile", 10, "store", "fail"],
    ["an A2A card", 17, "owner", "partial"],
  ] as const)("calls %s cut at the read limit too large, not absent", (_, id, segment, status) => {
    const input = makeArtifacts(segment);
    const cut = json("document", "", cutAt(`{"name":"${"x".repeat(MIB)}"}`, MIB));
    if (id === 10) input.ucp = cut;
    else input.a2a = cut;
    expect(check(input, id)).toMatchObject({
      status,
      earnedWeight: 0,
      summaryCode: "document_too_large",
      evidence: { read_limit: "1 MiB" },
      fixCode: "shrink_document",
    });
  });

  it("calls OAuth metadata cut at the read limit too large, not absent", () => {
    const input = {
      ...makeArtifacts("owner"),
      mcp: [json("mcp.json", '{"name":"x","endpoint":"https://example.com/mcp","auth":"oauth2"}')],
      oauth: [
        json("oauth-authorization-server", "", cutAt(`{"issuer":"${"x".repeat(MIB)}"}`, MIB)),
        notFound("oauth-protected-resource"),
      ],
    };
    expect(check(input, 11)).toMatchObject({
      status: "fail",
      summaryCode: "document_too_large",
    });
  });

  it.each([
    ["cut at the read limit", (body: string) => json("mcp.json", "", cutAt(body, MIB))],
    ["not answered", () => json("mcp.json", "", { status: 503 })],
  ] as const)(
    "does not say no sign-in is declared when the card that would declare it was %s, and says why",
    (_, card) => {
      const checked = check(withMcp(card(`{"auth":"oauth2","x":"${"x".repeat(MIB)}"}`)), 11);
      expect(checked).toMatchObject({
        status: "unavailable",
        summaryCode: "oauth_declaration_unknown",
      });
      // The card's answer is not the OAuth metadata's, so it is not shown as such.
      expect(checked?.evidence).toEqual({});
    },
  );

  it("takes a card refused to the scanner as declaring no sign-in, as it declares none to an agent", () => {
    expect(check(withMcp(json("mcp.json", "Forbidden", { status: 403 })), 11)?.status).toBe(
      "not_applicable",
    );
  });

  it.each([
    ["an MCP server card", 9, "mcp_card_unparseable", "fail"],
    ["a UCP profile", 10, "ucp_profile_unparseable", "fail"],
    ["an A2A card", 17, "a2a_card_unparseable", "partial"],
  ] as const)(
    "reports %s that is not valid JSON as unparseable, not as absent",
    (_, id, summaryCode, status) => {
      const input = makeArtifacts("store");
      const broken = json("document", '{"name": "Store", "endpoint": ');
      if (id === 9) input.mcp = [broken, notFound("mcp/server-card.json")];
      else if (id === 10) input.ucp = broken;
      else input.a2a = broken;
      expect(check(input, id)).toMatchObject({
        status,
        summaryCode,
        fixCode: "repair_document_json",
      });
    },
  );

  it("reports OAuth metadata that is not valid JSON as unparseable", () => {
    const input = {
      ...makeArtifacts("owner"),
      mcp: [json("mcp.json", '{"name":"x","endpoint":"https://example.com/mcp","auth":"oauth2"}')],
      oauth: [json("oauth-authorization-server", "{"), notFound("oauth-protected-resource")],
    };
    expect(check(input, 11)).toMatchObject({
      status: "fail",
      summaryCode: "oauth_metadata_unparseable",
    });
  });

  const page = "<!DOCTYPE html><html><head><title>Store</title></head><body>App</body></html>";

  it("takes a web page answered where a card belongs for no card", () => {
    const input = makeArtifacts("store");
    input.mcp = [
      json("mcp.json", page, { headers: { "content-type": "text/html" } }),
      json("mcp/server-card.json", page, { headers: { "content-type": "text/html" } }),
    ];
    input.ucp = json("ucp", `﻿  ${page}`, { headers: { "content-type": "text/html" } });
    input.a2a = json("agent-card.json", page, { headers: { "content-type": "text/html" } });
    input.llms = artifact("https://example.com/llms.txt", page);
    expect(check(input, 9)).toMatchObject({ status: "fail", summaryCode: "mcp_absent" });
    expect(check(input, 10)).toMatchObject({ status: "fail", summaryCode: "ucp_absent" });
    expect(check(input, 17)).toMatchObject({ status: "not_applicable", summaryCode: "a2a_absent" });
    expect(check(input, 8)).toMatchObject({ status: "not_applicable", summaryCode: "llms_absent" });
  });

  const answeredWith = (status: number): ScanArtifacts => {
    const input = makeArtifacts("store");
    const answer = (path: string) =>
      artifact(`https://example.com/${path}`, "<Error>AccessDenied</Error>", { status });
    input.mcp = [answer(".well-known/mcp.json"), notFound("mcp/server-card.json")];
    input.ucp = answer(".well-known/ucp");
    input.a2a = answer(".well-known/agent-card.json");
    input.llms = answer("llms.txt");
    return input;
  };

  it.each([401, 403, 405])(
    "takes a document the site refuses with %i for the absence it is to an agent, and says so",
    (status) => {
      const input = answeredWith(status);
      for (const id of [9, 10])
        expect(check(input, id)).toMatchObject({
          status: "fail",
          earnedWeight: 0,
          summaryCode: "document_refused",
          evidence: { status },
          fixCode: "allow_document",
        });
      for (const id of [8, 17]) {
        const checked = check(input, id);
        expect(checked).toMatchObject({
          status: "not_applicable",
          summaryCode: "document_refused",
          evidence: { status },
        });
        expect(checked?.fixCode).toBeUndefined();
      }
    },
  );

  it.each([408, 429, 431, 451, 503])(
    "does not judge a document the site answered with %i, and names the status",
    (status) => {
      const input = answeredWith(status);
      for (const id of [8, 9, 10, 17]) {
        const checked = check(input, id);
        expect(checked).toMatchObject({ status: "unavailable", evidence: { status } });
        expect(checked?.fixCode).toBeUndefined();
      }
    },
  );

  it("keeps an llms.txt heading and link read before the limit, and calls a cut one without them too large", () => {
    const head = "# Store\n\n- [Catalog](https://example.com/catalog)\n";
    const proven = makeArtifacts("store");
    proven.llms = artifact("https://example.com/llms.txt", head, {
      truncated: true,
      decodedBytes: 512 * 1024,
    });
    expect(check(proven, 8)).toMatchObject({ status: "pass", evidence: { truncated: true } });
    const unproven = makeArtifacts("store");
    unproven.llms = artifact("https://example.com/llms.txt", "Store notes\n".repeat(10), {
      truncated: true,
      decodedBytes: 512 * 1024,
    });
    expect(check(unproven, 8)).toMatchObject({
      status: "partial",
      summaryCode: "document_too_large",
      evidence: { read_limit: "512 KiB" },
      fixCode: "shrink_document",
    });
  });

  it("does not say a card lacks fields while the other location went unanswered", () => {
    const answered = (first: FetchArtifact): ScanArtifacts => ({
      ...makeArtifacts("store"),
      mcp: [first, json("mcp/server-card.json", "busy", { status: 503 })],
    });
    expect(check(answered(json("mcp.json", '{"name":"Store MCP"}')), 9)).toMatchObject({
      status: "unavailable",
      summaryCode: "mcp_unavailable",
      evidence: { status: 503 },
    });
    expect(check(answered(json("mcp.json", JSON.stringify(card))), 9)?.status).toBe("pass");
  });

  it("says a card that asks for sign-in cannot serve discovery", () => {
    const behind = (challenge: string | undefined) =>
      withMcp(
        json("mcp.json", '{"error":"unauthorized"}', {
          status: 401,
          headers: {
            "content-type": "application/json",
            ...(challenge ? { "www-authenticate": challenge } : {}),
          },
        }),
      );
    expect(check(behind('Bearer resource_metadata="https://example.com/x"'), 9)).toMatchObject({
      status: "fail",
      summaryCode: "mcp_card_behind_sign_in",
      evidence: { status: 401 },
      fixCode: "serve_mcp_card_publicly",
    });
    expect(check(behind(undefined), 9)?.summaryCode).toBe("document_refused");
  });

  it("judges two incomplete cards by the more nearly complete one", () => {
    const input: ScanArtifacts = {
      ...makeArtifacts("store"),
      mcp: [json("mcp.json", '{"version":"1"}'), json("mcp/server-card.json", '{"name":"Store"}')],
    };
    expect(check(input, 9)).toMatchObject({
      status: "partial",
      earnedWeight: 4,
      evidence: { documents_found: 2, fields_missing: ["endpoint"] },
    });
  });

  it("reads a card behind a byte order mark", () => {
    expect(check(withMcp(json("mcp.json", `\uFEFF${JSON.stringify(card)}`)), 9)?.status).toBe(
      "pass",
    );
  });

  it.each([
    ["a comment", `// MCP card\n${JSON.stringify(card)}`],
    ["a guard against script inclusion", `)]}'\n${JSON.stringify(card)}`],
    ["a line of text", "Not found"],
  ])("reports a card that opens with %s as unparseable, not absent", (_, body) => {
    expect(check(withMcp(json("mcp.json", body)), 9)).toMatchObject({
      status: "fail",
      summaryCode: "mcp_card_unparseable",
    });
  });

  const oauthDeclared = (oauth: FetchArtifact[]): ScanArtifacts => ({
    ...makeArtifacts("owner"),
    mcp: [json("mcp.json", '{"name":"x","endpoint":"https://example.com/mcp","auth":"oauth2"}')],
    oauth,
  });
  const authorizationServer = (issuer: string) =>
    json(
      "oauth-authorization-server",
      JSON.stringify({ issuer, token_endpoint: `${issuer}/token` }),
    );

  it("keeps an address without HTTPS proven in one OAuth document though the other went unanswered", () => {
    expect(
      check(
        oauthDeclared([
          authorizationServer("http://example.com"),
          json("oauth-protected-resource", "", { status: 0, errorCode: "fetch_timeout" }),
        ]),
        11,
      ),
    ).toMatchObject({
      status: "partial",
      summaryCode: "oauth_metadata_partial",
      evidence: {
        fields_not_https: ["issuer", "token_endpoint"],
        documents_unread: ["protected resource metadata: fetch_timeout"],
      },
    });
  });

  it("says which OAuth document is missing when none could be read", () => {
    const checked = check(
      oauthDeclared([
        notFound("oauth-authorization-server"),
        json("oauth-protected-resource", "busy", { status: 503 }),
      ]),
      11,
    );
    expect(checked).toMatchObject({
      status: "partial",
      earnedWeight: 0,
      summaryCode: "oauth_metadata_missing",
      evidence: {
        documents_found: 0,
        documents_missing: ["authorization server metadata: not found"],
        documents_unread: ["protected resource metadata: HTTP 503"],
      },
    });
  });

  it("names the OAuth document that is not there", () => {
    expect(
      check(
        oauthDeclared([
          authorizationServer("https://example.com"),
          notFound("oauth-protected-resource"),
        ]),
        11,
      ),
    ).toMatchObject({
      status: "partial",
      evidence: { documents_missing: ["protected resource metadata: not found"] },
    });
  });

  it("still reports a card that is not there, and one that is there but incomplete", () => {
    const absent = makeArtifacts("store");
    absent.mcp = [notFound("mcp.json"), notFound("mcp/server-card.json")];
    expect(check(absent, 9)).toMatchObject({ status: "fail", summaryCode: "mcp_absent" });
    const incomplete = withMcp(json("mcp.json", '{"name":"Store MCP"}'));
    expect(check(incomplete, 9)).toMatchObject({
      status: "partial",
      summaryCode: "mcp_card_incomplete",
      evidence: { fields_missing: ["endpoint"] },
    });
  });
});

describe("a sitemap's result names its one cause and the entries involved", () => {
  const MIB = 1024 * 1024;
  const now = new Date().toISOString();
  const xml = (path: string, body: string, overrides: Partial<FetchArtifact> = {}) =>
    artifact(`https://example.com/${path}`, body, {
      headers: { "content-type": "application/xml" },
      ...overrides,
    });
  const urlset = (lastmod: string | null, count = 3) =>
    `<urlset>${Array.from(
      { length: count },
      (_, index) =>
        `<url><loc>https://example.com/p/${index}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`,
    ).join("")}</urlset>`;
  const index = `<sitemapindex><sitemap><loc>https://example.com/sitemap-1.xml</loc><lastmod>${now}</lastmod></sitemap><sitemap><loc>https://example.com/sitemap-2.xml</loc><lastmod>${now}</lastmod></sitemap></sitemapindex>`;
  const withSitemaps = (...sitemap: FetchArtifact[]): ScanArtifacts => ({
    ...makeArtifacts("store"),
    sitemap,
  });

  it("leaves a sitemap cut before any entry was read unjudged, and names the read limit", () => {
    const cut = check(
      withSitemaps(
        xml("sitemap.xml", `<urlset><url><loc>https://example.com/${"a".repeat(64)}`, {
          truncated: true,
          decodedBytes: 5 * MIB,
        }),
      ),
      4,
    );
    expect(cut).toMatchObject({
      status: "unavailable",
      summaryCode: "document_truncated",
      evidence: { truncated: true, read_limit: "5 MiB" },
    });
    expect(cut?.fixCode).toBeUndefined();
  });

  it("judges a sitemap cut at the read limit by the entries read, and names the limit", () => {
    expect(
      check(
        withSitemaps(xml("sitemap.xml", urlset(now), { truncated: true, decodedBytes: 5 * MIB })),
        4,
      ),
    ).toMatchObject({
      status: "pass",
      evidence: { truncated: true, read_limit: "5 MiB", entries_read: 3 },
    });
  });

  it.each([
    [{ status: 503 }, "HTTP 503"],
    [{ status: 0, errorCode: "fetch_timeout" }, "fetch_timeout"],
  ])(
    "names a listed sitemap that did not answer, and gives the set no verdict without it: %j",
    (failure, reason) => {
      const checked = check(
        withSitemaps(
          xml("sitemap.xml", index),
          xml("sitemap-1.xml", urlset(now)),
          xml("sitemap-2.xml", "", failure),
        ),
        4,
      );
      expect(checked).toMatchObject({
        status: "unavailable",
        earnedWeight: 0,
        summaryCode: "sitemap_partly_unread",
        evidence: {
          entries_read: 3,
          sitemaps_unread: [`entry 2 of the sitemap index: ${reason}`],
        },
      });
      expect(checked?.fixCode).toBeUndefined();
    },
  );

  it("does not pass an index on its own dates when none of the sitemaps it lists was read", () => {
    expect(
      check(
        withSitemaps(
          xml("sitemap.xml", index),
          xml("sitemap-1.xml", "", { status: 503 }),
          xml("sitemap-2.xml", "", { status: 0, errorCode: "fetch_timeout" }),
        ),
        4,
      ),
    ).toMatchObject({
      status: "unavailable",
      summaryCode: "sitemap_partly_unread",
      evidence: { entries_read: 0, lastmod_count: 0 },
    });
  });

  it("keeps a defect proven by the sitemaps read though another went unread", () => {
    expect(
      check(
        withSitemaps(
          xml("sitemap.xml", index),
          xml("sitemap-1.xml", "", { status: 404 }),
          xml("sitemap-2.xml", "", { status: 503 }),
        ),
        4,
      ),
    ).toMatchObject({
      status: "partial",
      summaryCode: "sitemap_entries_missing",
      evidence: {
        sitemaps_missing: ["entry 1 of the sitemap index: HTTP 404"],
        sitemaps_unread: ["entry 2 of the sitemap index: HTTP 503"],
      },
    });
  });

  it("names a sitemap by where robots.txt or the standard address put it", () => {
    const input = withSitemaps(
      xml("a.xml", urlset(now)),
      xml("b.xml", "", { status: 404 }),
      xml("sitemap.xml", "", { status: 410 }),
    );
    input.robots = artifact(
      "https://example.com/robots.txt",
      `${robots}\nSitemap: https://example.com/a.xml\nSitemap: https://example.com/b.xml\n`,
      { headers: { "content-type": "text/plain" } },
    );
    expect(check(input, 4)?.evidence.sitemaps_missing).toEqual([
      "declared sitemap 2: HTTP 404",
      "the sitemap address: HTTP 410",
    ]);
  });

  it("names the sitemaps an index lists on another site, which the scan does not read", () => {
    expect(
      check(
        withSitemaps(
          xml(
            "sitemap.xml",
            `<sitemapindex><sitemap><loc>https://cdn.other.net/s1.xml</loc><lastmod>${now}</lastmod></sitemap></sitemapindex>`,
          ),
        ),
        4,
      ),
    ).toMatchObject({
      status: "unavailable",
      summaryCode: "sitemap_partly_unread",
      evidence: {
        sitemaps_unread: ["entry 1 of the sitemap index: listed on another site, not read"],
      },
    });
  });

  it("judges a readable sitemap whatever its media type says", () => {
    expect(
      check(
        withSitemaps(
          xml("sitemap.xml.gz", urlset(now), { headers: { "content-type": "application/x-gzip" } }),
        ),
        4,
      ),
    ).toMatchObject({ status: "pass", summaryCode: "sitemap_valid" });
  });

  it("leaves a sitemap the fetch could not unpack unread, and does not take it for no sitemap", () => {
    // Compressed twice, a file is still gzip after the fetch unpacks it once;
    // the fetch keeps a body as text, as it keeps such bytes.
    const compressed = (path: string) =>
      xml(path, gzipSync(gzipSync(Buffer.from(urlset(now)))).toString("utf8"), {
        headers: { "content-type": "text/plain" },
      });
    expect(check(withSitemaps(compressed("sitemap.xml.gz")), 4)).toMatchObject({
      status: "unavailable",
      summaryCode: "sitemap_compressed",
    });
    expect(
      check(
        withSitemaps(
          xml("sitemap.xml", index.replace("sitemap-2.xml", "sitemap-2.xml.gz")),
          xml("sitemap-1.xml", urlset(now)),
          compressed("sitemap-2.xml.gz"),
        ),
        4,
      ),
    ).toMatchObject({
      status: "unavailable",
      evidence: {
        sitemaps_unread: ["entry 2 of the sitemap index: still compressed with gzip"],
      },
    });
  });

  it("takes a sitemap address the site refuses for the absence it is to an agent", () => {
    expect(check(withSitemaps(xml("sitemap.xml", "Denied", { status: 403 })), 4)).toMatchObject({
      status: "fail",
      summaryCode: "document_refused",
      evidence: { status: 403 },
      fixCode: "allow_document",
    });
  });

  it("reports a listed sitemap that is not there as a defect, and names it", () => {
    expect(
      check(
        withSitemaps(
          xml("sitemap.xml", index),
          xml("sitemap-1.xml", urlset(now)),
          xml("sitemap-2.xml", "", { status: 404 }),
        ),
        4,
      ),
    ).toMatchObject({
      status: "partial",
      earnedWeight: 2,
      summaryCode: "sitemap_entries_missing",
      evidence: { sitemaps_missing: ["entry 2 of the sitemap index: HTTP 404"] },
      fixCode: "fix_listed_sitemaps",
    });
  });

  it("names stale dates as the cause, with the counts the rule was applied to", () => {
    expect(check(withSitemaps(xml("sitemap.xml", urlset("2020-01-01", 5))), 4)).toMatchObject({
      status: "partial",
      earnedWeight: 4,
      summaryCode: "sitemap_stale",
      evidence: { lastmod_count: 5, stale_lastmod_count: 5 },
      fixCode: "refresh_sitemap_lastmod",
    });
  });

  it("counts a share of stale dates above four in five as stale, and not one at four in five", () => {
    const mixed = (stale: number, fresh: number) =>
      `<urlset>${[
        ...Array.from({ length: stale }, () => "2020-01-01"),
        ...Array.from({ length: fresh }, () => now),
      ]
        .map(
          (date, at) =>
            `<url><loc>https://example.com/p/${at}</loc><lastmod>${date}</lastmod></url>`,
        )
        .join("")}</urlset>`;
    expect(check(withSitemaps(xml("sitemap.xml", mixed(4, 1))), 4)?.status).toBe("pass");
    expect(check(withSitemaps(xml("sitemap.xml", mixed(401, 99))), 4)?.summaryCode).toBe(
      "sitemap_stale",
    );
  });

  it("names missing dates as the cause", () => {
    expect(check(withSitemaps(xml("sitemap.xml", urlset(null))), 4)).toMatchObject({
      status: "partial",
      summaryCode: "sitemap_no_lastmod",
      fixCode: "add_sitemap_lastmod",
    });
  });

  it("takes a web page answered at the sitemap address for no sitemap", () => {
    expect(
      check(
        withSitemaps(
          xml("sitemap.xml", "<!doctype html><html><body>App</body></html>", {
            headers: { "content-type": "text/html" },
          }),
        ),
        4,
      ),
    ).toMatchObject({
      status: "fail",
      summaryCode: "sitemap_not_sitemap",
      fixCode: "serve_sitemap",
    });
  });

  it("reports a sitemap without entries as empty", () => {
    expect(check(withSitemaps(xml("sitemap.xml", "<urlset></urlset>")), 4)).toMatchObject({
      status: "fail",
      summaryCode: "sitemap_empty",
      fixCode: "add_sitemap_entries",
    });
  });

  it("does not judge a sitemap that declares a document type, and says why", () => {
    const checked = check(withSitemaps(xml("sitemap.xml", `<!DOCTYPE urlset>${urlset(now)}`)), 4);
    expect(checked).toMatchObject({ status: "unavailable", summaryCode: "sitemap_doctype" });
    expect(checked?.fixCode).toBeUndefined();
  });

  it("gives no verdict of absence while a declared sitemap did not answer", () => {
    expect(
      check(
        withSitemaps(
          xml("sitemap.xml", "<!doctype html><html></html>"),
          xml("sitemap-b.xml", "", { status: 503 }),
        ),
        4,
      ),
    ).toMatchObject({ status: "unavailable", evidence: { status: 503 } });
  });

  it("still passes a whole, fresh sitemap and still reports none where there is none", () => {
    expect(check(withSitemaps(xml("sitemap.xml", urlset(now))), 4)).toMatchObject({
      status: "pass",
      summaryCode: "sitemap_valid",
    });
    expect(check(withSitemaps(xml("sitemap.xml", "", { status: 404 })), 4)).toMatchObject({
      status: "fail",
      summaryCode: "sitemap_missing",
    });
  });
});

describe("a web page answered where a document belongs, whatever comes before its opening", () => {
  const pages = [
    ["a comment", "<!-- built -->\n<!doctype html><html><body>App</body></html>"],
    ["white space", '\n\n   <html lang="en"><body>App</body></html>'],
    [
      "an XML prolog",
      '<?xml version="1.0"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "x">\n<html xmlns="http://www.w3.org/1999/xhtml"><body>x</body></html>',
    ],
  ] as const;

  it.each(pages)(
    "counts a page that opens with %s as no robots.txt, llms.txt or sitemap",
    (_, body) => {
      const input = makeArtifacts("store");
      input.robots = artifact("https://example.com/robots.txt", body);
      input.llms = artifact("https://example.com/llms.txt", body);
      input.sitemap = [artifact("https://example.com/sitemap.xml", body)];
      expect(check(input, 1)?.summaryCode).toBe("robots_missing");
      expect(check(input, 8)?.summaryCode).toBe("llms_absent");
      expect(check(input, 4)?.summaryCode).toBe("sitemap_not_sitemap");
    },
  );

  it("does not take a document that only mentions a page's markup for a page", () => {
    const input = makeArtifacts("store");
    input.llms = artifact(
      "https://example.com/llms.txt",
      '# Frontend kit\n\n> Components for pages.\n\n```html\n<!doctype html>\n<html lang="en">\n```\n\n- [Guide](https://example.com/guide)\n',
      { headers: { "content-type": "text/plain" } },
    );
    const card = JSON.stringify({
      name: "Docs MCP",
      description: 'Returns templates such as <html lang="en"> skeletons',
      endpoint: "https://example.com/mcp",
    });
    input.mcp = [
      artifact("https://example.com/.well-known/mcp.json", card, {
        headers: { "content-type": "application/json" },
      }),
    ];
    expect(check(input, 8)?.summaryCode).toBe("llms_valid");
    expect(check(input, 9)?.summaryCode).toBe("mcp_card_valid");
    input.mcp = [
      artifact("https://example.com/.well-known/mcp.json", card.slice(0, 80), {
        headers: { "content-type": "application/json" },
        truncated: true,
        decodedBytes: 1024 * 1024,
      }),
    ];
    expect(check(input, 9)?.summaryCode).toBe("document_too_large");
  });
});

describe("a robots.txt result names its one cause", () => {
  const withRobots = (body: string, overrides: Partial<FetchArtifact> = {}): ScanArtifacts => ({
    ...makeArtifacts("store"),
    robots: artifact("https://example.com/robots.txt", body, {
      headers: { "content-type": "text/plain" },
      ...overrides,
    }),
  });

  it.each([401, 403, 418])(
    "reports a robots.txt answered with %i as refused, with the status, not as unparseable",
    (status) => {
      expect(check(withRobots("Forbidden", { status }), 1)).toMatchObject({
        status: "fail",
        summaryCode: "robots_refused",
        evidence: { status },
        fixCode: "serve_robots",
      });
    },
  );

  it("takes a web page answered at the robots.txt address for no robots.txt", () => {
    const input = withRobots("<!DOCTYPE html><html><body>App</body></html>", {
      headers: { "content-type": "text/html" },
    });
    expect(check(input, 1)).toMatchObject({
      status: "fail",
      summaryCode: "robots_missing",
      fixCode: "publish_robots",
    });
    expect(check(input, 2)?.summaryCode).toBe("ai_policy_absent");
  });

  it("reports valid rules served as a web page's media type as that, and only that", () => {
    expect(
      check(withRobots(robots, { headers: { "content-type": "text/html; charset=utf-8" } }), 1),
    ).toMatchObject({
      status: "partial",
      summaryCode: "robots_wrong_media_type",
      evidence: { content_type: "text/html; charset=utf-8" },
      fixCode: "serve_robots_as_text",
    });
  });

  it("names the read limit when robots.txt is longer than the scanner reads", () => {
    expect(
      check(withRobots(robots, { truncated: true, decodedBytes: 512 * 1024 }), 1),
    ).toMatchObject({
      status: "partial",
      summaryCode: "robots_too_large",
      evidence: { truncated: true, read_limit: "512 KiB" },
      fixCode: "shorten_robots",
    });
  });

  it.each([408, 429, 431, 451, 503])(
    "names the status of an answer of %i that kept robots.txt from being read",
    (status) => {
      const checked = check(withRobots("", { status }), 1);
      expect(checked).toMatchObject({ status: "unavailable", evidence: { status } });
      expect(checked?.fixCode).toBeUndefined();
    },
  );

  it("still reports malformed directives and an unparseable file as they were", () => {
    expect(check(withRobots(`${robots}\nDisalow /x`), 1)).toMatchObject({
      status: "partial",
      summaryCode: "robots_partially_parseable",
      fixCode: "repair_robots",
    });
    expect(check(withRobots(`${robots}\0`), 1)).toMatchObject({
      status: "fail",
      summaryCode: "robots_invalid",
    });
  });
});

describe("a page check's result names its one cause and the items involved", () => {
  const ld = (node: Record<string, unknown>) =>
    `<script type="application/ld+json">${JSON.stringify(node)}</script>`;
  const page = (head: string) =>
    `<html><head><title>Cafe</title>${head}</head><body><h1>Cafe</h1></body></html>`;

  it("tells a page without structured data from one whose structured data cannot be parsed", () => {
    expect(check(withBase(page("")), 5)).toMatchObject({
      status: "fail",
      summaryCode: "jsonld_absent",
      evidence: { jsonld_blocks: 0 },
      fixCode: "publish_valid_jsonld",
    });
    expect(
      check(withBase(page('<script type="application/ld+json">{"@type":</script>')), 5),
    ).toMatchObject({
      status: "fail",
      summaryCode: "jsonld_unparseable",
      evidence: { jsonld_blocks: 1, unparseable_blocks: 1 },
      fixCode: "repair_jsonld",
    });
  });

  it("names the recommended fields a local business lacks and how many a pass needs", () => {
    const input: ScanArtifacts = {
      ...makeArtifacts("local"),
      base: artifact(
        "https://example.com/",
        page(
          ld({
            "@type": "LocalBusiness",
            name: "Cafe",
            address: "1 Main St",
            telephone: "+1 555 0100",
          }),
        ),
      ),
    };
    expect(check(input, 6)).toMatchObject({
      status: "partial",
      summaryCode: "vertical_jsonld_recommended_missing",
      evidence: {
        type: "LocalBusiness",
        required_missing: [],
        recommended_found: ["telephone"],
        recommended_missing: ["openingHoursSpecification", "geo", "priceRange", "makesOffer"],
        recommended_needed_for_pass: 3,
      },
      fixCode: "add_recommended_jsonld",
    });
  });

  it("names a missing required field as its own cause", () => {
    const input = withBase(
      page(ld({ "@type": "Product", name: "Widget", image: "https://example.com/a.jpg" })),
    );
    expect(check(input, 6)).toMatchObject({
      status: "partial",
      summaryCode: "vertical_jsonld_required_missing",
      evidence: { required_missing: ["url", "offers.price", "offers.priceCurrency"] },
      fixCode: "complete_vertical_jsonld",
    });
  });

  it("names the types it looked for when the structured data describes another kind of business", () => {
    const input: ScanArtifacts = {
      ...makeArtifacts("store"),
      base: artifact("https://example.com/", page(ld({ "@type": "Organization", name: "Cafe" }))),
    };
    expect(check(input, 6)).toMatchObject({
      status: "fail",
      summaryCode: "vertical_jsonld_wrong_type",
      evidence: { types: ["Organization"], expected_types: ["Product"] },
    });
  });

  it("tells a page too large to read whole from a page too slow, and names the read limit", () => {
    const large = withBase(html);
    large.base = artifact("https://example.com/", html, {
      truncated: true,
      decodedBytes: 2 * 1024 * 1024,
    });
    expect(check(large, 14)).toMatchObject({
      status: "fail",
      summaryCode: "page_performance_too_large",
      evidence: { read_limit: "2 MiB" },
      fixCode: "reduce_page_weight",
    });
    const slow = withBase(html);
    slow.base = artifact("https://example.com/", html, { durationMs: 9_000 });
    expect(check(slow, 14)).toMatchObject({
      status: "fail",
      summaryCode: "page_performance_too_slow",
      fixCode: "reduce_response_time",
    });
    const sluggish = withBase(html);
    sluggish.base = artifact("https://example.com/", html, { durationMs: 5_000 });
    expect(check(sluggish, 14)).toMatchObject({
      status: "partial",
      summaryCode: "page_performance_slow",
      fixCode: "reduce_response_time",
    });
  });

  it("names the read limit where a cut page leaves a check unjudged", () => {
    const input = withBase(page(""));
    input.base = artifact("https://example.com/", page(""), {
      truncated: true,
      decodedBytes: 2 * 1024 * 1024,
    });
    expect(check(input, 12)).toMatchObject({
      status: "unavailable",
      summaryCode: "html_truncated",
      evidence: { truncated: true, read_limit: "2 MiB" },
    });
  });

  it("names the AI crawler groups robots.txt leaves without a policy", () => {
    const input = makeArtifacts("store");
    input.robots = artifact(
      "https://example.com/robots.txt",
      "User-agent: GPTBot\nDisallow: /\nUser-agent: ClaudeBot\nAllow: /\n",
      { headers: { "content-type": "text/plain" } },
    );
    expect(check(input, 2)).toMatchObject({
      status: "partial",
      evidence: {
        providers: ["openai", "anthropic"],
        providers_missing: ["perplexity", "google"],
        policy_agents: ["gptbot", "claudebot"],
      },
    });
  });

  it("shows a language code written on the page no longer than a code can be", () => {
    const input = withBase(
      page(
        ["en", "de", "x".repeat(200)]
          .map(
            (code) =>
              `<link rel="alternate" hreflang="${code}" href="https://example.com/${code}">`,
          )
          .join(""),
      ),
    );
    const [shown] = (check(input, 18)?.evidence.invalid_locales ?? []) as string[];
    expect(shown?.length).toBeLessThanOrEqual(35);
  });

  it("names the language codes that are not valid and those declared twice", () => {
    const input = withBase(
      page(
        ["en", "en", "en_US", "de"]
          .map(
            (code) =>
              `<link rel="alternate" hreflang="${code}" href="https://example.com/${code}">`,
          )
          .join(""),
      ),
    );
    expect(check(input, 18)).toMatchObject({
      status: "partial",
      evidence: { invalid_locales: ["en_US"], duplicate_locales: ["en"] },
    });
  });
});

describe("what the server-rendered content check takes for a store's product page", () => {
  // A home page too thin to pass on its own, so the product page decides.
  const withProductPage = (page: string): ScanArtifacts => ({
    ...makeArtifacts("store"),
    base: artifact("https://example.com/", "<title>Toko Kain</title><p>Selamat datang.</p>"),
    representative: artifact("https://example.com/product/kain-tenun-ikat", page),
  });
  const description = `<p>${"Kain tenun ikat dari Sumba, ditenun dengan tangan dan diwarnai alami. ".repeat(3)}</p>`;

  it("passes a product page whose price is written with its currency code first, and says what it found", () => {
    const page = `<title>Kain Tenun Ikat</title><h1 class="product_title">Kain Tenun Ikat</h1>${description}<span class="price">USD 0.01</span>`;
    expect(check(withProductPage(page), 12)).toMatchObject({
      status: "pass",
      evidence: { has_price_signal: true, price_signal: "USD 0.01", price_signal_source: "text" },
    });
  });

  it("does not pass a product page cut inside its inline state, and says the cut page could not be assessed", () => {
    // The fetch stops at its limit inside the script, so the page arrives
    // truncated, and a thin prefix proves nothing about the rest.
    const state = `{"product":{"price":"$1","title":"${"x".repeat(64)}"}},`;
    const page = `<title>Kain Tenun Ikat</title><h1 class="product_title">Kain Tenun Ikat</h1>${description}<script>window.__STATE__ = ${state.repeat(30_000)}`;
    const input = withProductPage(page);
    input.representative = artifact("https://example.com/product/kain-tenun-ikat", page, {
      truncated: true,
    });
    expect(check(input, 12)).toMatchObject({
      status: "unavailable",
      summaryCode: "html_truncated",
      evidence: { has_price_signal: false, truncated: true },
    });
  });
});
