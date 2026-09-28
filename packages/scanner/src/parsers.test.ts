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

describe("a robots.txt as large as the fetch admits", () => {
  // The worker and the browser observer stop reading robots.txt at 512 KiB
  // (apps/scanner-worker/src/scan-runner.ts, apps/browser-observer-actor/src/runner.ts).
  // Parsing is synchronous: while it runs, the scan's deadline timer cannot
  // fire and every other scan in the process waits. Each case below is a
  // shape that once stalled the decision without bound or threw instead of
  // deciding; each is now decided, correctly, well inside the budget.
  //
  // What these cases do not bound: a file of many short wildcard rules costs
  // time in proportion to the number of rules times the length of the path,
  // about 0.65 s for 37,000 rules against a 2 KiB path.
  const fetchCap = 512 * 1024;
  const budgetMs = 500;
  const decide = (body: string, path: string): { allowed: boolean; ms: number } => {
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
});
