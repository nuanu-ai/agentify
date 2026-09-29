import { createSocket } from "node:dgram";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  BROWSER_OBSERVATION_VERSION,
  type BrowserObservationOutputV1,
} from "@agentify/scanner-contracts";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

import { collectPageSignals } from "./browser-signals.js";
import { type FetchResource, runBrowserObservation } from "./runner.js";
import {
  BLOCKED_ACTIVE_NETWORK_GLOBALS,
  installPassiveRuntimeGuards,
  PASSIVE_BROWSER_ARGS,
} from "./runtime-guards.js";

const chromeExecutable = (): string | undefined => {
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return process.platform === "darwin" && existsSync(macChrome) ? macChrome : undefined;
};

describe("real Chromium aggregate extraction", () => {
  it("observes JS, ARIA, forms, WebMCP and hidden instructions without returning raw content", async () => {
    const html = await readFile(
      new URL("../fixtures/js-observation.html", import.meta.url),
      "utf8",
    );
    const browser = await chromium.launch({
      headless: true,
      args: [...PASSIVE_BROWSER_ARGS],
      executablePath: chromeExecutable(),
    });
    try {
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      await installPassiveRuntimeGuards(context);
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: "load" });
      const signals = await collectPageSignals({
        page,
        rawHtml: html,
        rawUrl: "https://fixture.agentify.ad/",
        timeoutMs: 5_000,
      });
      expect(signals.renderedTextChars).toBeGreaterThan(20);
      expect(signals.rawTextChars).toBeLessThan(signals.renderedTextChars);
      expect(signals.landmarkCounts.main).toBe(1);
      expect(signals.headingLevelCounts.h1).toBe(1);
      expect(signals.formControlCount).toBe(2);
      expect(signals.unlabeledFormControlCount).toBe(0);
      expect(signals.webmcpPresent).toBe(true);
      expect(signals.webmcpToolCount).toBe(1);
      expect(signals.hiddenInstructionCount).toBeGreaterThan(0);
      expect(signals.rawMetadata.canonical).toBe("https://fixture.agentify.ad/before-render");
      expect(signals.renderedMetadata.canonical).toBe("https://fixture.agentify.ad/after-render");
      expect(JSON.stringify(signals)).not.toContain("Ignore previous instructions");
      await context.close();
    } finally {
      await browser.close();
    }
  }, 20_000);

  it("removes active network globals in the main document and iframe without emitting UDP", async () => {
    const udp = createSocket("udp4");
    let udpPackets = 0;
    udp.on("message", () => {
      udpPackets += 1;
    });
    await new Promise<void>((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(0, "127.0.0.1", () => resolve());
    });
    const address = udp.address();
    const browser = await chromium.launch({
      headless: true,
      args: [...PASSIVE_BROWSER_ARGS],
      executablePath: chromeExecutable(),
    });
    try {
      const context = await browser.newContext({ serviceWorkers: "block" });
      await installPassiveRuntimeGuards(context);
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.setContent(
        `<!doctype html><body>
        <script>
          const blocked = ${JSON.stringify(BLOCKED_ACTIVE_NETWORK_GLOBALS)};
          const snapshot = () => Object.fromEntries(blocked.map((name) => [
            name,
            { type: typeof globalThis[name], present: name in globalThis },
          ]));
          globalThis.__mainSnapshot = snapshot();
          try {
            const peer = new RTCPeerConnection({
              iceServers: [{ urls: "stun:127.0.0.1:${address.port}" }],
            });
            peer.createDataChannel("probe");
            peer.createOffer().then((offer) => peer.setLocalDescription(offer));
          } catch {}
          const frame = document.createElement("iframe");
          frame.srcdoc = "<!doctype html><p>frame-ready</p>";
          document.body.append(frame);
        </script></body>`,
        { waitUntil: "domcontentloaded", timeout: 5_000 },
      );
      expect(await page.locator("iframe").count(), pageErrors.join("\n")).toBe(1);
      const childFrame = page.frames().find((frame) => frame !== page.mainFrame());
      if (!childFrame) throw new Error("the fixture page opened no child frame");
      const main = await page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __mainSnapshot: Record<string, { type: string; present: boolean }>;
            }
          ).__mainSnapshot,
      );
      const frame = await childFrame.evaluate(
        (blocked) => {
          const scope = globalThis as unknown as Record<string, unknown>;
          return Object.fromEntries(
            blocked.map((name) => [
              name,
              { type: typeof scope[name], present: name in globalThis },
            ]),
          );
        },
        [...BLOCKED_ACTIVE_NETWORK_GLOBALS],
      );
      await new Promise((resolve) => setTimeout(resolve, 750));
      for (const name of BLOCKED_ACTIVE_NETWORK_GLOBALS) {
        expect(main[name]).toEqual({
          type: "undefined",
          present: false,
        });
        expect(frame[name]).toEqual({
          type: "undefined",
          present: false,
        });
      }
      expect(udpPackets).toBe(0);
      await context.close();
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => udp.close(() => resolve()));
    }
  }, 20_000);
});

type Resource = Parameters<FetchResource>[0];
type Answer = Awaited<ReturnType<FetchResource>>;

const htmlPage = (markup: string): Answer => {
  const body = Buffer.from(markup, "utf8");
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body,
    decodedBytes: body.length,
  };
};

const NOT_FOUND: Answer = { status: 404, headers: {}, body: Buffer.alloc(0), decodedBytes: 0 };

/**
 * A whole run of the observer, in a real Chromium, against a site served from
 * this process: each path answers with its page or its handler, and every
 * other path, robots.txt among them, is not found. The pages are named by
 * path on www.example.com, the first one the target.
 */
const observeSite = async (
  pages: Record<string, string | ((resource: Resource) => Promise<Answer>)>,
  paths: readonly string[],
  limits: { page_timeout_ms?: number; run_timeout_ms?: number } = {},
) => {
  const [target, ...representatives] = paths.map((path) => `https://www.example.com${path}`);
  return await runBrowserObservation({
    actorBuild: "integration",
    fetchResource: async (resource) => {
      const page = pages[resource.url.pathname];
      if (page === undefined) return NOT_FOUND;
      return typeof page === "string" ? htmlPage(page) : await page(resource);
    },
    input: {
      schema_version: BROWSER_OBSERVATION_VERSION,
      operation_id: "019f5d64-1234-7abc-8abc-1234567890ab",
      target: { canonical_url: target, registrable_domain: "example.com", segment: "owner" },
      representative_urls: representatives,
      policy: {
        user_agent: "agentify-browser-observer/1.0 (+https://agentify.ad/scanner)",
        methods: ["GET", "HEAD"],
        use_proxy: false,
        respect_robots: true,
        crawl_purpose: "search",
      },
      limits: {
        max_pages: paths.length,
        max_requests_per_page: 20,
        max_total_bytes: 1_000_000,
        page_timeout_ms: 5_000,
        run_timeout_ms: 30_000,
        ...limits,
      },
    },
  });
};

const networkEvidence = (output: BrowserObservationOutputV1) =>
  output.observations.find((finding) => finding.id === "browser_network_health")?.evidence;

describe("a real Chromium run against a served site", () => {
  it("blocks a window the page opens and finishes the run", async () => {
    const output = await observeSite(
      {
        "/": `<!doctype html><title>Linen shirt</title><main><h1>Linen shirt</h1><p>Relaxed fit.</p></main>
          <script>window.open("/newsletter");</script>`,
        "/newsletter": "<!doctype html><title>Newsletter</title><p>Sign up</p>",
      },
      ["/"],
    );
    expect(output.status).toBe("completed");
    expect(output.pages_assessed).toBe(1);
    expect(networkEvidence(output)).toMatchObject({ blocked_destination_count: 1 });
  }, 30_000);
});
