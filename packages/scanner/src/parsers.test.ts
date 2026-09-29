import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  htmlSignals,
  jsonLdTypes,
  parseJsonLd,
  parseSafeJson,
  parseSitemap,
  visibleText,
} from "./parsers.js";
import { explicitAiPolicies, isPathAllowed, parseRobots } from "./robots.js";

describe("deterministic parsers", () => {
  it("parses robots groups, content signal and AI policies", () => {
    const parsed = parseRobots(`
User-agent: *
Disallow: /private
Allow: /private/public
Content-Signal: search=yes, ai-input=no, ai-train=no
Sitemap: https://example.com/sitemap.xml
User-agent: GPTBot
Disallow: /
User-agent: ChatGPT-User/1.0
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: Google-Extended
Allow: /
`);
    expect(isPathAllowed(parsed, "agentify-scanner", "/private/x")).toBe(false);
    expect(isPathAllowed(parsed, "agentify-scanner", "/private/public/x")).toBe(true);
    expect(parsed.contentSignal).toEqual({
      search: "yes",
      "ai-input": "no",
      "ai-train": "no",
    });
    expect(Object.keys(explicitAiPolicies(parsed))).toEqual([
      "openai",
      "anthropic",
      "perplexity",
      "google",
    ]);
  });

  it("uses only the most specific user-agent groups when applying rules", () => {
    const specificDeny = parseRobots(`
User-agent: *
Allow: /
User-agent: agentify
Allow: /
User-agent: agentify-scanner
Disallow: /
`);
    expect(isPathAllowed(specificDeny, "agentify-scanner", "/public")).toBe(false);
    expect(isPathAllowed(specificDeny, "agentify-scanner/1.0", "/public")).toBe(false);

    const specificAllow = parseRobots(`
User-agent: *
Disallow: /
User-agent: agentify-scanner
Allow: /
`);
    expect(isPathAllowed(specificAllow, "agentify-scanner", "/public")).toBe(true);
    expect(isPathAllowed(specificAllow, "unmatched-bot", "/public")).toBe(false);
  });

  it("lets the longest matching rule decide, and Allow win a tie", () => {
    // The tie is Google's documented example of the least restrictive rule.
    const tie = parseRobots("User-agent: *\nAllow: /folder\nDisallow: /folder\n");
    expect(isPathAllowed(tie, "agentify-scanner", "/folder/page")).toBe(true);
    // Two groups for every crawler are one group; a shorter Allow in the
    // second does not undo a longer Disallow in the first.
    const split = parseRobots(
      "User-agent: *\nDisallow: /folder/private\n\nUser-agent: *\nAllow: /folder\n",
    );
    expect(isPathAllowed(split, "agentify-scanner", "/folder/private/page")).toBe(false);
    expect(isPathAllowed(split, "agentify-scanner", "/folder/page")).toBe(true);
  });

  it("reads * in a robots rule as any run of characters, the empty one included", () => {
    const parsed = parseRobots(`
User-agent: *
Disallow: /*/collections/*+*
`);
    expect(isPathAllowed(parsed, "agentify-scanner", "/en/collections/shoes+boots")).toBe(false);
    expect(isPathAllowed(parsed, "agentify-scanner", "//collections/+")).toBe(false);
    expect(isPathAllowed(parsed, "agentify-scanner", "/en/collections/shoes")).toBe(true);
    expect(isPathAllowed(parsed, "agentify-scanner", "/collections/shoes+boots")).toBe(true);
  });

  it("matches the pieces between wildcards in order, each character once", () => {
    const parsed = parseRobots(`
User-agent: *
Disallow: /*ab*ba
Disallow: /js*js$
`);
    expect(isPathAllowed(parsed, "agentify-scanner", "/abba")).toBe(false);
    expect(isPathAllowed(parsed, "agentify-scanner", "/aba")).toBe(true);
    expect(isPathAllowed(parsed, "agentify-scanner", "/bab")).toBe(true);
    expect(isPathAllowed(parsed, "agentify-scanner", "/jsjs")).toBe(false);
    expect(isPathAllowed(parsed, "agentify-scanner", "/js")).toBe(true);
  });

  it("reads a trailing $ as the end of the path, and a $ anywhere else as itself", () => {
    const parsed = parseRobots(`
User-agent: *
Disallow: /*.pdf$
Disallow: /search$
Disallow: /price$list
`);
    expect(isPathAllowed(parsed, "agentify-scanner", "/files/menu.pdf")).toBe(false);
    expect(isPathAllowed(parsed, "agentify-scanner", "/files/menu.pdf.html")).toBe(true);
    expect(isPathAllowed(parsed, "agentify-scanner", "/search")).toBe(false);
    expect(isPathAllowed(parsed, "agentify-scanner", "/search/shoes")).toBe(true);
    expect(isPathAllowed(parsed, "agentify-scanner", "/price$list/2026")).toBe(false);
    expect(isPathAllowed(parsed, "agentify-scanner", "/price")).toBe(true);
  });

  it("reads a # anywhere in a line as the start of a comment", () => {
    const parsed = parseRobots(`
User-agent: GPTBot#openai
Disallow: /#!/admin
`);
    expect(explicitAiPolicies(parsed)).toEqual({ openai: ["gptbot"] });
    expect(isPathAllowed(parsed, "GPTBot", "/products/shoe")).toBe(false);
  });

  it("rejects XML entities and bounds sitemap entries", () => {
    expect(
      parseSitemap(`<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><urlset/>`),
    ).toMatchObject({
      valid: false,
      errorCode: "xml_entity_blocked",
    });
    expect(
      parseSitemap(
        `<urlset><url><loc>https://example.com/a</loc><lastmod>2026-01-01</lastmod></url></urlset>`,
      ),
    ).toMatchObject({ valid: true, urls: ["https://example.com/a"] });
  });

  it("blocks prototype keys and deeply nested JSON", () => {
    expect(parseSafeJson('{"__proto__":{"polluted":true}}')).toBeUndefined();
    expect(parseSafeJson(`${"[".repeat(42)}0${"]".repeat(42)}`)).toBeUndefined();
  });

  it("extracts JSON-LD without script or nav text", () => {
    const html = `<title>Store</title><nav>noise</nav><script>noise</script><script type="application/ld+json">{"@type":"Product","name":"A"}</script><main>Hello product</main>`;
    expect(parseJsonLd(html)).toMatchObject({
      scriptCount: 1,
      invalidCount: 0,
    });
    expect(visibleText(html)).toContain("Hello product");
    expect(visibleText(html)).not.toContain("noise");
  });
});

describe("what the parsers read from the markup real sites write", () => {
  // The quoting, case and attribute order below are what stores and blogs
  // actually serve: single quotes from Allbirds' Shopify theme, Yoast's feed
  // link and schema graph, attributes in either order. Addresses are
  // anonymized to example.com where they are not the store's own.
  it("reads the hreflang of every alternate link, as the site quotes and cases it", () => {
    const head = `<head>
<link rel='alternate' hreflang='en-US' href='https://www.allbirds.com/'>
<link rel='alternate' hreflang='x-default' href='https://www.allbirds.com/'>
<link rel="alternate" type="application/rss+xml" title="Example &raquo; Feed" href="https://example.com/feed/" />
<link href="https://example.com/de/" rel="alternate" hreflang="de-DE" />
<LINK REL="Alternate" HREFLANG="fr" HREF="https://example.com/fr/">
<link rel="canonical" href="https://example.com/">
<link rel="stylesheet" href="/cdn/shop/t/1/assets/base.css" media="all">
</head>`;
    expect(htmlSignals(head).hreflangs).toEqual(["en-US", "x-default", "de-DE", "fr"]);
  });

  it("reads the text a visitor sees, without scripts, styles or navigation", () => {
    const page = `<!doctype html><html lang="en"><head><title>Wool Runners &amp; More</title>
<style>.card>.price{color:#212a2f}</style>
<script>window.dataLayer=window.dataLayer||[];if(a<b&&c>d){track("view")}</script>
<SCRIPT type="text/javascript">var badge = "<span>New</span>";</SCRIPT>
</head><body>
<nav class="site-nav"><a href="/collections/mens">Men</a><a href="/collections/womens">Women</a></nav>
<!-- announcement bar -->
<main><h1 class="product__title">Men's Wool Runners</h1>
<p>Soft&nbsp;merino wool, $98&nbsp;USD.<br/>Free shipping &amp; returns</p></main>
<noscript><img src="/pixel.gif" alt=""> Enable JavaScript</noscript>
<footer>&copy; 2026 Example</footer></body></html>`;
    expect(visibleText(page)).toBe(
      "Wool Runners More Men's Wool Runners Soft merino wool, $98 USD. Free shipping returns Enable JavaScript &copy; 2026 Example",
    );
  });

  it("sees a page's title and heading and counts its links to products", () => {
    const page = `<title>Wool Runners | Example</title><h1 class="product__title">Wool Runner</h1>
<a href="/products/wool-runner">Wool Runner</a>
<a class="card__link" href='/collections/shop-all'>Shop all</a>
<A HREF="https://example.com/item/123">Item</A>
<a href="/pages/about-us">About</a><a>Menu</a>`;
    expect(htmlSignals(page)).toMatchObject({ hasTitle: true, hasH1: true, productLinkCount: 3 });
    expect(htmlSignals("<title></title><h1></h1>")).toMatchObject({
      hasTitle: false,
      hasH1: false,
    });
  });

  it("reads every JSON-LD script, whatever its other attributes, and counts those that do not parse", () => {
    const page = `<script type="application/ld+json" class="yoast-schema-graph">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","@id":"https://example.com/#webpage"},{"@type":"Organization","@id":"https://example.com/#organization"}]}</script>
<script nonce="cJA-mMYIUmt" id="product-jsonld" type='application/ld+json'>{"@context":"http://schema.org/","@type":"Product","name":"Wool Runner"}</script>
<script TYPE = "application/ld+json; charset=utf-8">{"@type":"BreadcrumbList"}</script>
<script type="application/ld+json">{"@type": "Offer",}</script>
<script type="application/json">{"@type":"Ignored"}</script>
<script src="https://cdn.shopify.com/s/files/1/app.js" defer></script>`;
    const parsed = parseJsonLd(page);
    expect(parsed).toMatchObject({ scriptCount: 4, invalidCount: 1 });
    expect(parsed.nodes.flatMap(jsonLdTypes)).toEqual([
      "WebPage",
      "Organization",
      "Product",
      "BreadcrumbList",
    ]);
  });

  it("reads a sitemap's page addresses and dates, and not its image addresses", () => {
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet type="text/xsl" href="//example.com/main-sitemap.xsl"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
\t<url>
\t\t<loc>https://example.com/products/wool-runner</loc>
\t\t<lastmod>2026-07-12T09:41:27+00:00</lastmod>
\t\t<image:image><image:loc>https://example.com/wp-content/uploads/runner.jpg</image:loc></image:image>
\t</url>
\t<url>
\t\t<loc>
\t\t\thttps://example.com/search?q=wool&amp;sort=price
\t\t</loc>
\t</url>
\t<url><loc>/pages/relative</loc></url>
</urlset>`;
    expect(parseSitemap(sitemap)).toEqual({
      valid: true,
      isIndex: false,
      urls: [
        "https://example.com/products/wool-runner",
        "https://example.com/search?q=wool&sort=price",
      ],
      lastmods: ["2026-07-12T09:41:27+00:00"],
    });
    const index = `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://example.com/product-sitemap.xml</loc><lastmod>2026-07-12T09:41:27+00:00</lastmod></sitemap></sitemapindex>`;
    expect(parseSitemap(index)).toMatchObject({
      valid: true,
      isIndex: true,
      urls: ["https://example.com/product-sitemap.xml"],
    });
  });
});

describe("a robots.txt as large as the fetch admits", () => {
  // The worker and the browser observer stop reading robots.txt at 512 KiB
  // (apps/scanner-worker/src/scan-runner.ts, apps/browser-observer-actor/src/runner.ts).
  // Parsing is synchronous: while it runs, the scan's deadline timer cannot
  // fire and every other scan in the process waits. Each case below is a
  // shape that once stalled the decision without bound or threw instead of
  // deciding; each is now decided, correctly, well inside the budget.
  //
  // A rule with a wildcard is searched for along the whole path, so many of
  // them against a long path cost time no matter how they are matched; past a
  // budget the decision is left open, and the scanner says robots.txt could
  // not be assessed rather than guess.
  const fetchCap = 512 * 1024;
  const budgetMs = 500;
  const decide = (body: string, path: string): { allowed?: boolean; ms: number } => {
    const started = performance.now();
    const allowed = isPathAllowed(parseRobots(body), "agentify-scanner", path);
    return { allowed, ms: performance.now() - started };
  };

  it("is decided in time when a line is nothing but whitespace", () => {
    const body = `User-agent: *\n${" ".repeat(fetchCap - 128)}x\nDisallow: /cart\n`;
    const decision = decide(body, "/cart");
    expect(decision.allowed).toBe(false);
    expect(decision.ms).toBeLessThan(budgetMs);
  });

  it("is decided in time when a Content-Signal is padded with whitespace", () => {
    const body = `User-agent: *\nDisallow: /cart\nContent-Signal: search=yes${" ".repeat(fetchCap - 128)}ai-train=no\n`;
    const decision = decide(body, "/cart");
    expect(decision.allowed).toBe(false);
    expect(decision.ms).toBeLessThan(budgetMs);
  });

  it("is decided in time when a rule is made of wildcards", () => {
    const body = `User-agent: *\nDisallow: /${"*a".repeat(32)}b\n`;
    const unmatched = decide(body, `/${"a".repeat(512)}`);
    expect(unmatched.allowed).toBe(true);
    expect(unmatched.ms).toBeLessThan(budgetMs);
    expect(decide(body, `/${"a".repeat(512)}b`).allowed).toBe(false);
  });

  it("is decided in time when one rule runs the length of the file", () => {
    const body = `User-agent: *\nDisallow: /${"a".repeat(fetchCap - 128)}\nDisallow: /cart\n`;
    const decision = decide(body, "/cart");
    expect(decision.allowed).toBe(false);
    expect(decision.ms).toBeLessThan(budgetMs);
  });

  it("is left open, in time, when wildcard rules against a long path cost too much", () => {
    const body = `User-agent: *\n${"Allow: *aaaaab\n".repeat(30_000)}Disallow: /\n`;
    const decision = decide(body, `/${"a".repeat(1_500)}`);
    expect(decision.allowed).toBeUndefined();
    expect(decision.ms).toBeLessThan(budgetMs);
  });

  it("is decided at its budget and left open one wildcard rule past it", () => {
    // Each wildcard rule costs the path's length plus its own: 1,022 + 2.
    // Rules without a wildcard only compare the path's start and cost nothing.
    const path = `/${"a".repeat(1_021)}`;
    const plain = "Disallow: /x\n".repeat(10_000);
    const body = (wildcards: number) => `User-agent: *\n${plain}${"Allow: *b\n".repeat(wildcards)}`;
    expect(decide(body(4_096), path).allowed).toBe(true);
    expect(decide(body(4_097), path).allowed).toBeUndefined();
  });

  it("counts every character of a wildcard rule toward its budget", () => {
    const path = `/${"a".repeat(1_021)}`;
    const body = `User-agent: *\n${"Allow: *b\n".repeat(4_095)}Disallow: /x${"*".repeat(2_000)}\n`;
    expect(decide(body, path).allowed).toBeUndefined();
  });

  it("is decided for every page of the largest real set of wildcard rules measured", () => {
    const etsy = readFileSync(
      new URL("./fixtures/robots/www.etsy.com.txt", import.meta.url),
      "utf8",
    );
    for (const path of [
      "/",
      "/listing/1234567890/handmade-ceramic-mug",
      "/c/home-and-living/kitchen-and-dining",
      "/search",
      `/listing/1234567890/${"a".repeat(2_048)}`,
    ])
      expect(decide(etsy, path).allowed).not.toBeUndefined();
  });
});
