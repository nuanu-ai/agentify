/**
 * The measurements registered in docs/research/47-one-docs-stack.md, taken on
 * two built documentations: A, the React Router prototype, and B, today's
 * VitePress portal. Each is served by `serve.mjs` beside this file, which
 * answers as Caddy's `/docs` block does.
 *
 *   node docs/research/47-one-docs-stack/measure.mjs builds > results/builds.json
 *   A_URL=http://127.0.0.1:4747 B_URL=http://127.0.0.1:4748 \
 *     node docs/research/47-one-docs-stack/measure.mjs browser > results/browser.json
 *
 * `builds` is M4: three clean builds of each, build output and caches
 * removed first. It rewrites both build directories, so it runs before the
 * servers are started. `browser` is everything else, in Chromium from the
 * repository's Playwright: the sizes of a first visit (M1 to M3, M5), the
 * search (M6, M7), the content parity (M8), moving between pages (M10) and
 * the first visit's paint (M11), and the checks of the channel's notice.
 * What each figure means is said beside it in the output.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Playwright is the prototype's, at the version whose Chromium the repository installs. */
const { chromium } = createRequire(join(ROOT, "apps/docs-rr/package.json"))("playwright");
const HERE = fileURLToPath(new URL("./", import.meta.url));
const A_DIR = join(ROOT, "apps/docs-rr/dist/client");
const B_DIR = join(ROOT, "apps/docs/.vitepress/dist");
const SHARED = join(ROOT, "packages/visual/public");
const RUNS = Number(process.env.RUNS ?? 5);
const LATENCY_MS = 200;

const SITES = {
  A: { url: process.env.A_URL ?? "http://127.0.0.1:4747", dir: A_DIR },
  B: { url: process.env.B_URL ?? "http://127.0.0.1:4748", dir: B_DIR },
};

/** The seven merchant pages both sites have, and the two scanner pages only A has. */
const PORTAL_PAGES = ["/", "/money", "/faq", "/quickstart", "/cards", "/orders", "/failures"];
const SCANNER_PAGES = ["/scanner", "/scanner/methodology"];
const SOURCE = {
  "/": "apps/docs/index.md",
  "/money": "apps/docs/money.md",
  "/faq": "apps/docs/faq.md",
  "/quickstart": "apps/docs/quickstart.md",
  "/cards": "apps/docs/cards.md",
  "/orders": "apps/docs/orders.md",
  "/failures": "apps/docs/failures.md",
};

const QUERIES = [
  ["metamask", "/money"],
  ["restaurant", "/faq"],
  ["tracking number", "/orders"],
  ["refusal codes", "/cards"],
  ["handler crashed", "/failures"],
  ["createClient", "/quickstart"],
  ["change wallet two days", "/"],
  ["several instances", "/orders"],
  ["network fee", "/money"],
  ["who settles a dispute", "/faq"],
];
const SCANNER_QUERIES = [
  ["robots.txt", "/scanner"],
  ["coverage score", "/scanner/methodology"],
];

/** The negative control: a query no page answers, which must not hit. */
const CONTROL_QUERY = ["qzxv wqpj", "/money"];

/** The two moves M10 times, each by the sidebar's link to the destination. */
const MOVES = [
  { from: "/", to: "/quickstart", title: "The first test sale" },
  { from: "/money", to: "/orders", title: "Orders and fulfillment modes" },
];

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round = (value) => Math.round(value * 10) / 10;
const brotli = (buffer) =>
  brotliCompressSync(buffer, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      [constants.BROTLI_PARAM_SIZE_HINT]: buffer.length,
    },
  }).length;
const kb = (bytes) => round(bytes / 1024);

/** The file a request under `/docs/` was answered from, tried as the server tries it. */
function fileOf(site, url) {
  const { pathname } = new URL(url);
  if (pathname.startsWith("/styles/") || pathname.startsWith("/assets/agentify-mark")) {
    return join(SHARED, pathname);
  }
  const inside = decodeURIComponent(pathname.replace(/^\/docs/, ""));
  for (const candidate of [inside, `${inside}.html`, join(inside, "index.html")]) {
    const path = join(site.dir, candidate);
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

const kindOf = (url) => {
  const { pathname } = new URL(url);
  if (pathname.endsWith(".js")) return "js";
  if (pathname.endsWith(".css")) return "css";
  if (pathname.endsWith(".woff2")) return "font";
  if (pathname.endsWith(".data") || pathname.endsWith(".json")) return "data";
  if (pathname.endsWith(".svg")) return "image";
  return "html";
};

const pagePath = (page) => (page === "/" ? "/docs/" : `/docs${page}`);

async function withLatency(context, page) {
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: LATENCY_MS,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
}

/** M1 to M3: what a cold load of one page requests, with no input, until the network rests. */
async function firstVisit(browser, site, page) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const tab = await context.newPage();
  const requested = [];
  tab.on("request", (request) => {
    requested.push({
      url: request.url(),
      prefetch: request.headers()["sec-purpose"]?.includes("prefetch") ?? false,
    });
  });
  await tab.goto(site.url + pagePath(page), { waitUntil: "networkidle" });
  await tab.waitForTimeout(2000);
  await tab.waitForLoadState("networkidle");
  await context.close();

  const seen = new Set();
  const totals = { js: 0, jsPrefetched: 0, css: 0, data: 0, font: 0, image: 0, html: 0 };
  const raw = { html: 0 };
  const files = [];
  for (const { url, prefetch } of requested) {
    const key = `${url.split("?")[0]}|${prefetch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const path = fileOf(site, url);
    if (path === null) continue;
    const body = readFileSync(path);
    const size = brotli(body);
    const kind = kindOf(url);
    if (kind === "js" && prefetch) totals.jsPrefetched += size;
    else totals[kind] += size;
    if (kind === "html") raw.html += body.length;
    files.push({ file: path.replace(ROOT, ""), kind, prefetch, brotli: size });
  }
  return {
    page,
    jsKB: kb(totals.js + totals.jsPrefetched),
    jsWithoutPrefetchKB: kb(totals.js),
    cssKB: kb(totals.css),
    htmlKB: kb(totals.html),
    htmlRawKB: kb(raw.html),
    totalKB: kb(totals.html + totals.js + totals.jsPrefetched + totals.css),
    prefetchedDataKB: kb(totals.data),
    fontKB: kb(totals.font),
    files,
  };
}

/** The search box of each site, opened, and what opening it fetched. */
const SEARCH = {
  A: {
    open: (tab) => tab.click(".docs-search-button"),
    input: ".search-panel input",
    results: ".search-results a",
  },
  B: {
    open: (tab) => tab.click("button.DocSearch-Button"),
    input: "#localsearch-input",
    results: "ul.results a",
  },
};

/** M6 and M7. */
async function search(browser, name, site, queries) {
  const box = SEARCH[name];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const tab = await context.newPage();
  await tab.goto(`${site.url}/docs/`, { waitUntil: "networkidle" });
  await tab.waitForTimeout(2000);
  await tab.waitForLoadState("networkidle");
  const opened = [];
  tab.on("request", (request) => opened.push(request.url()));
  await box.open(tab);
  await tab.waitForSelector(box.input);
  await tab.waitForLoadState("networkidle");
  const fetched = [...new Set(opened.map((url) => url.split("?")[0]))]
    .map((url) => ({ url, path: fileOf(site, url) }))
    .filter(({ path }) => path !== null)
    .map(({ url, path }) => ({
      file: path.replace(ROOT, ""),
      url,
      brotli: brotli(readFileSync(path)),
    }));
  const isIndex = (file) => /search-index\.json$|localSearchIndex/.test(file.file);
  const answers = [];
  for (const [query, right] of queries) {
    await tab.fill(box.input, "");
    await tab.fill(box.input, query);
    await tab.waitForTimeout(700);
    const hrefs = await tab.$$eval(box.results, (links) =>
      links.slice(0, 3).map((link) => link.getAttribute("href")),
    );
    const want = pagePath(right);
    const hit = hrefs.some((href) => (href ?? "").split("#")[0] === want);
    answers.push({ query, right: want, firstThree: hrefs, hit });
  }
  await context.close();
  return {
    indexKB: kb(fetched.filter(isIndex).reduce((sum, file) => sum + file.brotli, 0)),
    codeKB: kb(
      fetched
        .filter((file) => !isIndex(file) && file.file.endsWith(".js"))
        .reduce((sum, file) => sum + file.brotli, 0),
    ),
    fetchedOnOpening: fetched.map(({ file, brotli: size }) => ({ file, brotliKB: kb(size) })),
    hits: answers.filter((answer) => answer.hit).length,
    answers,
  };
}

/** What M8 compares, read out of one page's content area in a tab with no network. */
function contentOf(selector) {
  const root = document.querySelector(selector);
  if (root === null) return null;
  const text = (node) => (node.textContent ?? "").replace(/​/g, "").replace(/\s+/g, " ").trim();
  const headingText = (heading) => {
    const copy = heading.cloneNode(true);
    for (const anchor of copy.querySelectorAll(".header-anchor")) anchor.remove();
    return text(copy);
  };
  return {
    headings: [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")].map(
      (heading) => `${heading.tagName.toLowerCase()} #${heading.id} ${headingText(heading)}`,
    ),
    tables: [...root.querySelectorAll("table")].map((table) =>
      [...table.querySelectorAll("tr")]
        .map((row) => [...row.children].map(text).join(" | "))
        .join("\n"),
    ),
    code: [...root.querySelectorAll("pre")].map(text),
    diagrams: root.querySelectorAll(".mermaid, figure.diagram > svg").length,
    links: [...root.querySelectorAll("a[href]")].map((link) => link.getAttribute("href")),
    prose: [...root.querySelectorAll("p, li")].map(text),
    whole: text(root),
  };
}

/** Items of `wanted` missing from `got`, counted as a multiset. */
const missingFrom = (wanted, got) => {
  const left = [...got];
  const missing = [];
  for (const item of wanted) {
    const at = left.indexOf(item);
    if (at === -1) missing.push(item);
    else left.splice(at, 1);
  }
  return missing;
};

/** The paths a page includes with `<<<`, as `check-portal-render.mjs` reads them. */
const includesOf = (markdown) =>
  markdown
    .split("\n")
    .map((line) => /^<<<\s+(\S+)/.exec(line.trim())?.[1])
    .filter((path) => path !== undefined)
    .map((path) => path.replace(/[#{].*$/, "").replace(/^@\//, ""));

async function parity(browser) {
  const context = await browser.newContext();
  await context.route("**/*", (route) => route.abort());
  const tab = await context.newPage();
  const read = async (html, selector) => {
    await tab.setContent(html, { waitUntil: "domcontentloaded" });
    return tab.evaluate(contentOf, selector);
  };
  const pages = [];
  for (const page of PORTAL_PAGES) {
    const b = await read(
      readFileSync(fileOf(SITES.B, SITES.B.url + pagePath(page)), "utf8"),
      ".vp-doc > div",
    );
    const a = await read(
      readFileSync(fileOf(SITES.A, SITES.A.url + pagePath(page)), "utf8"),
      ".doc",
    );
    const markdown = readFileSync(join(ROOT, SOURCE[page]), "utf8");
    const examples = includesOf(markdown).map((path) => {
      const wanted = readFileSync(join(ROOT, "apps/docs", path), "utf8")
        .replace(/\s+/g, " ")
        .trim();
      return { path, inA: a.whole.includes(wanted), inB: b.whole.includes(wanted) };
    });
    const differences = {
      headings: missingFrom(b.headings, a.headings),
      tables: missingFrom(b.tables, a.tables),
      code: missingFrom(b.code, a.code),
      examples: examples.filter((example) => !example.inA).map((example) => example.path),
      diagrams: b.diagrams === a.diagrams ? [] : [`B ${b.diagrams}, A ${a.diagrams}`],
      links: missingFrom(b.links, a.links),
    };
    pages.push({
      page,
      counts: {
        headings: [b.headings.length, a.headings.length],
        tables: [b.tables.length, a.tables.length],
        code: [b.code.length, a.code.length],
        examples: [examples.filter((e) => e.inB).length, examples.filter((e) => e.inA).length],
        diagrams: [b.diagrams, a.diagrams],
        links: [b.links.length, a.links.length],
      },
      differences,
      differenceCount: Object.values(differences).reduce((sum, list) => sum + list.length, 0),
      // Not registered: paragraphs and list items of B absent from A, and the reverse.
      proseOnlyInB: missingFrom(b.prose, a.prose),
      proseOnlyInA: missingFrom(a.prose, b.prose),
    });
  }

  // The negative control: two different pages compared the same way must differ, or a
  // comparison that sees nothing would pass every page.
  {
    const b = await read(
      readFileSync(fileOf(SITES.B, `${SITES.B.url}/docs/money`), "utf8"),
      ".vp-doc > div",
    );
    const a = await read(readFileSync(fileOf(SITES.A, `${SITES.A.url}/docs/faq`), "utf8"), ".doc");
    pages.push({
      page: "control: B's Money against A's Common questions",
      differenceCount:
        missingFrom(b.headings, a.headings).length + missingFrom(b.links, a.links).length,
    });
  }

  // The scanner's two pages against the scanner's own text, drawn with the live channel's values.
  const scanner = JSON.parse(readFileSync(join(HERE, "results/scanner-pages.json"), "utf8"));
  const flat = (content) =>
    (typeof content === "string" ? content : content.map((node) => node.value).join(""))
      .replace(/\s+/g, " ")
      .trim();
  for (const model of scanner) {
    const page = model.path === "/scanner" ? "/scanner" : "/scanner/methodology";
    const a = await read(
      readFileSync(fileOf(SITES.A, SITES.A.url + pagePath(page)), "utf8"),
      ".doc",
    );
    const wanted = [`h1 # ${model.title}`, model.intro];
    for (const section of model.sections) {
      wanted.push(`h2 #${section.id} ${section.title}`);
      for (const block of section.blocks) {
        if (block.kind === "list") wanted.push(...block.items.map(flat));
        else wanted.push(flat(block.content));
      }
    }
    const got = [...a.headings.map((h) => h.replace(/^h1 #\S+ /, "h1 # ")), ...a.prose, a.whole];
    const missing = wanted.filter(
      (item) => !got.some((have) => have === item || have.includes(item)),
    );
    pages.push({ page, differences: { scannerText: missing }, differenceCount: missing.length });
  }
  {
    const a = await read(
      readFileSync(fileOf(SITES.A, `${SITES.A.url}/docs/scanner`), "utf8"),
      ".doc",
    );
    const methodology = scanner.find((model) => model.path === "/methodology");
    const wanted = methodology.sections.map((section) => `h2 #${section.id} ${section.title}`);
    pages.push({
      page: "control: the methodology's text against the scanner identity page",
      differenceCount: wanted.filter((item) => !a.headings.includes(item)).length,
    });
  }
  await context.close();
  return pages;
}

/** Records, in every document of a tab, the click and the moment the expected heading is painted. */
const TIMING_SCRIPT = () => {
  const now = () => performance.timeOrigin + performance.now();
  window.addEventListener(
    "click",
    (event) => sessionStorage.setItem("clicked", String(performance.timeOrigin + event.timeStamp)),
    true,
  );
  const watch = () => {
    const expected = sessionStorage.getItem("expect");
    if (expected === null || sessionStorage.getItem("seen") !== null) return;
    const heading = document.querySelector("h1");
    const words = (heading?.textContent ?? "").replace(/​/g, "").trim();
    if (words === expected) {
      requestAnimationFrame(() =>
        setTimeout(() => {
          if (sessionStorage.getItem("seen") === null)
            sessionStorage.setItem("seen", String(now()));
        }, 0),
      );
    }
  };
  new MutationObserver(watch).observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
  });
};

const SIDEBAR = { A: ".docs-contents-wide", B: ".VPSidebar" };

/** M10: one move, timed from the click to the destination's heading on screen. */
async function move(browser, name, site, { from, to, title }, rest) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(TIMING_SCRIPT);
  const tab = await context.newPage();
  await withLatency(context, tab);
  await tab.goto(site.url + pagePath(from), { waitUntil: "load" });
  await tab.waitForTimeout(2000);
  await tab.evaluate((expected) => {
    sessionStorage.removeItem("seen");
    sessionStorage.removeItem("clicked");
    sessionStorage.setItem("expect", expected);
  }, title);
  const link = tab.locator(`${SIDEBAR[name]} a[href="${pagePath(to)}"]`).first();
  if (rest) {
    await link.hover();
    await tab.waitForTimeout(300);
  }
  await link.click();
  let elapsed = null;
  for (let tries = 0; tries < 100 && elapsed === null; tries += 1) {
    await tab.waitForTimeout(50);
    elapsed = await tab
      .evaluate(() => {
        const seen = sessionStorage.getItem("seen");
        const clicked = sessionStorage.getItem("clicked");
        return seen === null || clicked === null ? null : Number(seen) - Number(clicked);
      })
      .catch(() => null);
  }
  await context.close();
  return elapsed;
}

/** M11: the largest contentful paint of a cold load. */
async function paint(browser, site, page) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const tab = await context.newPage();
  await withLatency(context, tab);
  await tab.goto(site.url + pagePath(page), { waitUntil: "load" });
  await tab.waitForLoadState("networkidle");
  const timing = await tab.evaluate(
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ lcp: null, fcp: null }), 5000);
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          resolve({
            lcp: entries.at(-1)?.startTime ?? null,
            fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
          });
        }).observe({ type: "largest-contentful-paint", buffered: true });
      }),
  );
  await context.close();
  return timing;
}

/** The notice under the header, as each channel fills it, on load and after a move. */
async function notices(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const tab = await context.newPage();
  const errors = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.goto(`${url}/docs/`, { waitUntil: "networkidle" });
  const read = () =>
    tab.evaluate(() => ({
      marker: document
        .querySelector("[data-agentify-surface]")
        ?.getAttribute("data-agentify-surface"),
      words: [...document.querySelectorAll(".surface-words")].map((p) =>
        p.textContent?.slice(0, 40),
      ),
    }));
  const onLoad = await read();
  await tab.click('.docs-contents-wide a[href="/docs/money"]');
  await tab.waitForTimeout(800);
  const afterMove = await read();
  await context.close();
  return { onLoad, afterMove, errors };
}

async function browserMeasures() {
  const browser = await chromium.launch();
  const out = { taken: new Date().toISOString(), latencyMs: LATENCY_MS, runs: RUNS };

  out.sizes = {};
  for (const [name, site] of Object.entries(SITES)) {
    const pages = name === "A" ? [...PORTAL_PAGES, ...SCANNER_PAGES] : PORTAL_PAGES;
    out.sizes[name] = [];
    for (const page of pages) out.sizes[name].push(await firstVisit(browser, site, page));
  }

  const ordersHtml = readFileSync(join(A_DIR, "orders/index.html"), "utf8");
  const content = ordersHtml.slice(0, ordersHtml.indexOf("<script"));
  const fences = (readFileSync(join(ROOT, SOURCE["/orders"]), "utf8").match(/^```mermaid/gm) ?? [])
    .length;
  const jsOf = (name, page) => out.sizes[name].find((each) => each.page === page).jsKB;
  const lightest = (name) => Math.min(...PORTAL_PAGES.map((page) => jsOf(name, page)));
  out.diagrams = {
    fences,
    inlineSvgInA: (content.match(/<figure class="diagram"><svg/g) ?? []).length,
    ordersJsBeyondLightestKB: {
      A: round(jsOf("A", "/orders") - lightest("A")),
      B: round(jsOf("B", "/orders") - lightest("B")),
    },
  };

  out.search = {
    A: await search(browser, "A", SITES.A, [...QUERIES, ...SCANNER_QUERIES, CONTROL_QUERY]),
    B: await search(browser, "B", SITES.B, [...QUERIES, CONTROL_QUERY]),
  };

  out.parity = await parity(browser);

  out.moves = {};
  for (const [name, site] of Object.entries(SITES)) {
    out.moves[name] = [];
    for (const each of MOVES) {
      for (const rest of [true, false]) {
        const samples = [];
        for (let run = 0; run < RUNS; run += 1)
          samples.push(await move(browser, name, site, each, rest));
        const timed = samples.filter((sample) => sample !== null);
        out.moves[name].push({
          from: each.from,
          to: each.to,
          rest: rest ? "after a 300 ms rest" : "at once",
          medianMs: timed.length > 0 ? round(median(timed)) : null,
          samples: samples.map((sample) => (sample === null ? null : round(sample))),
        });
      }
    }
  }

  out.paint = {};
  for (const [name, site] of Object.entries(SITES)) {
    out.paint[name] = [];
    for (const page of PORTAL_PAGES) {
      const samples = [];
      for (let run = 0; run < RUNS; run += 1) samples.push(await paint(browser, site, page));
      out.paint[name].push({
        page,
        lcpMs: round(median(samples.map((sample) => sample.lcp))),
        fcpMs: round(median(samples.map((sample) => sample.fcp))),
      });
    }
  }

  if (process.env.A_LIVE_URL !== undefined) {
    out.notices = {
      test: await notices(browser, SITES.A.url),
      live: await notices(browser, process.env.A_LIVE_URL),
    };
  }

  await browser.close();
  return out;
}

/** M4: three clean builds of each, timed by the wall clock. */
function builds() {
  const timed = (command, args, cwd) => {
    const started = performance.now();
    const output = execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
    return { ms: performance.now() - started, output };
  };
  const clean = (paths) => {
    for (const path of paths) rmSync(join(ROOT, path), { recursive: true, force: true });
  };
  const out = { taken: new Date().toISOString(), A: [], B: [], Awarm: [] };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    clean(["apps/docs/.vitepress/dist", "apps/docs/.vitepress/cache"]);
    out.B.push(
      round(
        timed("pnpm", ["exec", "vitepress", "build", "--base", "/docs/"], join(ROOT, "apps/docs"))
          .ms,
      ),
    );
    clean([
      "apps/docs-rr/dist",
      "apps/docs-rr/.react-router",
      "apps/docs-rr/node_modules/.cache",
      "apps/docs-rr/node_modules/.vite",
    ]);
    const cold = timed("pnpm", ["build"], join(ROOT, "apps/docs-rr"));
    out.A.push({
      ms: round(cold.ms),
      diagrams: /drew (\d+) diagrams in (\d+) ms/.exec(cold.output)?.slice(1).map(Number) ?? null,
    });
    clean(["apps/docs-rr/dist"]);
    out.Awarm.push(round(timed("pnpm", ["build"], join(ROOT, "apps/docs-rr")).ms));
  }
  out.medianMs = {
    A: median(out.A.map((each) => each.ms)),
    B: median(out.B),
    AwithDiagramsAlreadyDrawn: median(out.Awarm),
  };
  return out;
}

const command = process.argv[2];
if (command === "builds") console.log(JSON.stringify(builds(), null, 1));
else if (command === "browser") console.log(JSON.stringify(await browserMeasures(), null, 1));
else throw new Error("say `builds` or `browser`");
