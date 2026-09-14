import { describe, expect, it } from "vitest";
import {
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
    expect(isPathAllowed(parsed, "agentify-scanner", "/private/public/x")).toBe(
      true,
    );
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
    expect(isPathAllowed(specificDeny, "agentify-scanner", "/public")).toBe(
      false,
    );
    expect(isPathAllowed(specificDeny, "agentify-scanner/1.0", "/public")).toBe(
      false,
    );

    const specificAllow = parseRobots(`
User-agent: *
Disallow: /
User-agent: agentify-scanner
Allow: /
`);
    expect(isPathAllowed(specificAllow, "agentify-scanner", "/public")).toBe(
      true,
    );
    expect(isPathAllowed(specificAllow, "unmatched-bot", "/public")).toBe(
      false,
    );
  });

  it("rejects XML entities and bounds sitemap entries", () => {
    expect(
      parseSitemap(
        `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><urlset/>`,
      ),
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
    expect(
      parseSafeJson(`${"[".repeat(42)}0${"]".repeat(42)}`),
    ).toBeUndefined();
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
