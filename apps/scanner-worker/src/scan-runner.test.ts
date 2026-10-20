import { readFileSync } from "node:fs";
import { type FetchArtifact, scanStopReason } from "@agentify/scanner";
import type { CheckResult, ScanJobV1 } from "@agentify/scanner-contracts";
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
    expect(evaluation.checks.find((check) => check.id === 11)?.status).toBe("not_applicable");
    expect(target.paths.filter((request) => request.includes("/.well-known/oauth-"))).toEqual([]);
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

  it("sends no request in an AI agent's name where robots.txt keeps that agent off the page", async () => {
    const target = transport("User-agent: *\nAllow: /\n\nUser-agent: ChatGPT-User\nDisallow: /\n");
    const evaluation = await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: target.adapter,
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    expect(target.paths.filter((request) => request.includes("ChatGPT-User"))).toEqual([]);
    expect(evaluation.checks.find((check) => check.id === 13)).toMatchObject({
      status: "unavailable",
      summaryCode: "agent_ua_robots_disallowed",
      evidence: { chatgpt_robots_disallowed: true, claude_robots_disallowed: false },
    });
    // The scanner itself was let in, so no check says robots.txt kept it out.
    expect(evaluation.checks.filter((check) => check.errorCode === "robots_disallowed")).toEqual(
      [],
    );
  });

  it("follows no redirect in an AI agent's name to an address robots.txt keeps that agent off", async () => {
    const target = transport(
      "User-agent: *\nAllow: /\n\nUser-agent: Claude-User\nDisallow: /agents/\n",
    );
    const adapter: PinnedTransport = {
      request: async (input) =>
        input.url.pathname === "/" && input.headers["user-agent"]?.startsWith("Claude-User")
          ? {
              ...makeArtifact(input, 302, "", "text/html"),
              redirectLocation: "https://example.com/agents/home",
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
    expect(target.paths.some((request) => request.includes("/agents/"))).toBe(false);
    expect(evaluation.checks.find((check) => check.id === 13)?.summaryCode).toBe(
      "agent_ua_robots_disallowed",
    );
  });

  it("follows no redirect in an AI agent's name to an address the scanner's own group keeps it off", async () => {
    const target = transport(
      "User-agent: *\nAllow: /\n\nUser-agent: agentify-scanner\nDisallow: /agents/\n",
    );
    const adapter: PinnedTransport = {
      request: async (input) =>
        input.url.pathname === "/" && input.headers["user-agent"]?.startsWith("ChatGPT-User")
          ? {
              ...makeArtifact(input, 302, "", "text/html"),
              redirectLocation: "https://example.com/agents/home",
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
    expect(target.paths.some((request) => request.includes("/agents/"))).toBe(false);
    expect(evaluation.checks.find((check) => check.id === 13)?.status).toBe("unavailable");
  });

  it("sends the user agents the documentation's page about the scanner names, with the channel's own address", async () => {
    // The page names the site's address as `{{origin}}`, which Caddy fills
    // from the address the scanner is given as its own.
    const page = readFileSync(new URL("../../docs/scanner/index.md", import.meta.url), "utf8");
    const named = [
      ...page.replace(/\s+/g, " ").matchAll(/`([^`]*agentify-scanner\/1\.0[^`]*)`/g),
    ].map(([, agent = ""]) => agent.replaceAll("{{origin}}", "https://test.agentify.ad"));
    const target = transport();
    await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: target.adapter,
      appBaseUrl: "https://test.agentify.ad",
    }).run(job);
    // Each request is recorded as its method, path, Accept and user agent, in that order.
    const sentAs = (agent: string) =>
      target.paths.filter((request) => request.endsWith(` ${agent}`));

    expect(named).toHaveLength(2);
    for (const agent of named) expect(sentAs(agent), agent).not.toEqual([]);
  });

  it("keeps out of a site whose robots.txt names the token the documentation's page gives the scanner", async () => {
    const page = readFileSync(new URL("../../docs/scanner/index.md", import.meta.url), "utf8");
    const token = /the scanner answers to the token `([^`]+)`/.exec(page.replace(/\s+/g, " "))?.[1];
    expect(token).toBeDefined();
    const target = transport(`User-agent: *\nAllow: /\n\nUser-agent: ${token}\nDisallow: /\n`);
    await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: target.adapter,
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    expect(target.paths.map((request) => request.split(" ").slice(0, 2).join(" "))).toEqual([
      "GET /robots.txt",
    ]);
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

  it.each(["/", "/.well-known/mcp.json"])(
    "checks OAuth metadata declared only by the HTTP header on %s",
    async (declaredAt) => {
      const target = transport();
      const requested: string[] = [];
      const completed: CheckResult[] = [];
      const adapter: PinnedTransport = {
        request: async (input) => {
          if (input.url.pathname.startsWith("/.well-known/oauth-")) {
            requested.push(input.url.pathname);
            return makeArtifact(
              input,
              200,
              JSON.stringify(
                input.url.pathname.endsWith("authorization-server")
                  ? {
                      issuer: "https://example.com",
                      authorization_endpoint: "https://example.com/oauth/authorize",
                      token_endpoint: "https://example.com/oauth/token",
                    }
                  : {
                      resource: "https://example.com/mcp",
                      authorization_servers: ["https://example.com"],
                    },
              ),
              "application/json",
            );
          }
          const fetched = await target.adapter.request(input);
          return input.url.pathname === declaredAt
            ? {
                ...fetched,
                ...(declaredAt === "/" ? {} : { status: 401, body: "", decodedBytes: 0 }),
                headers: {
                  ...fetched.headers,
                  "www-authenticate":
                    'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
                },
              }
            : fetched;
        },
      };
      const evaluation = await new ScanRunner({
        resolver: { resolve: async () => [{ address: "93.184.216.34", family: 4 }] },
        transport: adapter,
        appBaseUrl: "https://agentify.ad",
      }).run(job, {
        onChecksComplete: async (checks) => {
          completed.push(...checks);
        },
      });
      expect(requested.sort()).toEqual([
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-protected-resource",
      ]);
      const oauth = evaluation.checks.find((check) => check.id === 11);
      expect(oauth).toMatchObject({ status: "pass", earnedWeight: 4 });
      expect(completed.filter((check) => check.id === 11)).toEqual([oauth]);
    },
  );

  it.each(["document", "header"])(
    "names robots.txt when it blocks OAuth declared by an MCP %s",
    async (source) => {
      const target = transport("User-agent: *\nDisallow: /.well-known/oauth-\n");
      const adapter: PinnedTransport = {
        request: async (input) =>
          input.url.pathname === "/.well-known/mcp.json"
            ? {
                ...makeArtifact(
                  input,
                  source === "document" ? 200 : 401,
                  source === "document"
                    ? '{"name":"MCP","endpoint":"https://example.com/mcp","authorization":"oauth2"}'
                    : "",
                  "application/json",
                ),
                ...(source === "header" ? { headers: { "www-authenticate": "Bearer" } } : {}),
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
      expect(target.paths.filter((request) => request.includes("/.well-known/oauth-"))).toEqual([]);
      expect(evaluation.checks.find((check) => check.id === 11)).toMatchObject({
        status: "unavailable",
        errorCode: "robots_disallowed",
      });
    },
  );

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

  // A store's product data can live only on its product pages. A scan of a
  // home page with no structured data and no feed link, whose sitemap lists
  // one product page, answered for that page by `answer` where it returns one.
  const productScan = async (
    answer: (input: PinnedTransportRequest) => FetchArtifact | undefined,
    sitemapHost = "example.com",
    home = `<html><head><title>Store</title></head><body><h1>Store</h1><main>${"Handmade goods from our workshop. ".repeat(20)}<a href="/products/widget">Widget</a></main></body></html>`,
  ) => {
    const target = transport();
    const adapter: PinnedTransport = {
      request: async (input) => {
        const answered = answer(input);
        if (answered) return answered;
        if (input.url.pathname === "/sitemap.xml")
          return makeArtifact(
            input,
            200,
            `<urlset><url><loc>https://${sitemapHost}/products/widget</loc></url></urlset>`,
            "application/xml",
          );
        return input.url.pathname === "/" && input.headers.accept !== "text/markdown"
          ? makeArtifact(input, 200, home, "text/html")
          : target.adapter.request(input);
      },
    };
    const evaluation = await new ScanRunner({
      resolver: {
        resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      },
      transport: adapter,
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    return evaluation.checks;
  };
  const productData = (checks: readonly CheckResult[]) =>
    [5, 6, 15].map((id) => {
      const check = checks.find((candidate) => candidate.id === id);
      return [check?.status, check?.errorCode];
    });
  const productPage = (input: PinnedTransportRequest) => input.url.pathname === "/products/widget";
  const failed = (input: PinnedTransportRequest, errorCode: string) => ({
    ...makeArtifact(input, 0, "", "text/plain"),
    errorCode,
  });

  // One the scanner could not read leaves that data unassessed, never absent.
  it.each([
    {
      failure: "its own read times out",
      errorCode: "fetch_timeout",
      answer: (input: PinnedTransportRequest) =>
        productPage(input) && input.method === "GET" ? failed(input, "fetch_timeout") : undefined,
    },
    {
      failure: "the connection resets on every request for it",
      errorCode: "connection_reset",
      answer: (input: PinnedTransportRequest) =>
        productPage(input) ? failed(input, "connection_reset") : undefined,
    },
    {
      failure: "it answers with a server error",
      errorCode: "product_page_unavailable",
      answer: (input: PinnedTransportRequest) =>
        productPage(input) ? makeArtifact(input, 503, "", "text/plain") : undefined,
    },
    {
      failure: "the sitemap lists it but it is gone",
      errorCode: "product_page_unavailable",
      answer: (input: PinnedTransportRequest) =>
        productPage(input) ? makeArtifact(input, 404, "", "text/html") : undefined,
    },
    {
      failure: "it turns the scanner away as too many requests",
      errorCode: "product_page_unavailable",
      answer: (input: PinnedTransportRequest) =>
        productPage(input) ? makeArtifact(input, 429, "", "text/plain") : undefined,
    },
    {
      failure: "its host's robots.txt could not be reached",
      errorCode: "fetch_timeout",
      sitemapHost: "shop.example.com",
      answer: (input: PinnedTransportRequest) =>
        input.url.hostname === "shop.example.com" && input.url.pathname === "/robots.txt"
          ? failed(input, "fetch_timeout")
          : undefined,
    },
  ])(
    "does not report a store's product data absent when $failure",
    async ({ errorCode, answer, sitemapHost }) => {
      expect(productData(await productScan(answer, sitemapHost))).toEqual([
        ["unavailable", errorCode],
        ["unavailable", errorCode],
        ["unavailable", errorCode],
      ]);
    },
  );

  it("reports a store's product data absent when its product page was read without any", async () => {
    // Shopify serves this script, which names a captcha, on every page of
    // every store; the page is the store's own all the same.
    const page = `<html><title>Widget</title><script id="captcha-bootstrap">!function(){'use strict';const t='contact'}();</script><body><h1>Widget</h1><p>Handmade in our workshop.</p></body></html>`;
    const checks = await productScan((input) =>
      productPage(input)
        ? makeArtifact(input, 200, input.method === "HEAD" ? "" : page, "text/html")
        : undefined,
    );
    expect(productData(checks)).toEqual([
      ["fail", undefined],
      ["fail", undefined],
      ["fail", undefined],
    ]);
  });

  it("does not read an error page in place of the product page", async () => {
    // The product page answers HEAD, then its GET a "not found" page that
    // carries a heading, text and prices, on a home page too thin to pass.
    const missing = `<html><title>Page not found</title><body><h1>Page not found</h1><p>${"Try our bestsellers from $19.00 instead. ".repeat(8)}</p></body></html>`;
    const checks = await productScan(
      (input) =>
        productPage(input)
          ? input.method === "HEAD"
            ? makeArtifact(input, 200, "", "text/html")
            : makeArtifact(input, 404, missing, "text/html")
          : undefined,
      "example.com",
      `<html><title>Store</title><body><a href="/products/widget">Widget</a></body></html>`,
    );
    expect(checks.find((check) => check.id === 12)).toMatchObject({
      status: "fail",
      evidence: { representative_checked: false },
    });
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

describe("why a scan the scanner stopped has no result", () => {
  const publicAddress = async () => [{ address: "93.184.216.34", family: 4 as const }];
  const stopped = async (
    resolver: ConstructorParameters<typeof ScanRunner>[0]["resolver"],
    adapter: PinnedTransport,
  ) => {
    const evaluation = await new ScanRunner({
      resolver,
      transport: adapter,
      appBaseUrl: "https://agentify.ad",
    }).run(job);
    return { terminal: evaluation.score.terminalStatus, stop: scanStopReason(evaluation.checks) };
  };

  it("names no public site when the site's name leads to a private address, and asks nothing of it", async () => {
    const target = transport();
    const result = await stopped(
      { resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
      target.adapter,
    );
    expect(result).toEqual({ terminal: "failed", stop: "no_public_site" });
    expect(target.paths).toEqual([]);
  });

  it("names no public site when every page redirects to a name that leads to a private address", async () => {
    const target = transport();
    const result = await stopped(
      {
        resolve: async (hostname) =>
          hostname === "intranet.example.com"
            ? [{ address: "10.0.0.7", family: 4 }]
            : publicAddress(),
      },
      {
        request: async (input) =>
          input.url.hostname === "example.com"
            ? {
                ...makeArtifact(input, 302, "", "text/html"),
                redirectLocation: `https://intranet.example.com${input.url.pathname}`,
              }
            : target.adapter.request(input),
      },
    );
    expect(result).toEqual({ terminal: "failed", stop: "no_public_site" });
    expect(target.paths).toEqual([]);
  });

  it.each([
    ["a bare IP address", "https://10.0.0.7/robots.txt"],
    ["plain HTTP from HTTPS", "http://example.com/robots.txt"],
    ["an internal name", "https://shop.internal/robots.txt"],
  ])("names a redirect it does not follow when every page redirects to %s", async (_, to) => {
    const result = await stopped(
      { resolve: publicAddress },
      {
        request: async (input) => ({
          ...makeArtifact(input, 301, "", "text/html"),
          redirectLocation: to,
        }),
      },
    );
    expect(result).toEqual({ terminal: "failed", stop: "forbidden_redirect" });
  });

  it("names no public site when the site's name does not exist", async () => {
    const result = await stopped(
      {
        resolve: async (hostname) => {
          throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
            code: "ENOTFOUND",
          });
        },
      },
      transport().adapter,
    );
    expect(result).toEqual({ terminal: "failed", stop: "no_public_site" });
  });

  it("names a secure connection the site's certificate kept from opening", async () => {
    const result = await stopped(
      { resolve: publicAddress },
      {
        request: async (input) => ({ ...makeArtifact(input, 0, "", ""), errorCode: "tls_invalid" }),
      },
    );
    expect(result).toEqual({ terminal: "failed", stop: "secure_connection_failed" });
  });

  it.each([
    ["a site that answered", () => transport().adapter],
    [
      "robots.txt keeping the scanner out, which has words of its own",
      () => transport("User-agent: *\nDisallow: /\n").adapter,
    ],
    [
      "connections the site reset, whose cause is not known",
      (): PinnedTransport => ({
        request: async (input) => ({
          ...makeArtifact(input, 0, "", ""),
          errorCode: "connection_reset",
        }),
      }),
    ],
    [
      "requests that ran out of time, which the scanner's own deadline can cause",
      (): PinnedTransport => ({
        request: async (input) => ({
          ...makeArtifact(input, 0, "", ""),
          errorCode: "fetch_timeout",
        }),
      }),
    ],
  ])("names no stop for %s", async (_, adapter) => {
    expect((await stopped({ resolve: publicAddress }, adapter())).stop).toBeNull();
  });

  it("tells a name that leads to a private address and a name that does not exist alike", async () => {
    const privateName = await stopped(
      { resolve: async () => [{ address: "172.18.0.4", family: 4 }] },
      transport().adapter,
    );
    const missingName = await stopped(
      {
        resolve: async (hostname) => {
          throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
            code: "ENOTFOUND",
          });
        },
      },
      transport().adapter,
    );
    expect(privateName.stop).not.toBeNull();
    expect(privateName).toEqual(missingName);
  });

  it("names no stop where the checks it could not assess were stopped for different reasons", async () => {
    // Every page redirects to a bare IP address but the home page, which
    // redirects to a name that finds no server.
    const result = await stopped(
      {
        resolve: async (hostname) => {
          if (hostname === "www.example.com")
            throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
          return publicAddress();
        },
      },
      {
        request: async (input) =>
          input.url.pathname === "/robots.txt"
            ? { ...makeArtifact(input, 404, "", "text/plain") }
            : input.url.hostname === "example.com" && input.url.pathname === "/"
              ? {
                  ...makeArtifact(input, 301, "", "text/html"),
                  redirectLocation: "https://www.example.com/",
                }
              : {
                  ...makeArtifact(input, 301, "", "text/html"),
                  redirectLocation: "https://10.0.0.7/",
                },
      },
    );
    expect(result).toEqual({ terminal: "failed", stop: null });
  });
});
