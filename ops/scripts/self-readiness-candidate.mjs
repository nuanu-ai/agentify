import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

const canonicalOrigin = "https://agentify.ad";
const publicPaths = ["/", "/store", "/local", "/methodology", "/scanner", "/privacy", "/terms"];
const sitemapPaths = [...publicPaths, "/agentic-shop"];
const requiredPasses = [1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14];

const baseUrl =
  process.env.SELF_READINESS_BASE_URL ?? `http://127.0.0.1:${41_000 + (process.pid % 1_000)}`;
let server;
let serverOutput = "";

const fail = (message) => {
  throw new Error(message);
};

const safeHeaders = (headers) => {
  const output = {};
  for (const name of [
    "cache-control",
    "content-type",
    "vary",
    "server",
    "via",
    "x-powered-by",
    "x-cache",
    "www-authenticate",
    "link",
  ]) {
    const value = headers.get(name);
    if (value) output[name] = value;
  }
  return output;
};

async function fetchArtifact(path, init = {}) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    ...init,
  });
  const headersAt = performance.now();
  const body = init.method === "HEAD" ? "" : await response.text();
  const finished = performance.now();
  return {
    url: new URL(path, canonicalOrigin).toString(),
    status: response.status,
    headers: safeHeaders(response.headers),
    body,
    decodedBytes: Buffer.byteLength(body),
    truncated: false,
    durationMs: Math.round(finished - started),
    ttfbMs: Math.round(headersAt - started),
    redirectLocation: response.headers.get("location") ?? undefined,
  };
}

async function waitForServer() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // The standalone server may still be starting.
    }
    if (server?.exitCode !== null && server?.exitCode !== undefined)
      fail(`candidate server exited early (${server.exitCode})\n${serverOutput}`);
    await sleep(250);
  }
  fail(`candidate server did not become ready\n${serverOutput}`);
}

async function startServer() {
  if (process.env.SELF_READINESS_BASE_URL) return;
  const port = new URL(baseUrl).port;
  server = spawn(process.execPath, ["apps/web/.next/standalone/apps/web/server.js"], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      HOSTNAME: "127.0.0.1",
      NODE_ENV: "production",
      PORT: port,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (chunk) => {
      serverOutput = `${serverOutput}${chunk}`.slice(-20_000);
    });
  await waitForServer();
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
  await Promise.race([once(server, "exit"), sleep(5_000)]);
}

const decodeHeading = (value) =>
  value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

const headingsFromHtml = (html) =>
  [...html.matchAll(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/gi)].map((match) => decodeHeading(match[1]));

const assertHeaderToken = (artifact, header, token, label) => {
  const value = artifact.headers[header] ?? "";
  if (!value.toLowerCase().includes(token.toLowerCase()))
    fail(`${label} missing ${header}: ${token}; got ${value || "<empty>"}`);
};

async function verifyPublicVariants() {
  for (const path of publicPaths) {
    const html = await fetchArtifact(path, {
      headers: { Accept: "text/html" },
    });
    const markdown = await fetchArtifact(path, {
      headers: { Accept: "text/markdown" },
    });
    const rejectedMarkdown = await fetchArtifact(path, {
      headers: { Accept: "text/markdown;q=0, text/html" },
    });
    const head = await fetchArtifact(path, {
      method: "HEAD",
      headers: { Accept: "text/markdown" },
    });
    const rsc = await fetchArtifact(`${path}?_rsc=candidate`, {
      headers: { Accept: "text/x-component", RSC: "1" },
    });

    if (html.status !== 200 || !/text\/html/i.test(html.headers["content-type"]))
      fail(`${path} HTML variant is invalid`);
    if (
      markdown.status !== 200 ||
      !/text\/markdown/i.test(markdown.headers["content-type"]) ||
      markdown.body.length < 500
    )
      fail(`${path} Markdown variant is invalid`);
    assertHeaderToken(html, "vary", "accept", `${path} HTML`);
    assertHeaderToken(markdown, "vary", "accept", `${path} Markdown`);
    if (!/text\/html/i.test(rejectedMarkdown.headers["content-type"] ?? ""))
      fail(`${path} returned Markdown for q=0`);
    if (head.body !== "" || !/text\/markdown/i.test(head.headers["content-type"] ?? ""))
      fail(`${path} Markdown HEAD semantics are invalid`);
    if (/text\/markdown/i.test(rsc.headers["content-type"] ?? ""))
      fail(`${path} intercepted an RSC request`);

    const headings = headingsFromHtml(html.body);
    if (!headings.length) fail(`${path} HTML has no H1/H2 parity anchors`);
    for (const heading of headings) {
      if (!markdown.body.includes(heading))
        fail(`${path} Markdown is missing HTML heading: ${heading}`);
    }
  }
}

async function main() {
  await startServer();
  const { evaluateScan, parseJsonLd, parseRobots, parseSitemap } = await import(
    "../../packages/scanner/dist/index.js"
  );

  await verifyPublicVariants();

  const [robots, base, markdown, chatgpt, claude, sitemap, llms, mcpA, mcpB, a2a] =
    await Promise.all([
      fetchArtifact("/robots.txt"),
      fetchArtifact("/", { headers: { Accept: "text/html" } }),
      fetchArtifact("/", { headers: { Accept: "text/markdown" } }),
      fetchArtifact("/", {
        headers: { Accept: "text/html", "User-Agent": "ChatGPT-User/1.0" },
      }),
      fetchArtifact("/", {
        headers: { Accept: "text/html", "User-Agent": "Claude-User" },
      }),
      fetchArtifact("/sitemap.xml"),
      fetchArtifact("/llms.txt"),
      fetchArtifact("/.well-known/mcp.json"),
      fetchArtifact("/.well-known/mcp/server-card.json"),
      fetchArtifact("/.well-known/agent-card.json"),
    ]);

  const parsedRobots = parseRobots(robots.body);
  if (
    robots.status !== 200 ||
    parsedRobots.fatal ||
    parsedRobots.contentSignalMalformed ||
    parsedRobots.sitemaps[0] !== `${canonicalOrigin}/sitemap.xml`
  )
    fail("robots.txt contract failed");

  const parsedSitemap = parseSitemap(sitemap.body);
  if (
    sitemap.status !== 200 ||
    !parsedSitemap.valid ||
    parsedSitemap.urls.length !== sitemapPaths.length ||
    parsedSitemap.urls.some((url, index) => url !== `${canonicalOrigin}${sitemapPaths[index]}`)
  )
    fail("sitemap.xml contract failed");

  if (!/^# Agentify$/m.test(llms.body) || !/\[[^\]]+\]\(https:\/\//.test(llms.body))
    fail("llms.txt contract failed");

  const jsonLd = parseJsonLd(base.body);
  if (!jsonLd.nodes.some((node) => node["@type"] === "Organization"))
    fail("front page is missing Organization JSON-LD");
  for (const path of ["/data-request", "/email/unsubscribe"]) {
    const privatePage = await fetchArtifact(path);
    if (parseJsonLd(privatePage.body).scriptCount !== 0)
      fail(`${path} leaked public marketing JSON-LD`);
  }

  const evaluation = evaluateScan({
    segment: "owner",
    canonicalTargetUrl: `${canonicalOrigin}/`,
    robots,
    base,
    markdown,
    agentProbes: { chatgpt, claude },
    sitemap: [sitemap],
    llms,
    mcp: [mcpA, mcpB],
    oauth: [],
    a2a,
  });
  const checks = new Map(evaluation.checks.map((check) => [check.id, check]));
  for (const id of requiredPasses) {
    if (checks.get(id)?.status !== "pass")
      fail(`required check #${id} is ${checks.get(id)?.status ?? "missing"}`);
  }
  if (checks.get(9)?.status !== "fail")
    fail(`MCP check #9 must remain an honest fail, got ${checks.get(9)?.status}`);
  if (evaluation.score.score === null || evaluation.score.score < 90)
    fail(`candidate score ${evaluation.score.score} is below 90`);
  if (evaluation.score.coverage !== 1)
    fail(`candidate coverage ${evaluation.score.coverage} is not 1.0`);

  // The owner landing became the front page (docs/research/31-user-journey.md
  // §2). Its old address answers with a redirect that no cache may keep: a
  // browser holding a cached redirect in either direction would loop.
  const ownerAlias = await fetchArtifact("/owner");
  if (
    ownerAlias.status !== 308 ||
    new URL(ownerAlias.redirectLocation ?? "", baseUrl).pathname !== "/" ||
    !/no-store/i.test(ownerAlias.headers["cache-control"] ?? "")
  )
    fail(
      `/owner redirect is ${ownerAlias.status} ${ownerAlias.redirectLocation ?? "<none>"} (${ownerAlias.headers["cache-control"] ?? "no cache-control"})`,
    );

  console.log(
    JSON.stringify({
      status: "passed",
      score: evaluation.score.score,
      coverage: evaluation.score.coverage,
      earnedWeight: evaluation.score.earnedWeight,
      applicableWeight: evaluation.score.applicableWeight,
      requiredChecks: Object.fromEntries(
        [...requiredPasses, 9].map((id) => [id, checks.get(id)?.status]),
      ),
    }),
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
} finally {
  await stopServer();
}
