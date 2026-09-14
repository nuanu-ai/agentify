import type { ScanJobV1 } from "@b2a/contracts";
import { describe, expect, it } from "vitest";
import type { FetchArtifact } from "@b2a/scanner-core";
import { isSameSite, ScanRunner } from "./scan-runner.js";
import type { PinnedTransport, PinnedTransportRequest } from "./safe-fetch.js";

const product = JSON.stringify({
  "@type": "Product",
  name: "Widget",
  image: "https://example.com/widget.jpg",
  url: "https://example.com/products/widget",
  offers: { price: "19.00", priceCurrency: "USD", availability: "InStock" },
});
const html = `<html><head><title>Store</title><script type="application/ld+json">${product}</script><link rel="alternate" hreflang="en" href="https://example.com/en"><link rel="alternate" hreflang="de" href="https://example.com/de"></head><body><h1>Store</h1><main>${"Public product information for deterministic scanner integration. ".repeat(12)}<a href="/products/widget">Widget $19.00 USD</a><meta property="product:price" content="19"></main></body></html>`;
const robots = `User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\nContent-Signal: search=yes, ai-input=no, ai-train=no\n${["GPTBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "PerplexityBot", "Google-Extended"].map((agent) => `User-agent: ${agent}\nAllow: /`).join("\n")}`;

const job: ScanJobV1 = {
  scan_id: "018f3f56-2ec8-7b16-8f66-5b8f93f3251f",
  canonical_target_url: "https://example.com/",
  segment: "store",
  rubric_version: "gtm-v1.0.0",
  deadline_at: new Date(Date.now() + 55_000).toISOString(),
  attempt_no: 1,
};

const makeArtifact = (
  input: PinnedTransportRequest,
  status: number,
  body: string,
  type: string,
): FetchArtifact => ({
  url: input.url.toString(),
  status,
  headers: {
    "content-type": type,
    ...(input.headers.accept === "text/markdown" ? { vary: "Accept" } : {}),
  },
  body,
  decodedBytes: Buffer.byteLength(body),
  truncated: false,
  durationMs: 10,
  ttfbMs: 5,
});

const transport = (robotsBody = robots) => {
  const paths: string[] = [];
  let active = 0;
  let maxActive = 0;
  const adapter: PinnedTransport = {
    request: async (input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      paths.push(
        `${input.method} ${input.url.pathname} ${input.headers.accept} ${input.headers["user-agent"]}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      const path = input.url.pathname;
      if (path === "/robots.txt")
        return makeArtifact(input, 200, robotsBody, "text/plain");
      if (path === "/") {
        if (input.headers.accept === "text/markdown")
          return makeArtifact(
            input,
            200,
            `# Store\n\n${"Machine catalog. ".repeat(30)}`,
            "text/markdown",
          );
        return makeArtifact(input, 200, html, "text/html");
      }
      if (path === "/sitemap.xml")
        return makeArtifact(
          input,
          200,
          `<urlset><url><loc>https://example.com/products/widget</loc><lastmod>${new Date().toISOString()}</lastmod></url></urlset>`,
          "application/xml",
        );
      if (path === "/products/widget")
        return makeArtifact(
          input,
          200,
          input.method === "HEAD" ? "" : html,
          "text/html",
        );
      if (path === "/llms.txt")
        return makeArtifact(input, 404, "not found", "text/plain");
      if (path === "/.well-known/mcp.json")
        return makeArtifact(
          input,
          200,
          '{"name":"MCP","endpoint":"https://example.com/mcp"}',
          "application/json",
        );
      if (path === "/.well-known/ucp")
        return makeArtifact(
          input,
          200,
          '{"version":"1","endpoint":"https://example.com/ucp","services":{"shopping":{}},"capabilities":["catalog"]}',
          "application/json",
        );
      return makeArtifact(input, 404, "{}", "application/json");
    },
  };
  return { adapter, paths, getMaxActive: () => maxActive };
};

describe("bounded scan graph", () => {
  it("uses PSL registrable domains for same-site boundaries", () => {
    expect(
      isSameSite(
        new URL("https://www.example.co.uk/"),
        new URL("https://example.co.uk/"),
      ),
    ).toBe(true);
    expect(
      isSameSite(
        new URL("https://example.com.evil.co.uk/"),
        new URL("https://example.com/"),
      ),
    ).toBe(false);
    expect(
      isSameSite(
        new URL("https://foo.github.io/"),
        new URL("https://bar.github.io/"),
      ),
    ).toBe(false);
  });

  it("runs all 18 checks under the request and per-origin limits", async () => {
    const target = transport();
    const runner = new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: target.adapter,
      appBaseUrl: "https://agentify.ad",
    });
    const evaluation = await runner.run(job);
    expect(evaluation.checks).toHaveLength(18);
    expect(evaluation.requestCount).toBeLessThanOrEqual(18);
    expect(target.getMaxActive()).toBeLessThanOrEqual(2);
    expect(
      target.paths.every(
        (request) => request.startsWith("GET ") || request.startsWith("HEAD "),
      ),
    ).toBe(true);
    expect(
      target.paths.filter((request) =>
        request.startsWith("HEAD /products/widget"),
      ),
    ).toHaveLength(1);
    expect(
      target.paths.filter((request) =>
        request.startsWith("GET /products/widget"),
      ),
    ).toHaveLength(1);
  });

  it("is deterministic across two identical runs except transport timing evidence", async () => {
    const run = async () => {
      const target = transport();
      return await new ScanRunner({
        resolver: {
          resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        },
        transport: target.adapter,
        appBaseUrl: "https://agentify.ad",
      }).run(job);
    };
    const [first, second] = await Promise.all([run(), run()]);
    expect(first.score).toEqual(second.score);
    expect(first.findings).toEqual(second.findings);
    expect(
      first.checks.map(({ durationMs: _durationMs, ...check }) => check),
    ).toEqual(
      second.checks.map(({ durationMs: _durationMs, ...check }) => check),
    );
  });

  it("limits a target-disallowed scan to robots and explicit well-known discovery", async () => {
    const target = transport("User-agent: agentify-scanner\nDisallow: /\n");
    const runner = new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: target.adapter,
      appBaseUrl: "https://agentify.ad",
    });
    const evaluation = await runner.run(job);
    expect(
      target.paths.some((request) => request.startsWith("GET / text/html")),
    ).toBe(false);
    expect(
      target.paths.some((request) => request.includes("/.well-known/mcp.json")),
    ).toBe(true);
    expect(
      target.paths.some((request) => request.includes("/sitemap.xml")),
    ).toBe(false);
    expect(target.paths.some((request) => request.includes("/llms.txt"))).toBe(
      false,
    );
    expect(
      target.paths.some((request) => request.includes("/products/widget")),
    ).toBe(false);
    expect(evaluation.checks.find((check) => check.id === 12)?.status).toBe(
      "unavailable",
    );
    expect(evaluation.checks.find((check) => check.id === 13)?.status).toBe(
      "unavailable",
    );
  });

  it("does not fetch a disallowed representative path", async () => {
    const target = transport(
      "User-agent: agentify-scanner\nAllow: /\nDisallow: /products/\nSitemap: https://example.com/sitemap.xml\n",
    );
    const evaluation = await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: target.adapter,
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    expect(
      target.paths.some((request) =>
        request.startsWith("HEAD /products/widget"),
      ),
    ).toBe(false);
    expect(
      target.paths.some((request) =>
        request.startsWith("GET /products/widget"),
      ),
    ).toBe(false);
    expect(evaluation.requestCount).toBeLessThanOrEqual(18);
  });

  it("uses the single GET when a representative candidate rejects HEAD", async () => {
    const backing = transport();
    const methods: string[] = [];
    const evaluation = await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: {
        request: async (input) => {
          if (input.url.pathname === "/products/widget") {
            methods.push(input.method);
            if (input.method === "HEAD")
              return makeArtifact(input, 405, "", "text/html");
          }
          return await backing.adapter.request(input);
        },
      },
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    expect(methods).toEqual(["HEAD", "GET"]);
    expect(evaluation.checks.find((check) => check.id === 12)?.status).toBe(
      "pass",
    );
    expect(evaluation.requestCount).toBeLessThanOrEqual(18);
  });

  it("prioritizes same-site sitemap-index children within three files", async () => {
    const backing = transport();
    const sitemapRequests: string[] = [];
    const recent = new Date().toISOString();
    const evaluation = await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: {
        request: async (input) => {
          const path = input.url.pathname;
          if (path === "/robots.txt")
            return makeArtifact(
              input,
              200,
              "User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap-index.xml\nSitemap: https://example.com/secondary.xml\n",
              "text/plain",
            );
          if (path === "/sitemap-index.xml") {
            sitemapRequests.push(`${input.url.hostname}${path}`);
            return makeArtifact(
              input,
              200,
              `<sitemapindex>
                <sitemap><loc>https://www.example.com/sitemaps/products.xml</loc><lastmod>${recent}</lastmod></sitemap>
                <sitemap><loc>https://example.com/sitemaps/general.xml</loc><lastmod>${recent}</lastmod></sitemap>
                <sitemap><loc>https://example.com/sitemaps/overflow.xml</loc><lastmod>${recent}</lastmod></sitemap>
              </sitemapindex>`,
              "application/xml",
            );
          }
          if (path === "/sitemaps/products.xml") {
            sitemapRequests.push(`${input.url.hostname}${path}`);
            return makeArtifact(
              input,
              200,
              `<urlset><url><loc>https://shop.example.com/products/widget</loc><lastmod>${recent}</lastmod></url></urlset>`,
              "application/xml",
            );
          }
          if (path === "/sitemaps/general.xml") {
            sitemapRequests.push(`${input.url.hostname}${path}`);
            return makeArtifact(
              input,
              200,
              `<urlset><url><loc>https://example.com/about</loc><lastmod>${recent}</lastmod></url></urlset>`,
              "application/xml",
            );
          }
          if (path === "/secondary.xml" || path === "/sitemaps/overflow.xml") {
            sitemapRequests.push(`${input.url.hostname}${path}`);
            return makeArtifact(input, 500, "unexpected", "text/plain");
          }
          return await backing.adapter.request(input);
        },
      },
      appBaseUrl: "https://agentify.ad",
    }).run(job);

    expect(sitemapRequests).toEqual([
      "example.com/sitemap-index.xml",
      "www.example.com/sitemaps/products.xml",
      "example.com/sitemaps/general.xml",
    ]);
    expect(evaluation.requestCount).toBeLessThanOrEqual(18);
    expect(evaluation.checks.find((check) => check.id === 4)).toMatchObject({
      status: "pass",
      evidence: { files_checked: 3 },
    });
    expect(evaluation.checks.find((check) => check.id === 5)).toMatchObject({
      status: "pass",
      evidence: { pages_checked: 2 },
    });
    expect(evaluation.checks.find((check) => check.id === 6)?.status).toBe(
      "pass",
    );
    expect(evaluation.checks.find((check) => check.id === 12)?.status).toBe(
      "pass",
    );
  });

  it("writes real terminal check batches monotonically as phases finish", async () => {
    const target = transport();
    const batches: number[][] = [];
    const evaluation = await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: target.adapter,
      appBaseUrl: "https://agentify.ad",
    }).run(job, {
      onChecksComplete: async (checks) => {
        expect(
          checks.every((check) =>
            [
              "pass",
              "partial",
              "fail",
              "unavailable",
              "not_applicable",
            ].includes(check.status),
          ),
        ).toBe(true);
        batches.push(checks.map(({ id }) => id));
      },
    });
    expect(batches[0]).toEqual([1, 2, 3]);
    expect(batches.length).toBeGreaterThanOrEqual(3);
    const written = batches.flat();
    expect(written).toHaveLength(18);
    expect(new Set(written).size).toBe(18);
    expect(evaluation.checks).toHaveLength(18);
  });

  it.each([
    { status: 503, errorCode: undefined },
    { status: 0, errorCode: "network_error" },
  ])("fails closed after robots $status failure", async (failure) => {
    const requests: string[] = [];
    const evaluation = await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: {
        request: async (input) => {
          requests.push(input.url.pathname);
          return {
            ...makeArtifact(
              input,
              failure.status,
              "upstream unavailable",
              "text/plain",
            ),
            ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
          };
        },
      },
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    expect(requests).toEqual(["/robots.txt"]);
    expect(evaluation.requestCount).toBe(1);
    expect(evaluation.checks.find((check) => check.id === 12)?.status).toBe(
      "unavailable",
    );
  });

  it("fails closed on a fatally invalid robots body", async () => {
    const requests: string[] = [];
    const evaluation = await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: {
        request: async (input) => {
          requests.push(input.url.pathname);
          return makeArtifact(
            input,
            200,
            "User-agent: *\nAllow: /\u0000",
            "text/plain",
          );
        },
      },
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    expect(requests).toEqual(["/robots.txt"]);
    expect(evaluation.requestCount).toBe(1);
  });

  it.each([404, 410])(
    "treats robots %s as allow-all for the fetch graph",
    async (status) => {
      const backing = transport();
      const paths: string[] = [];
      const evaluation = await new ScanRunner({
        resolver: {
          resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        },
        transport: {
          request: async (input) => {
            paths.push(input.url.pathname);
            return input.url.pathname === "/robots.txt"
              ? makeArtifact(input, status, "not found", "text/plain")
              : await backing.adapter.request(input);
          },
        },
        appBaseUrl: "https://agentify.ad",
      }).run(job);
      expect(paths).toContain("/");
      expect(paths).toContain("/.well-known/mcp.json");
      expect(evaluation.requestCount).toBeLessThanOrEqual(18);
    },
  );

  it("uses the submitted-without-scheme signal for one safe HTTP fallback", async () => {
    const backing = transport();
    const protocols: string[] = [];
    const evaluation = await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: {
        request: async (input) => {
          protocols.push(input.url.protocol);
          if (
            input.url.protocol === "https:" &&
            input.url.pathname === "/robots.txt"
          )
            return {
              ...makeArtifact(input, 0, "", "text/plain"),
              errorCode: "network_error",
            };
          return await backing.adapter.request(input);
        },
      },
      appBaseUrl: "https://agentify.ad",
    }).run({ ...job, submitted_without_scheme: true });
    expect(protocols.slice(0, 2)).toEqual(["https:", "http:"]);
    expect(protocols.slice(2).every((protocol) => protocol === "http:")).toBe(
      true,
    );
    expect(evaluation.requestCount).toBeLessThanOrEqual(18);
  });
});
