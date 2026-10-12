/**
 * The measurements registered in docs/research/43-one-frontend-stack.md, M1 to
 * M7, taken on the spike's screens and on today's equivalents under the same
 * conditions: Chromium driven by Playwright, 300 ms added to every request by
 * the browser's network emulation, the CPU slowed four times, the median of
 * five runs.
 *
 * It runs against a local stack built from the spike branch, never against a
 * deployed one, and it signs in with nothing of its own: the session cookie of
 * a merchant who signed in through the dashboard's one-time link is read from
 * the file named by SESSION_COOKIE_FILE, as `name=value`.
 *
 *   BASE_URL=http://localhost:8090 \
 *   SESSION_COOKIE_FILE=/path/outside/the/repository \
 *   CHROMIUM=/path/to/chrome \
 *   STACKS=spike,today \
 *     node docs/research/43-one-frontend-stack/measure.mjs > results.json
 *
 * STACKS names what is measured: `spike` is the React Router screens under
 * /dashboard/spike, `astro` the same screens in Astro under
 * /dashboard/spike-astro, and `today` today's surfaces. Astro's pages are
 * whole documents, so its navigation and its action without script are timed
 * across a page load, the way today's dashboard is.
 *
 * What each figure means is said beside it in the output, and the caveats of
 * the instruments are in the note's results.
 */

import { readFileSync } from "node:fs";
// biome-ignore lint/correctness/noUndeclaredDependencies: a measuring script kept with its note; Playwright is installed where it runs, not in the repository.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:8090";
const SPIKE = "/dashboard/spike";
const ASTRO = "/dashboard/spike-astro";
const RUNS = Number(process.env.RUNS ?? 5);
const LATENCY_MS = 300;
const CPU_SLOWDOWN = 4;
const SERVER_SAMPLES = Number(process.env.SERVER_SAMPLES ?? 40);
/**
 * How many new scans the scan action is timed over. The scanner takes ten
 * scans an hour from one address and ten a day for one site, so each sample
 * names a site of its own and there are fewer of them than of the others.
 */
const SCAN_SAMPLES = Number(process.env.SCAN_SAMPLES ?? 8);
/** A card's own pause or resume on today's card list, not the switch for all selling. */
const CARD_SWITCH =
  "form[action*='/cards/'][action$='/pause'], form[action*='/cards/'][action$='/resume']";
/** A site nobody else asks for, so a scan of it is never refused for the site's daily limit. */
const freshSite = (tag) =>
  `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.example.com`;
const [cookieName, ...cookieRest] = readFileSync(process.env.SESSION_COOKIE_FILE ?? "", "utf8")
  .trim()
  .split("=");
const COOKIE = { name: cookieName ?? "", value: cookieRest.join("=") };

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const p95 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
};
const round = (value) => Math.round(value * 10) / 10;
const summary = (values) => ({ median: round(median(values)), runs: values.map(round) });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM,
  headless: true,
});

/**
 * In every document: the moment of the last click, kept across a page load in
 * the tab's session storage, and a way to wait for a condition to become true
 * and be painted.
 */
const INIT = () => {
  document.addEventListener(
    "click",
    (event) => {
      try {
        sessionStorage.setItem("measure-click", String(performance.timeOrigin + event.timeStamp));
      } catch {}
    },
    true,
  );
  window.__painted = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve(performance.timeOrigin + performance.now());
        channel.port2.postMessage(null);
      }),
    );
  window.__when = (test) =>
    new Promise((resolve) => {
      const check = () => {
        if (!test()) return false;
        window.__painted().then(resolve);
        return true;
      };
      if (check()) return;
      const observer = new MutationObserver(() => {
        if (check()) observer.disconnect();
      });
      observer.observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    });
};

async function slowPage({ javaScript = true, signedIn = false, init = [] } = {}) {
  const context = await browser.newContext({ javaScriptEnabled: javaScript });
  if (signedIn) {
    await context.addCookies([{ ...COOKIE, url: BASE }]);
  }
  await context.addInitScript(INIT);
  for (const script of init) {
    await context.addInitScript(script);
  }
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: LATENCY_MS,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
  const scripts = new Map();
  const timings = [];
  page.on("requestfinished", async (request) => {
    const response = await request.response();
    if (response === null) return;
    const type = response.headers()["content-type"] ?? "";
    const sizes = await request.sizes().catch(() => null);
    if (type.includes("javascript") && sizes !== null && !scripts.has(request.url())) {
      scripts.set(request.url(), sizes.responseBodySize);
    }
    const serverTiming = response.headers()["server-timing"];
    if (serverTiming !== undefined) {
      timings.push({ url: request.url(), method: request.method(), serverTiming });
    }
  });
  return { context, page, scripts, timings };
}

const jsBytes = (scripts) => [...scripts.values()].reduce((sum, size) => sum + size, 0);

const clickAt = (page) =>
  page.evaluate(() => Number(sessionStorage.getItem("measure-click") ?? Number.NaN));

/** M1 and M3: a cold load of a front page, its scripts and its largest paint. */
async function frontPage(path) {
  const js = [];
  const lcp = [];
  for (let run = 0; run < RUNS; run += 1) {
    const { context, page, scripts } = await slowPage();
    await page.goto(`${BASE}${path}`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    lcp.push(
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(Number.NaN), 10_000);
            new PerformanceObserver((list) => {
              const entries = list.getEntries();
              resolve(entries[entries.length - 1]?.startTime ?? Number.NaN);
            }).observe({ type: "largest-contentful-paint", buffered: true });
          }),
      ),
    );
    js.push(jsBytes(scripts) / 1000);
    await context.close();
  }
  return { jsKB: summary(js), lcpMs: summary(lcp) };
}

/** The first order on a list page, and the first card switch on the card list. */
async function firstOrderId() {
  const answer = await fetch(`${BASE}/dashboard/spike/orders`, {
    headers: { cookie: `${COOKIE.name}=${COOKIE.value}` },
  });
  const html = await answer.text();
  const found = /href="\/dashboard\/spike\/orders\/([^"]+)"/.exec(html);
  if (found === null) throw new Error("no order on the spike's order list: seed some first");
  return decodeURIComponent(found[1]);
}

/** M2 for the spike: every script Screen B's routes load, each counted once. */
async function spikeScreenBScripts(orderId, prefix = SPIKE) {
  const js = [];
  for (let run = 0; run < RUNS; run += 1) {
    const { context, page, scripts } = await slowPage({ signedIn: true });
    await page.goto(`${BASE}${prefix}/orders`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await page.click(`a[href="${prefix}/orders/${orderId}"]`);
    await page.waitForSelector(`h1[data-order="${orderId}"]`);
    await page.waitForSelector("input[name=js]", { state: "attached" });
    await page.click(".card-switch button");
    await page.waitForLoadState("networkidle");
    await page.click(".card-switch button");
    await page.waitForLoadState("networkidle");
    await page.click("a.back");
    await page.waitForSelector("table");
    await page.waitForLoadState("networkidle");
    js.push(jsBytes(scripts) / 1000);
    await context.close();
  }
  return summary(js);
}

/** M2 for today: the orders list, the card list and a pause there. */
async function todayScreenBScripts() {
  const js = [];
  for (let run = 0; run < RUNS; run += 1) {
    const { context, page, scripts } = await slowPage({ signedIn: true });
    await page.goto(`${BASE}/dashboard/orders`, { waitUntil: "load" });
    await page.goto(`${BASE}/dashboard/cards`, { waitUntil: "load" });
    js.push(jsBytes(scripts) / 1000);
    await context.close();
  }
  return summary(js);
}

/**
 * M4 for the spike: from the click on the card switch on an order's page to
 * the first painted change, and, beside it, to the moment the server's answer
 * has been drawn. The switch is pressed back and forth, ending where it began.
 */
async function spikeAction(orderId, prefix = SPIKE) {
  const firstChange = [];
  const settled = [];
  const { context, page, timings } = await slowPage({ signedIn: true });
  await page.goto(`${BASE}${prefix}/orders/${orderId}`, { waitUntil: "load" });
  await page.waitForSelector("input[name=js]", { state: "attached" });
  await page.waitForLoadState("networkidle");
  for (let run = 0; run < RUNS + 1; run += 1) {
    const before = await page.textContent(".card-switch button");
    const changed = page.evaluate(
      (label) =>
        window.__when(() => document.querySelector(".card-switch button")?.textContent !== label),
      before,
    );
    await page.click(".card-switch button");
    const paintedAt = await changed;
    const clicked = await clickAt(page);
    await page.waitForFunction(
      () => !/…/.test(document.querySelector(".card-switch")?.textContent ?? ""),
    );
    await page.waitForLoadState("networkidle");
    const doneAt = await page.evaluate(() => performance.timeOrigin + performance.now());
    if (run < RUNS) {
      firstChange.push(paintedAt - clicked);
      settled.push(doneAt - clicked);
    }
  }
  await context.close();
  return { firstChangeMs: summary(firstChange), serverAnswerDrawnMs: summary(settled), timings };
}

/**
 * M4 for today: from the click on a card's Pause or Resume on the card list
 * to the first paint of the page the post is answered with.
 */
async function todayAction() {
  const firstChange = [];
  const { context, page } = await slowPage({ signedIn: true });
  await page.goto(`${BASE}/dashboard/cards`, { waitUntil: "load" });
  const form = page.locator(CARD_SWITCH).first();
  const action = await form.getAttribute("action");
  const cardPath = action.replace(/\/(pause|resume)$/, "");
  for (let run = 0; run < RUNS + 1; run += 1) {
    const button = page.locator(`form[action^='${cardPath}/'] button`);
    await Promise.all([page.waitForNavigation({ waitUntil: "load" }), button.click()]);
    const clicked = await clickAt(page);
    const painted = await page.evaluate(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(Number.NaN), 10_000);
          new PerformanceObserver((list) => {
            const entry = list.getEntriesByName("first-contentful-paint")[0];
            if (entry !== undefined) resolve(performance.timeOrigin + entry.startTime);
          }).observe({ type: "paint", buffered: true });
        }),
    );
    if (run < RUNS) firstChange.push(painted - clicked);
  }
  await context.close();
  return { firstChangeMs: summary(firstChange) };
}

/**
 * M5 for the spike: from a click on an order in the list to the order's own
 * heading painted, with the pointer resting on the link for 300 ms first and
 * without. A fresh, cold browser for every run.
 */
async function spikeOrderClick(orderId, rest) {
  const values = [];
  const requests = [];
  for (let run = 0; run < RUNS; run += 1) {
    const { context, page } = await slowPage({ signedIn: true });
    await page.goto(`${BASE}/dashboard/spike/orders`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    const link = `a[href="/dashboard/spike/orders/${orderId}"]`;
    const seen = [];
    page.on("request", (request) => seen.push(request.url().replace(BASE, "")));
    if (rest) {
      await page.hover(link);
      await page.waitForTimeout(300);
    }
    const shown = page.evaluate(
      (id) => window.__when(() => document.querySelector(`h1[data-order="${id}"]`) !== null),
      orderId,
    );
    await page.click(link);
    const paintedAt = await shown;
    values.push(paintedAt - (await clickAt(page)));
    requests.push(seen);
    await context.close();
  }
  return { ...summary(values), requests: requests[0] };
}

/**
 * In every document Astro's M5 opens: the moment the order's heading is first
 * in the page and has been painted, kept for the script to read once the new
 * page is up.
 */
const ORDER_SHOWN = () => {
  const record = () => {
    if (window.__orderSeen || document.querySelector("h1[data-order]") === null) return;
    window.__orderSeen = true;
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        window.__orderPaintedAt = performance.timeOrigin + performance.now();
      };
      channel.port2.postMessage(null);
    });
  };
  new MutationObserver(record).observe(document, { subtree: true, childList: true });
};

/**
 * M5 for Astro, whose order page is another document: from the click on the
 * list to the order's heading painted in the page the click opened, with the
 * pointer resting on the link for 300 ms first and without. A fresh, cold
 * browser for every run.
 */
async function astroOrderClick(orderId, rest) {
  const values = [];
  const requests = [];
  for (let run = 0; run < RUNS; run += 1) {
    const { context, page } = await slowPage({ signedIn: true, init: [ORDER_SHOWN] });
    await page.goto(`${BASE}${ASTRO}/orders`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    const link = `a[href="${ASTRO}/orders/${orderId}"]`;
    const seen = [];
    page.on("request", (request) => seen.push(request.url().replace(BASE, "")));
    if (rest) {
      await page.hover(link);
      await page.waitForTimeout(300);
    }
    await Promise.all([page.waitForURL(`**${ASTRO}/orders/${orderId}`), page.click(link)]);
    await page.waitForFunction(() => window.__orderPaintedAt !== undefined);
    const paintedAt = await page.evaluate(() => window.__orderPaintedAt);
    values.push(paintedAt - (await clickAt(page)));
    requests.push(seen);
    await context.close();
  }
  return { ...summary(values), requests: requests[0] };
}

/**
 * The script a page carries inside its own document, which M1 and M2 do not
 * count: they count the script files the browser fetched. Read once per page,
 * with no emulation, as a fact beside them.
 */
async function inlineScriptChars(path) {
  const context = await browser.newContext();
  await context.addCookies([{ ...COOKIE, url: BASE }]);
  const page = await context.newPage();
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  const chars = await page.evaluate(() =>
    [...document.querySelectorAll("script:not([src])")].reduce(
      (sum, script) => sum + (script.textContent ?? "").length,
      0,
    ),
  );
  await context.close();
  return chars;
}

/**
 * The reference beside M5 for today, which has no page for one order: a click
 * on a section of today's dashboard to the first paint of the page it opens.
 */
async function todayNavigation() {
  const values = [];
  for (let run = 0; run < RUNS; run += 1) {
    const { context, page } = await slowPage({ signedIn: true });
    await page.goto(`${BASE}/dashboard/cards`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load" }),
      page.click("nav.tabs a[href$='/orders']"),
    ]);
    const painted = await page.evaluate(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(Number.NaN), 10_000);
          new PerformanceObserver((list) => {
            const entry = list.getEntriesByName("first-contentful-paint")[0];
            if (entry !== undefined) resolve(performance.timeOrigin + entry.startTime);
          }).observe({ type: "paint", buffered: true });
        }),
    );
    values.push(painted - (await clickAt(page)));
    await context.close();
  }
  return summary(values);
}

/**
 * M6: the server's own time per route, read from `Server-Timing`, at the 95th
 * percentile; and for every route, ours and today's, the time to the first
 * byte of the answer at loopback through Caddy, which is the one figure today's
 * routes, which carry no such header, can be compared on.
 */
const SPIKE_AND_TODAY_ROUTES = (orderId) => [
  ["spike GET / (document)", "GET", "/dashboard/spike/"],
  ["spike GET /orders (document)", "GET", "/dashboard/spike/orders"],
  ["spike GET /orders (data)", "GET", "/dashboard/spike/orders.data"],
  ["spike GET /orders/:id (document)", "GET", `/dashboard/spike/orders/${orderId}`],
  ["spike GET /orders/:id (data)", "GET", `/dashboard/spike/orders/${orderId}.data`],
  ["spike POST /orders/:id (action, data)", "POST", `/dashboard/spike/orders/${orderId}.data`],
  ["spike POST / (scan action, a new scan each)", "POST", "/dashboard/spike/_root.data?index"],
  ["today GET / (Next.js)", "GET", "/"],
  ["today GET /dashboard/orders", "GET", "/dashboard/orders"],
  ["today GET /dashboard/cards", "GET", "/dashboard/cards"],
  ["today POST /dashboard/cards/:id/pause|resume", "POST", null],
];

const ASTRO_ROUTES = (orderId) => [
  ["astro GET / (document)", "GET", `${ASTRO}/`],
  ["astro GET /orders (document)", "GET", `${ASTRO}/orders`],
  ["astro GET /orders/:id (document)", "GET", `${ASTRO}/orders/${orderId}`],
  ["astro POST /orders/:id (action, background)", "POST", `${ASTRO}/orders/${orderId}`],
  ["astro POST / (scan action, a new scan each)", "POST", `${ASTRO}/`],
];

async function serverTimes(orderId, cardId, routes = SPIKE_AND_TODAY_ROUTES(orderId)) {
  const cookie = `${COOKIE.name}=${COOKIE.value}`;
  const email =
    /name="signed_in_as" value="([^"]+)"/.exec(
      await (
        await fetch(`${BASE}/dashboard/spike/orders/${orderId}`, { headers: { cookie } })
      ).text(),
    )?.[1] ?? "";
  const results = {};
  for (const [name, method, path] of routes) {
    const server = [];
    const firstByte = [];
    const samples = name.includes("scan action") ? SCAN_SAMPLES : SERVER_SAMPLES;
    const scannerTimes = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const pause = sample % 2 === 0;
      let url = `${BASE}${path}`;
      let body;
      const headers = { cookie, origin: BASE };
      if (/^(spike|astro) POST \/orders/.test(name)) {
        headers["content-type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams({
          signed_in_as: email,
          card_id: cardId,
          intent: pause ? "pause" : "resume",
          js: "1",
        }).toString();
      } else if (/^(spike|astro) POST \//.test(name)) {
        headers["content-type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams({
          url: freshSite("m6"),
          idempotency_key: crypto.randomUUID(),
        }).toString();
      } else if (name.startsWith("today POST")) {
        headers["content-type"] = "application/x-www-form-urlencoded";
        url = `${BASE}/dashboard/cards/${encodeURIComponent(cardId)}/${pause ? "pause" : "resume"}`;
        body = new URLSearchParams({ signed_in_as: email }).toString();
      }
      const started = performance.now();
      const answer = await fetch(url, { method, headers, body, redirect: "manual" });
      firstByte.push(performance.now() - started);
      await answer.arrayBuffer();
      const header = answer.headers.get("server-timing");
      const app = header === null ? null : /app;dur=([\d.]+)/.exec(header);
      if (app !== null) server.push(Number(app[1]));
      const scanner = header === null ? null : /scanner;dur=([\d.]+)/.exec(header);
      if (scanner !== null) scannerTimes.push(Number(scanner[1]));
      if (sample === 0 && !(answer.status < 400)) {
        throw new Error(`${name}: ${answer.status} ${await answer.text().catch(() => "")}`);
      }
    }
    results[name] = {
      serverTimingP95Ms: server.length === 0 ? null : round(p95(server)),
      serverTimingMedianMs: server.length === 0 ? null : round(median(server)),
      loopbackFirstByteP95Ms: round(p95(firstByte)),
      samples,
      ...(scannerTimes.length === 0
        ? {}
        : {
            scannerPartP95Ms: round(p95(scannerTimes)),
            scannerPartMedianMs: round(median(scannerTimes)),
          }),
    };
  }
  return results;
}

/** M7: with no script at all, the scan form, the navigation and the action. */
async function withoutScript(orderId) {
  const outcome = {};
  if (stacks.includes("spike")) {
    const { context, page } = await slowPage({ javaScript: false });
    await page.goto(`${BASE}/dashboard/spike/`, { waitUntil: "load" });
    await page.fill("input[name=url]", freshSite("m7"));
    await Promise.all([page.waitForNavigation(), page.click(".scan-form button")]);
    outcome["spike scan form"] = {
      landedOn: new URL(page.url()).pathname,
      works:
        /^\/scan\/[^/]+$/.test(new URL(page.url()).pathname) && !page.url().includes("/pending"),
    };
    await context.close();
  }
  if (stacks.includes("today")) {
    const { context, page } = await slowPage({ javaScript: false });
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.fill("input[name=url]", "example.com");
    await Promise.all([
      page.waitForNavigation(),
      page.locator("form button[type=submit]").first().click(),
    ]);
    outcome["today scan form"] = {
      landedOn: `${new URL(page.url()).pathname}${new URL(page.url()).search}`,
      works:
        /^\/scan\/[^/]+$/.test(new URL(page.url()).pathname) && !page.url().includes("/pending"),
    };
    await context.close();
  }
  if (stacks.includes("spike")) {
    const { context, page } = await slowPage({ javaScript: false, signedIn: true });
    await page.goto(`${BASE}/dashboard/spike/orders`, { waitUntil: "load" });
    await Promise.all([
      page.waitForNavigation(),
      page.click(`a[href="/dashboard/spike/orders/${orderId}"]`),
    ]);
    outcome["spike navigation"] = {
      works: (await page.locator(`h1[data-order="${orderId}"]`).count()) === 1,
    };
    const before = await page.textContent(".card-switch button");
    await Promise.all([page.waitForNavigation(), page.click(".card-switch button")]);
    const after = await page.textContent(".card-switch button");
    outcome["spike action"] = {
      before,
      after,
      works: before !== after,
      url: new URL(page.url()).pathname,
    };
    await Promise.all([page.waitForNavigation(), page.click(".card-switch button")]);
    await context.close();
  }
  if (stacks.includes("today")) {
    const { context, page } = await slowPage({ javaScript: false, signedIn: true });
    await page.goto(`${BASE}/dashboard/cards`, { waitUntil: "load" });
    await Promise.all([page.waitForNavigation(), page.click("nav.tabs a[href$='/orders']")]);
    outcome["today navigation"] = { works: new URL(page.url()).pathname === "/dashboard/orders" };
    await page.goto(`${BASE}/dashboard/cards`, { waitUntil: "load" });
    const form = page.locator(CARD_SWITCH).first();
    const before = await form.getAttribute("action");
    await Promise.all([page.waitForNavigation(), form.locator("button").click()]);
    const cardPath = before.replace(/\/(pause|resume)$/, "");
    const after = await page.locator(`form[action^='${cardPath}/']`).getAttribute("action");
    outcome["today action"] = { before, after, works: before !== after };
    await Promise.all([
      page.waitForNavigation(),
      page.locator(`form[action^='${cardPath}/'] button`).click(),
    ]);
    await context.close();
  }
  return outcome;
}

/** M7 for Astro: the scan form, the navigation and the action, with no script. */
async function astroWithoutScript(orderId) {
  const outcome = {};
  {
    const { context, page } = await slowPage({ javaScript: false });
    await page.goto(`${BASE}${ASTRO}/`, { waitUntil: "load" });
    await page.fill("input[name=url]", freshSite("m7"));
    await Promise.all([page.waitForNavigation(), page.click(".scan-form button")]);
    outcome["astro scan form"] = {
      landedOn: new URL(page.url()).pathname,
      works:
        /^\/scan\/[^/]+$/.test(new URL(page.url()).pathname) && !page.url().includes("/pending"),
    };
    await context.close();
  }
  {
    const { context, page } = await slowPage({ javaScript: false, signedIn: true });
    await page.goto(`${BASE}${ASTRO}/orders`, { waitUntil: "load" });
    await Promise.all([
      page.waitForNavigation(),
      page.click(`a[href="${ASTRO}/orders/${orderId}"]`),
    ]);
    outcome["astro navigation"] = {
      works: (await page.locator(`h1[data-order="${orderId}"]`).count()) === 1,
    };
    const before = await page.textContent(".card-switch button");
    await Promise.all([page.waitForNavigation(), page.click(".card-switch button")]);
    const after = await page.textContent(".card-switch button");
    outcome["astro action"] = {
      before,
      after,
      works: before !== after,
      url: new URL(page.url()).pathname,
    };
    await Promise.all([page.waitForNavigation(), page.click(".card-switch button")]);
    await context.close();
  }
  return outcome;
}

const orderId = process.env.ORDER_ID ?? (await firstOrderId());
const cardId = await (async () => {
  const html = await (
    await fetch(`${BASE}/dashboard/spike/orders/${orderId}`, {
      headers: { cookie: `${COOKIE.name}=${COOKIE.value}` },
    })
  ).text();
  return /name="card_id" value="([^"]+)"/.exec(html)?.[1] ?? "";
})();

const only = (process.env.ONLY ?? "M1,M2,M3,M4,M5,M6,M7").split(",");
const stacks = (process.env.STACKS ?? "spike,today").split(",");
const wanted = (stack, ...measures) =>
  stacks.includes(stack) && measures.some((measure) => only.includes(measure));
const results = {
  conditions: {
    base: BASE,
    runs: RUNS,
    latencyMs: LATENCY_MS,
    cpuSlowdown: CPU_SLOWDOWN,
    orderId,
    cardId,
    stacks,
  },
};
if (wanted("spike", "M1", "M3") || wanted("today", "M1", "M3") || wanted("astro", "M1", "M3")) {
  results.screenA = {};
  if (stacks.includes("spike")) results.screenA.spike = await frontPage(`${SPIKE}/`);
  if (stacks.includes("today")) results.screenA.today = await frontPage("/");
  if (stacks.includes("astro")) results.screenA.astro = await frontPage(`${ASTRO}/`);
}
if (only.includes("M2")) {
  results.M2 = {};
  if (stacks.includes("spike")) results.M2.spikeKB = await spikeScreenBScripts(orderId);
  if (stacks.includes("today")) results.M2.todayKB = await todayScreenBScripts();
  if (stacks.includes("astro")) results.M2.astroKB = await spikeScreenBScripts(orderId, ASTRO);
}
if (only.includes("M4")) {
  results.M4 = {};
  if (stacks.includes("spike")) results.M4.spike = await spikeAction(orderId);
  if (stacks.includes("today")) results.M4.today = await todayAction();
  if (stacks.includes("astro")) results.M4.astro = await spikeAction(orderId, ASTRO);
}
if (only.includes("M5")) {
  results.M5 = {};
  if (stacks.includes("spike")) {
    results.M5.spikeAfterRest = await spikeOrderClick(orderId, true);
    results.M5.spikeWithoutRest = await spikeOrderClick(orderId, false);
  }
  if (stacks.includes("today")) results.M5.todayReferenceSectionClick = await todayNavigation();
  if (stacks.includes("astro")) {
    results.M5.astroAfterRest = await astroOrderClick(orderId, true);
    results.M5.astroWithoutRest = await astroOrderClick(orderId, false);
  }
}
if (only.includes("M6")) {
  results.M6 = {};
  if (stacks.includes("spike") || stacks.includes("today")) {
    const routes = SPIKE_AND_TODAY_ROUTES(orderId).filter(([name]) =>
      stacks.includes(name.split(" ")[0]),
    );
    Object.assign(results.M6, await serverTimes(orderId, cardId, routes));
  }
  if (stacks.includes("astro")) {
    Object.assign(results.M6, await serverTimes(orderId, cardId, ASTRO_ROUTES(orderId)));
  }
}
if (only.includes("M7")) {
  results.M7 = {};
  if (stacks.includes("spike") || stacks.includes("today")) {
    Object.assign(results.M7, await withoutScript(orderId));
  }
  if (stacks.includes("astro")) Object.assign(results.M7, await astroWithoutScript(orderId));
}
if (only.includes("inline")) {
  results.inlineScriptChars = {};
  for (const [name, path] of [
    ["spike front page", `${SPIKE}/`],
    ["spike orders", `${SPIKE}/orders`],
    ["spike order", `${SPIKE}/orders/${orderId}`],
    ["astro front page", `${ASTRO}/`],
    ["astro orders", `${ASTRO}/orders`],
    ["astro order", `${ASTRO}/orders/${orderId}`],
    ["today front page", "/"],
    ["today orders", "/dashboard/orders"],
  ]) {
    results.inlineScriptChars[name] = await inlineScriptChars(path);
  }
}
await browser.close();
console.log(JSON.stringify(results, null, 2));
