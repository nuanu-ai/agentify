import { describe, expect, it } from "vitest";
import { parseJsonLd, parseSafeJson, parseSitemap, visibleText } from "./parsers.js";
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
