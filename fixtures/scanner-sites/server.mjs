import { createServer } from "node:http";
import { gzipSync } from "node:zlib";

const productJsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Fixture Widget",
  image: "https://fixture.invalid/widget.jpg",
  url: "https://fixture.invalid/product/widget",
  offers: {
    "@type": "Offer",
    price: "19.00",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
  },
});

const page = `<!doctype html><html lang="en"><head><title>Fixture Store</title><script type="application/ld+json">${productJsonLd}</script><link rel="alternate" hreflang="en" href="https://fixture.invalid/en"><link rel="alternate" hreflang="de" href="https://fixture.invalid/de"></head><body><h1>Fixture Store</h1><main>${"A deterministic product description for scanner verification. ".repeat(12)}<a href="/product/widget">Fixture Widget — $19.00 USD</a></main></body></html>`;

const robots = `User-agent: *\nAllow: /\nSitemap: https://fixture.invalid/sitemap.xml\nContent-Signal: search=yes, ai-input=yes, ai-train=no\nUser-agent: GPTBot\nAllow: /\nUser-agent: OAI-SearchBot\nAllow: /\nUser-agent: ChatGPT-User\nAllow: /\nUser-agent: ClaudeBot\nAllow: /\nUser-agent: Claude-User\nAllow: /\nUser-agent: PerplexityBot\nAllow: /\nUser-agent: Google-Extended\nAllow: /\n`;

const routes = new Map([
  ["/robots.txt", [200, "text/plain", robots]],
  [
    "/sitemap.xml",
    [
      200,
      "application/xml",
      `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://fixture.invalid/product/widget</loc><lastmod>2026-07-12</lastmod></url></urlset>`,
    ],
  ],
  [
    "/llms.txt",
    [
      200,
      "text/markdown",
      "# Fixture Store\n\n- [Products](https://fixture.invalid/products)\n",
    ],
  ],
  [
    "/.well-known/mcp.json",
    [
      200,
      "application/json",
      JSON.stringify({
        name: "Fixture MCP",
        endpoint: "https://fixture.invalid/mcp",
        transport: "streamable-http",
      }),
    ],
  ],
  ["/.well-known/mcp/server-card.json", [404, "application/json", "{}"]],
  [
    "/.well-known/ucp",
    [
      200,
      "application/json",
      JSON.stringify({
        version: "2026-01",
        endpoint: "https://fixture.invalid/ucp",
        services: { shopping: {} },
        capabilities: ["catalog"],
      }),
    ],
  ],
  [
    "/.well-known/agent-card.json",
    [
      200,
      "application/json",
      JSON.stringify({
        name: "Fixture Agent",
        version: "1",
        url: "https://fixture.invalid/a2a",
        skills: ["catalog"],
      }),
    ],
  ],
]);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture.invalid");
  if (url.pathname === "/redirect/private") {
    response
      .writeHead(302, { location: "http://169.254.169.254/latest/meta-data" })
      .end();
    return;
  }
  if (url.pathname === "/redirect/loop") {
    response.writeHead(302, { location: "/redirect/loop" }).end();
    return;
  }
  if (url.pathname === "/slow") {
    setTimeout(
      () =>
        response.writeHead(200, { "content-type": "text/plain" }).end("slow"),
      9_000,
    );
    return;
  }
  if (url.pathname === "/reset") {
    request.socket.destroy();
    return;
  }
  if (url.pathname === "/huge") {
    response
      .writeHead(200, { "content-type": "text/html" })
      .end("x".repeat(3 * 1024 * 1024));
    return;
  }
  if (url.pathname === "/compressed-bomb") {
    response
      .writeHead(200, {
        "content-type": "text/html",
        "content-encoding": "gzip",
      })
      .end(gzipSync("x".repeat(3 * 1024 * 1024)));
    return;
  }
  if (
    url.pathname === "/waf" ||
    (url.pathname === "/" &&
      /ChatGPT-User|Claude-User/.test(request.headers["user-agent"] ?? "") &&
      request.headers["x-fixture-mode"] === "waf")
  ) {
    response
      .writeHead(403, { "content-type": "text/html" })
      .end("<h1>Access denied</h1><p>captcha challenge</p>");
    return;
  }
  if (url.pathname === "/" && request.headers.accept === "text/markdown") {
    response
      .writeHead(200, { "content-type": "text/markdown", vary: "Accept" })
      .end(
        `# Fixture Store\n\n${"Machine-readable catalog information. ".repeat(20)}`,
      );
    return;
  }
  if (url.pathname === "/") {
    response
      .writeHead(200, {
        "content-type": "text/html",
        vary: "Accept",
        server: "fixture",
      })
      .end(page);
    return;
  }
  const route = routes.get(url.pathname);
  if (!route)
    response.writeHead(404, { "content-type": "text/plain" }).end("not found");
  else response.writeHead(route[0], { "content-type": route[1] }).end(route[2]);
});

const port = Number(process.env.FIXTURE_PORT ?? 4179);
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `scanner fixture listening on http://127.0.0.1:${port}\n`,
  );
});
