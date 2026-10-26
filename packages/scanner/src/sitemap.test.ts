import { describe, expect, it } from "vitest";
import { evaluateChecks } from "./checks.js";
import type { FetchArtifact, ScanArtifacts } from "./model.js";

const now = new Date().toISOString();
const xml = (url: string, body: string, overrides: Partial<FetchArtifact> = {}): FetchArtifact => ({
  url,
  status: 200,
  headers: { "content-type": "application/xml" },
  body,
  decodedBytes: Buffer.byteLength(body),
  truncated: false,
  durationMs: 10,
  ttfbMs: 5,
  ...overrides,
});
const urlset = `<urlset><url><loc>https://example.com/p</loc><lastmod>${now}</lastmod></url></urlset>`;
const indexOf = (...locations: string[]) =>
  `<sitemapindex>${locations.map((loc) => `<sitemap><loc>${loc}</loc><lastmod>${now}</lastmod></sitemap>`).join("")}</sitemapindex>`;
const sitemapCheck = (...sitemap: FetchArtifact[]) =>
  evaluateChecks({
    segment: "owner",
    canonicalTargetUrl: "https://example.com/",
    robots: xml("https://example.com/robots.txt", "User-agent: *\nAllow: /\n", {
      headers: { "content-type": "text/plain" },
    }),
    agentProbes: {},
    sitemap,
    mcp: [],
    oauth: [],
  } satisfies ScanArtifacts).find(({ id }) => id === 4);

describe("a sitemap a redirect, a broken gzip file or a server warning stands for", () => {
  it("does not call a listed sitemap that redirected to another host of the site off-site", () => {
    expect(
      sitemapCheck(
        xml("https://example.com/sitemap.xml", indexOf("https://www.example.com/s1.xml")),
        xml("https://example.com/s1.xml", urlset, {
          requestedUrl: "https://www.example.com/s1.xml",
        }),
      ),
    ).toMatchObject({ status: "pass", summaryCode: "sitemap_valid" });
  });

  it("still names a listed sitemap on another site, which the scan does not read", () => {
    expect(
      sitemapCheck(xml("https://example.com/sitemap.xml", indexOf("https://cdn.other.net/s1.xml")))
        ?.evidence.sitemaps_unread,
    ).toEqual(["entry 1 of the sitemap index: listed on another site, not read"]);
  });

  it("reports a gzip sitemap that cannot be unpacked as broken, with the status it came with", () => {
    const broken = (url: string) =>
      xml(url, "", { errorCode: "gzip_unpacking_failed", decodedBytes: 0 });
    expect(sitemapCheck(broken("https://example.com/sitemap.xml.gz"))).toMatchObject({
      status: "fail",
      summaryCode: "sitemap_corrupt",
      evidence: { status: 200 },
      fixCode: "repair_sitemap_gzip",
    });
    expect(
      sitemapCheck(
        xml(
          "https://example.com/sitemap.xml",
          indexOf("https://example.com/s1.xml", "https://example.com/s2.xml.gz"),
        ),
        xml("https://example.com/s1.xml", urlset),
        broken("https://example.com/s2.xml.gz"),
      ),
    ).toMatchObject({
      status: "partial",
      summaryCode: "sitemap_entries_missing",
      evidence: {
        sitemaps_missing: ["entry 2 of the sitemap index: a gzip file that cannot be unpacked"],
      },
    });
  });

  it("takes a page with a server warning before its doctype for no sitemap", () => {
    expect(
      sitemapCheck(
        xml(
          "https://example.com/sitemap.xml",
          "<br />\n<b>Warning</b>: session_start() failed<br />\n<!DOCTYPE html><html><body>x</body></html>",
          { headers: { "content-type": "text/html" } },
        ),
      ),
    ).toMatchObject({ status: "fail", summaryCode: "sitemap_not_sitemap" });
    expect(
      sitemapCheck(xml("https://example.com/sitemap.xml", `<!DOCTYPE urlset>${urlset}`)),
    ).toMatchObject({ status: "unavailable", summaryCode: "sitemap_doctype" });
  });
});
