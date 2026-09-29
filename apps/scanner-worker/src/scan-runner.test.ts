import type { FetchArtifact } from "@agentify/scanner";
import type { ScanJobV1 } from "@agentify/scanner-contracts";
import { describe, expect, it } from "vitest";
import type { PinnedTransport, PinnedTransportRequest } from "./safe-fetch.js";
import { isSameSite, ScanRunner } from "./scan-runner.js";

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

const transport = (robotsBody = robots, robotsStatus = 200) => {
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
        return makeArtifact(input, robotsStatus, robotsBody, "text/plain");
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
        return makeArtifact(input, 200, input.method === "HEAD" ? "" : html, "text/html");
      if (path === "/llms.txt") return makeArtifact(input, 404, "not found", "text/plain");
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
      isSameSite(new URL("https://www.example.co.uk/"), new URL("https://example.co.uk/")),
    ).toBe(true);
    expect(
      isSameSite(new URL("https://example.com.evil.co.uk/"), new URL("https://example.com/")),
    ).toBe(false);
    expect(isSameSite(new URL("https://foo.github.io/"), new URL("https://bar.github.io/"))).toBe(
      false,
    );
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
      target.paths.every((request) => request.startsWith("GET ") || request.startsWith("HEAD ")),
    ).toBe(true);
    expect(
      target.paths.filter((request) => request.startsWith("HEAD /products/widget")),
    ).toHaveLength(1);
    expect(
      target.paths.filter((request) => request.startsWith("GET /products/widget")),
    ).toHaveLength(1);
  });

  it("names itself in each request that carries an AI agent's user-agent token", async () => {
    const target = transport();
    await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: target.adapter,
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    const agentRequests = target.paths.filter(
      (request) => request.startsWith("GET / ") && request.includes("-User"),
    );
    expect(agentRequests).toHaveLength(2);
    for (const token of ["ChatGPT-User/1.0", "Claude-User"])
      expect(
        agentRequests.some((request) =>
          request.endsWith(
            ` ${token} (compatible; agentify-scanner/1.0; +https://agentify.ad/scanner)`,
          ),
        ),
      ).toBe(true);
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
    expect(first.checks.map(({ durationMs: _durationMs, ...check }) => check)).toEqual(
      second.checks.map(({ durationMs: _durationMs, ...check }) => check),
    );
  });

  it("fetches nothing but robots.txt when robots.txt keeps the scanner out of the site", async () => {
    const target = transport("User-agent: agentify-scanner\nDisallow: /\n");
    const runner = new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: target.adapter,
      appBaseUrl: "https://agentify.ad",
    });
    const evaluation = await runner.run(job);
    expect(target.paths.map((request) => request.split(" ").slice(0, 2).join(" "))).toEqual([
      "GET /robots.txt",
    ]);
    expect(evaluation.checks.find((check) => check.id === 12)?.status).toBe("unavailable");
    expect(evaluation.checks.find((check) => check.id === 13)?.status).toBe("unavailable");
  });

  it("names robots.txt as the reason for every check it kept from being assessed", async () => {
    const reasons = async (robotsBody: string, robotsStatus: number) => {
      const evaluation = await new ScanRunner({
        resolver: {
          resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        },
        transport: transport(robotsBody, robotsStatus).adapter,
        appBaseUrl: "https://agentify.ad",
      }).run(job);
      // Checks 1 to 3 read robots.txt itself; every other check needs a
      // request robots.txt rules on.
      return evaluation.checks
        .filter((check) => check.id > 3 && check.status === "unavailable")
        .map((check) => [check.id, check.errorCode]);
    };
    const everyRobotsCheck = (code: string) =>
      [4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 17, 18].map((id) => [id, code]);
    expect(await reasons("User-agent: agentify-scanner\nDisallow: /\n", 200)).toEqual(
      everyRobotsCheck("robots_disallowed"),
    );
    expect(await reasons("", 503)).toEqual(everyRobotsCheck("robots_unavailable"));
  });

  it("names robots.txt when it keeps the scanner off the OAuth documents an MCP server asks for", async () => {
    const target = transport("User-agent: *\nDisallow: /.well-known/oauth-\n");
    const adapter: PinnedTransport = {
      request: async (input) =>
        input.url.pathname === "/.well-known/mcp.json"
          ? makeArtifact(
              input,
              200,
              '{"name":"MCP","endpoint":"https://example.com/mcp","authorization":"oauth2"}',
              "application/json",
            )
          : target.adapter.request(input),
    };
    const evaluation = await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: adapter,
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    expect(target.paths.filter((request) => request.includes("/.well-known/oauth-"))).toEqual([]);
    expect(evaluation.checks.find((check) => check.id === 11)).toMatchObject({
      status: "unavailable",
      errorCode: "robots_disallowed",
    });
  });

  it("reads the sitemap and llms.txt robots.txt allows though it keeps the scanner off the page", async () => {
    const target = transport(
      "User-agent: *\nDisallow: /checkout\nAllow: /sitemap.xml\nAllow: /llms.txt\n",
    );
    const evaluation = await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: target.adapter,
      appBaseUrl: "https://agentify.ad",
    }).run({ ...job, canonical_target_url: "https://example.com/checkout" });
    expect(target.paths.some((request) => request.startsWith("GET /checkout "))).toBe(false);
    expect(target.paths.some((request) => request.startsWith("GET /sitemap.xml "))).toBe(true);
    expect(target.paths.some((request) => request.startsWith("GET /llms.txt "))).toBe(true);
    expect(
      [4, 8].map((id) => evaluation.checks.find((check) => check.id === id)?.errorCode),
    ).not.toContain("robots_disallowed");
  });

  it("does not report a store's product data absent when robots.txt kept its product pages out", async () => {
    const target = transport(
      "User-agent: *\nDisallow: /products/\nSitemap: https://example.com/sitemap.xml\n",
    );
    // A home page with no structured data and no feed link: only the product
    // page robots.txt disallows could have shown either.
    const adapter: PinnedTransport = {
      request: async (input) =>
        input.url.pathname === "/" && input.headers.accept !== "text/markdown"
          ? makeArtifact(
              input,
              200,
              `<html><head><title>Store</title></head><body><h1>Store</h1><main>${"Handmade goods from our workshop. ".repeat(20)}<a href="/products/widget">Widget</a></main></body></html>`,
              "text/html",
            )
          : target.adapter.request(input),
    };
    const evaluation = await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: adapter,
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    expect(target.paths.some((request) => request.includes("/products/"))).toBe(false);
    expect(
      [5, 6, 15].map((id) => {
        const check = evaluation.checks.find((candidate) => candidate.id === id);
        return [check?.status, check?.errorCode];
      }),
    ).toEqual([
      ["unavailable", "robots_disallowed"],
      ["unavailable", "robots_disallowed"],
      ["unavailable", "robots_disallowed"],
    ]);
  });

  it("reads a robots.txt rule against the query as well as the path", async () => {
    // Shopify's default robots.txt keeps crawlers off theme previews this way.
    const target = transport("User-agent: *\nDisallow: /*preview_theme_id*\n");
    const evaluation = await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: target.adapter,
      appBaseUrl: "https://agentify.ad",
    }).run({ ...job, canonical_target_url: "https://example.com/?preview_theme_id=5" });
    expect(target.paths.some((request) => request.startsWith("GET / "))).toBe(false);
    expect(evaluation.checks.find((check) => check.id === 12)?.errorCode).toBe("robots_disallowed");
  });

  it("follows a redirect only where robots.txt allows the address it leads to", async () => {
    const target = transport("User-agent: *\nDisallow: /private/\n");
    const adapter: PinnedTransport = {
      request: async (input) =>
        input.url.pathname === "/llms.txt"
          ? {
              ...makeArtifact(input, 301, "", "text/plain"),
              redirectLocation: "https://example.com/private/llms.txt",
            }
          : target.adapter.request(input),
    };
    const evaluation = await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: adapter,
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    expect(target.paths.some((request) => request.includes("/private/"))).toBe(false);
    expect(evaluation.checks.find((check) => check.id === 8)?.errorCode).toBe("robots_disallowed");

    // The page itself, and each of its four requests, redirected the same way.
    const page = transport("User-agent: *\nDisallow: /private/\n");
    const moved: PinnedTransport = {
      request: async (input) =>
        input.url.pathname === "/"
          ? {
              ...makeArtifact(input, 302, "", "text/html"),
              redirectLocation: "https://example.com/private/home",
            }
          : page.adapter.request(input),
    };
    const pageEvaluation = await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: moved,
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    expect(page.paths.some((request) => request.includes("/private/"))).toBe(false);
    // Markdown and agent access read that page alone.
    expect(
      [7, 13].map((id) => pageEvaluation.checks.find((check) => check.id === id)?.errorCode),
    ).toEqual(["robots_disallowed", "robots_disallowed"]);
  });

  it("judges an address on another host of the site by that host's own robots.txt", async () => {
    const requested: string[] = [];
    const target = transport(
      "User-agent: *\nAllow: /\nSitemap: https://static.example.com/sitemap.xml\n",
    );
    const adapter: PinnedTransport = {
      request: async (input) => {
        requested.push(`${input.method} ${input.url.host}${input.url.pathname}`);
        if (input.url.host === "static.example.com")
          return input.url.pathname === "/robots.txt"
            ? makeArtifact(input, 200, "User-agent: *\nDisallow: /\n", "text/plain")
            : makeArtifact(input, 200, "<urlset></urlset>", "application/xml");
        if (input.url.host === "example.com" && input.url.pathname === "/")
          return {
            ...makeArtifact(input, 301, "", "text/html"),
            redirectLocation: "https://www.example.com/",
          };
        if (input.url.host === "www.example.com" && input.url.pathname === "/robots.txt")
          return makeArtifact(input, 200, "User-agent: *\nAllow: /\n", "text/plain");
        return target.adapter.request(input);
      },
    };
    await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: adapter,
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    // The other host's robots.txt is read, once, and its sitemap is not.
    expect(
      requested.filter((request) => request === "GET static.example.com/robots.txt"),
    ).toHaveLength(1);
    expect(requested).not.toContain("GET static.example.com/sitemap.xml");
    // A page that moved to www is read once www's robots.txt allows it.
    expect(requested).toContain("GET www.example.com/robots.txt");
    expect(requested).toContain("GET www.example.com/");
  });

  it("finishes a scan when one of its requests fails, and says which and why", async () => {
    // A sitemap on a host of the site that does not resolve, and an llms.txt
    // that redirects from https to http, which the scanner does not follow.
    const target = transport(
      "User-agent: *\nAllow: /\nSitemap: https://cdn.example.com/sitemap.xml\n",
    );
    const adapter: PinnedTransport = {
      request: async (input) =>
        input.url.pathname === "/llms.txt"
          ? {
              ...makeArtifact(input, 301, "", "text/plain"),
              redirectLocation: "http://example.com/llms.txt",
            }
          : target.adapter.request(input),
    };
    const evaluation = await new ScanRunner({
      resolver: {
        resolve: async (hostname) => {
          if (hostname === "cdn.example.com")
            throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
              code: "ENOTFOUND",
            });
          return [{ address: "93.184.216.34", family: 4 }];
        },
      },
      transport: adapter,
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    expect(evaluation.checks).toHaveLength(18);
    expect(evaluation.checks.find((check) => check.id === 12)?.status).toBe("pass");
    expect(
      [4, 8].map((id) => evaluation.checks.find((check) => check.id === id)?.errorCode),
    ).toEqual(["dns_error", "redirect_downgrade_blocked"]);
  });

  it("does not fetch the well-known discovery files robots.txt keeps the scanner out of", async () => {
    const target = transport("User-agent: *\nDisallow: /.well-known/\n");
    await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: target.adapter,
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    expect(target.paths.some((request) => request.startsWith("GET / "))).toBe(true);
    expect(target.paths.filter((request) => request.includes("/.well-known/"))).toEqual([]);
  });

  it("does not report an unreadable robots.txt as a rule that keeps the scanner out", async () => {
    // Checks 4, 8 and 12 read the sitemap, llms.txt and the page's HTML.
    const blockedBy = async (robotsBody: string, robotsStatus: number) => {
      const evaluation = await new ScanRunner({
        resolver: {
          resolve: async () => [{ address: "93.184.216.34", family: 4 }],
        },
        transport: transport(robotsBody, robotsStatus).adapter,
        appBaseUrl: "https://agentify.ad",
      }).run(job);
      return [4, 8, 12].map((id) => evaluation.checks.find((check) => check.id === id)?.errorCode);
    };
    expect(await blockedBy("", 503)).toEqual([
      "robots_unavailable",
      "robots_unavailable",
      "robots_unavailable",
    ]);
    expect(await blockedBy("User-agent: *\nDisallow: /\n", 200)).toEqual([
      "robots_disallowed",
      "robots_disallowed",
      "robots_disallowed",
    ]);
  });

  it("does not fetch a page whose robots decision would cost too much, and says so", async () => {
    const path = `/${"a".repeat(1_500)}`;
    const target = transport(`User-agent: *\n${"Allow: *aaaaab\n".repeat(30_000)}`);
    const evaluation = await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: target.adapter,
      appBaseUrl: "https://agentify.ad",
    }).run({ ...job, canonical_target_url: `https://example.com${path}` });
    expect(target.paths.some((request) => request.startsWith(`GET ${path} `))).toBe(false);
    expect(evaluation.checks.find((check) => check.id === 12)?.errorCode).toBe(
      "robots_unavailable",
    );
  });

  it("fetches no sitemap or product URL whose robots decision was left open", async () => {
    const longSitemap = `/${"a".repeat(1_500)}.xml`;
    const longProduct = `/products/${"a".repeat(1_500)}`;
    const target = transport(
      `User-agent: *\n${"Allow: *aaaaab\n".repeat(30_000)}Sitemap: https://example.com/sitemap.xml\nSitemap: https://example.com${longSitemap}\n`,
    );
    const adapter: PinnedTransport = {
      request: async (input) =>
        input.url.pathname === "/sitemap.xml"
          ? makeArtifact(
              input,
              200,
              `<urlset><url><loc>https://example.com${longProduct}</loc></url></urlset>`,
              "application/xml",
            )
          : target.adapter.request(input),
    };
    await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: adapter,
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    expect(target.paths.some((request) => request.startsWith("GET / "))).toBe(true);
    expect(target.paths.some((request) => request.includes(longSitemap))).toBe(false);
    expect(target.paths.some((request) => request.includes(longProduct))).toBe(false);
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
    expect(target.paths.some((request) => request.startsWith("HEAD /products/widget"))).toBe(false);
    expect(target.paths.some((request) => request.startsWith("GET /products/widget"))).toBe(false);
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
            if (input.method === "HEAD") return makeArtifact(input, 405, "", "text/html");
          }
          return await backing.adapter.request(input);
        },
      },
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    expect(methods).toEqual(["HEAD", "GET"]);
    expect(evaluation.checks.find((check) => check.id === 12)?.status).toBe("pass");
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
    expect(evaluation.checks.find((check) => check.id === 6)?.status).toBe("pass");
    expect(evaluation.checks.find((check) => check.id === 12)?.status).toBe("pass");
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
            ["pass", "partial", "fail", "unavailable", "not_applicable"].includes(check.status),
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
            ...makeArtifact(input, failure.status, "upstream unavailable", "text/plain"),
            ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
          };
        },
      },
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    expect(requests).toEqual(["/robots.txt"]);
    expect(evaluation.requestCount).toBe(1);
    expect(evaluation.checks.find((check) => check.id === 12)?.status).toBe("unavailable");
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
          return makeArtifact(input, 200, "User-agent: *\nAllow: /\u0000", "text/plain");
        },
      },
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    expect(requests).toEqual(["/robots.txt"]);
    expect(evaluation.requestCount).toBe(1);
  });

  it.each([404, 410])("treats robots %s as allow-all for the fetch graph", async (status) => {
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
  });

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
          if (input.url.protocol === "https:" && input.url.pathname === "/robots.txt")
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
    expect(protocols.slice(2).every((protocol) => protocol === "http:")).toBe(true);
    expect(evaluation.requestCount).toBeLessThanOrEqual(18);
  });
});
