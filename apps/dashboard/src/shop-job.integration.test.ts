/** Native proof of the stored projection's observers; the shop replies stay local. */
import { readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { memoryOperatorReader } from "@agentify/gateway/operator";
import { harness } from "@agentify/gateway/testing";
import { firstVisitScripts, type ViteManifest } from "@agentify/ui/budget";
import { launchChromium } from "@agentify/ui/chromium";
import type { Page } from "playwright";
import type { ServerBuild } from "react-router";
import { expect, it, vi } from "vitest";
import { memoryJournal } from "./admin/journal.js";
import { loadConfig } from "./config.js";
import { gatewayFor } from "./gateway.js";
import { identityFor } from "./identity.js";
import type { Message } from "./mail.js";
import { builtPages } from "./pages.js";
import { SCRIPT_BUDGET } from "./script-budget.js";
import { buildApp } from "./server.js";
import { shopPublisherFor, startShopJobs } from "./shop-job-runner.js";
import { flagRow } from "./testing/account-rows.js";
import { ONE_CLIENT, rewindLinkSends } from "./testing/link-sends.js";
import { TEST_AUTH_SECRET } from "./testing/secrets.js";
import { memoryWooShops } from "./woo-shops.js";

it("seller and operator observe the same job after leaving, without replacing a typed rate", async () => {
  const h = await harness();
  const shops = memoryWooShops();
  const mails: Message[] = [];
  const rows: Record<string, Record<string, unknown>[]> = {
    dashboard_accounts: [],
    dashboard_sessions: [],
    dashboard_credentials: [],
    dashboard_verifications: [],
    dashboard_link_sends: [],
  };
  const config = {
    ...loadConfig({
      DATABASE_URL: "postgres://unused@nowhere/unused",
      AUTH_SECRET: TEST_AUTH_SECRET,
      PAYMENT_NETWORK: "eip155:84532",
      FACILITATOR_URL: "sandbox:scripted",
      BASE_PATH: "/dashboard",
    }),
    surfaceMode: "live" as const,
  };
  // Live presentation with a scripted gateway; publication stays local and no payment is requested.
  await h.store.grantLiveApproval(h.merchant.id, Date.now());
  const identity = identityFor(config, {
    rows,
    journal: h.store,
    postman: async (message) => {
      mails.push(message);
      return "accepted";
    },
  });
  const person = await identity.make("job-reader@example.com", h.merchant.id);
  if (!person) throw new Error("The seller account was not made");
  await identity.choosePlatform(person.id, "woocommerce");
  const operatorEmail = "job-operator@example.com";
  await identity.make(operatorEmail, (await h.addMerchant()).id);
  flagRow(rows, operatorEmail, true);
  await h.gateway.sellThrough(h.merchant.id, "woocommerce");
  await shops.connect({
    accountId: person.id,
    shopUrl: "https://woo.nuanu.ai",
    consumerKey: "ck_fixture",
    consumerSecret: "cs_fixture",
    permissions: "read_write",
    revision: "grant-one",
    connectedAt: new Date(),
    currency: { code: "IDR", decimals: 0 },
  });
  await shops.saveRate(person.id, "https://woo.nuanu.ai", {
    currency: "IDR",
    rate: "16000",
    setAt: new Date(),
    sessionSignedInAt: null,
    reference: null,
    confirmed: false,
  });
  const pages = await builtPages();
  const viteManifest = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../dist/client/.vite/manifest.json", import.meta.url)),
      "utf8",
    ),
  ) as ViteManifest;
  const app = buildApp(config, {
    pages,
    gateway: h.gateway,
    identity,
    wooShops: shops,
    shop: {
      reference: async () => ({ ok: false, listed: null }),
      grantScreen: async () => {
        throw new Error("No grant is requested by a stored job reader");
      },
      preview: async () => {
        throw new Error("No public preview is requested by a connected reader");
      },
      inspectProduct: async () => {
        throw new Error("No purchase is requested by this reader");
      },
    },
    admin: {
      reader: memoryOperatorReader(h.store),
      journal: memoryJournal(h.store),
      accounts: identity,
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await launchChromium();
  const signIn = async (email: string) => {
    rewindLinkSends(rows);
    await identity.requestLink(email, "default", ONE_CLIENT);
    const link = new URL(mails.at(-1)?.body.match(/https?:\/\/\S+/)?.[0] ?? "");
    const opened = await identity.openLink(link.searchParams.get("token") ?? "");
    if (opened.status !== "opened") throw new Error("The reader could not sign in");
    const context = await browser.newContext();
    await context.addCookies(
      opened.setCookies.map((line) => {
        const pair = line.split(";")[0] ?? "";
        const at = pair.indexOf("=");
        return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
      }),
    );
    return context;
  };
  const first = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const afterSecond = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let shopCurrency: "IDR" | "USD" = "IDR";
  let heldRead: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  const start = () =>
    startShopJobs({
      shops,
      identity,
      surfaceMode: "sandbox",
      clientFor: (acting) => gatewayFor(h.gateway, acting),
      publisherFor: (acting) => shopPublisherFor(h.gateway, acting, shops),
      catalogue: async function* () {
        yield {
          kind: "currency",
          currency: { code: shopCurrency, decimals: shopCurrency === "IDR" ? 0 : 2 },
        };
        yield { kind: "total", total: 65 };
        for (let id = 1; id <= 65; id++) {
          yield {
            kind: "product",
            product: {
              id,
              name: `Guide ${id}`,
              sku: "",
              status: "publish",
              virtual: true,
              downloadable: true,
              manage_stock: false,
              download_limit: -1,
              download_expiry: -1,
              downloads: [{ id: "guide", name: "Guide", file: "https://woo.nuanu.ai/guide.pdf" }],
              qualification_problem: null,
              type: "simple",
              description: "Downloadable guide.",
              short_description: "",
              is_purchasable: true,
              is_in_stock: true,
              prices: {
                price: shopCurrency === "IDR" ? "400000" : "2500",
                currency_code: shopCurrency,
                currency_minor_unit: shopCurrency === "IDR" ? 0 : 2,
              },
            },
            inspected: {
              ok: true,
              product: {
                kind: "download",
                productId: String(id),
                downloadId: "guide",
                fileName: "Guide",
                price: {
                  amount: shopCurrency === "IDR" ? "400000" : "25.00",
                  currency: shopCurrency,
                },
                fingerprint: "fixed",
                tax: { mode: "off" },
              },
            },
          };
          if (id === 1) {
            first.resolve();
            await release.promise;
            await heldRead?.promise;
          }
          if (id === 2) {
            afterSecond.resolve();
            await finish.promise;
          }
        }
        yield { kind: "complete", total: 65 };
      },
    });
  let runner = start();
  try {
    await first.promise;
    const seller = await signIn(person.email);
    const operator = await signIn(operatorEmail);
    const abandoned = await seller.newPage();
    await abandoned.goto(`${origin}/dashboard/woocommerce`);
    await abandoned.close();
    const page = await seller.newPage();
    const admin = await operator.newPage();
    const observedScripts = (reader: Page) => {
      const scripts = new Set<string>();
      reader.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/dashboard/assets/") && path.endsWith(".js"))
          scripts.add(path.slice("/dashboard/".length));
      });
      return scripts;
    };
    const sellerScripts = observedScripts(page);
    const operatorScripts = observedScripts(admin);
    await page.goto(`${origin}/dashboard/woocommerce`);
    await admin.goto(`${origin}/dashboard/admin/merchants/${h.merchant.id}`);
    const sellerJob = page.getByRole("region", { name: "Shop products" });
    const operatorJob = admin.getByRole("region", { name: "Shop products" });
    const measured = async (label: string, reader: Page, scripts: ReadonlySet<string>) => {
      await reader.waitForLoadState("networkidle");
      const files = await Promise.all(
        [...scripts].map(async (script) => ({
          script,
          bytes: (
            await stat(fileURLToPath(new URL(`../dist/client/${script}.br`, import.meta.url)))
          ).size,
        })),
      );
      const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
      console.info(
        "[initial scripts]",
        JSON.stringify({ label, bytes, limit: SCRIPT_BUDGET, files }),
      );
      expect.soft(bytes, label).toBeLessThanOrEqual(SCRIPT_BUDGET);
    };
    await sellerJob.getByText("1 of 65 products read.", { exact: true }).waitFor();
    await operatorJob.getByText("1 of 65 products read.", { exact: true }).waitFor();
    await measured("connected shop active with saved IDR rate", page, sellerScripts);
    await measured("operator shop progress", admin, operatorScripts);
    expect([...operatorScripts].sort()).toEqual(
      [
        ...firstVisitScripts(pages.build as ServerBuild, viteManifest, "routes/admin/merchant"),
      ].sort(),
    );
    await page.getByRole("textbox", { name: "IDR per US dollar", exact: true }).fill("17000");
    await admin.getByText("Withdraw admission…", { exact: true }).click();
    const note = admin.getByRole("textbox", { name: "Note to the merchant", exact: true });
    await note.fill("Please review the shop details.");
    const merchantPage = `${origin}/dashboard/admin/merchants/${h.merchant.id}`;
    const jobEndpoint = `${merchantPage}/shop-job`;
    await admin.route(merchantPage, (route) =>
      route.fulfill({ contentType: "text/html", body: "<html><body>Sign in</body></html>" }),
    );
    release.resolve();
    await afterSecond.promise;
    await sellerJob.getByText("2 of 65 products read.", { exact: true }).waitFor();
    const unread = admin.locator("[data-shop-job-unread]");
    await unread.waitFor({ state: "visible" });
    expect(await operatorJob.textContent()).toContain("1 of 65 products read.");
    await admin.unroute(merchantPage);
    await operatorJob.getByText("2 of 65 products read.", { exact: true }).waitFor();
    await unread.waitFor({ state: "hidden" });
    expect(await note.inputValue()).toBe("Please review the shop details.");
    await admin.route(jobEndpoint, (route) => route.fulfill({ status: 404, body: "Not found" }));
    await unread.waitFor({ state: "visible" });
    expect(await operatorJob.textContent()).toContain("2 of 65 products read.");
    await admin.unroute(jobEndpoint);
    await unread.waitFor({ state: "hidden" });
    expect(
      await page.getByRole("textbox", { name: "IDR per US dollar", exact: true }).inputValue(),
    ).toBe("17000");
    expect(await sellerJob.locator("li").count()).toBe(0);
    finish.resolve();
    await sellerJob
      .getByText("65 of 65 products can sell through Agentify.", { exact: true })
      .waitFor();
    await operatorJob
      .getByText("65 of 65 products can sell through Agentify.", { exact: true })
      .waitFor();
    expect(await note.inputValue()).toBe("Please review the shop details.");
    const completed = await seller.newPage();
    const completedScripts = observedScripts(completed);
    await completed.goto(`${origin}/dashboard/woocommerce`);
    await completed
      .getByRole("region", { name: "Shop products" })
      .getByText("65 of 65 products can sell through Agentify.", { exact: true })
      .waitFor();
    await measured("connected shop completed with saved IDR rate", completed, completedScripts);
    await completed.close();
    const operatorMore = operatorJob.getByRole("link", { name: "Show 50 more (55 left)" });
    await operatorMore.focus();
    await admin.waitForResponse(
      (response) => response.url() === jobEndpoint && response.status() === 200,
    );
    expect(await operatorMore.evaluate((element) => element === document.activeElement)).toBe(true);
    await operatorMore.click();
    await admin.waitForURL(/show_ready_ready=60/);
    await admin.waitForLoadState("networkidle");
    expect(await admin.getByRole("region", { name: "Shop products" }).locator("li").count()).toBe(
      60,
    );
    await admin.reload();
    expect(await admin.getByRole("region", { name: "Shop products" }).locator("li").count()).toBe(
      60,
    );
    expect(await sellerJob.locator("li").count()).toBe(10);
    await sellerJob.getByRole("link", { name: "Show 50 more (55 left)" }).click();
    await page.waitForURL(/show_ready_ready=60/);
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Shop products"]')?.querySelectorAll("li").length ===
        60,
    );
    await page.reload();
    expect(await page.getByRole("region", { name: "Shop products" }).locator("li").count()).toBe(
      60,
    );
    const rate = page.getByRole("textbox", { name: "IDR per US dollar", exact: true });
    await rate.fill("17000");
    let detailRefreshes = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/woocommerce.data")) detailRefreshes++;
    });
    await gatewayFor(h.gateway, { merchantId: h.merchant.id, email: person.email }).pollWorker(0);
    const productsPage = await seller.newPage();
    await productsPage.goto(`${origin}/dashboard/products`);
    await productsPage.getByRole("button", { name: "Publish 65 products", exact: true }).click();
    await expect
      .poll(async () => (await productsPage.request.get(`${origin}/dashboard/shop-job`)).json())
      .toMatchObject({
        kind: "publish",
        status: "completed",
        published: 65,
      });
    await productsPage
      .getByRole("list", { name: "Products", exact: true })
      .waitFor({ timeout: 5000 });
    expect(
      await productsPage
        .getByRole("list", { name: "Products", exact: true })
        .locator(".list-row")
        .count(),
    ).toBeGreaterThan(0);
    expect(
      await productsPage
        .getByRole("heading", { name: "Publication finished", exact: true })
        .count(),
    ).toBe(0);
    await expect.poll(() => detailRefreshes, { timeout: 10_000 }).toBe(1);
    await page.waitForLoadState("networkidle");
    expect(await rate.inputValue()).toBe("17000");
    const catalog = await seller.newPage();
    const catalogScripts = observedScripts(catalog);
    await catalog.goto(`${origin}/dashboard/products`);
    await catalog.getByRole("list", { name: "Products", exact: true }).waitFor();
    await measured("published Woo Products catalog", catalog, catalogScripts);
    await catalog.close();
    await productsPage.close();

    await shops.saveRate(person.id, "https://woo.nuanu.ai", {
      currency: "IDR",
      rate: "17000",
      setAt: new Date(),
      sessionSignedInAt: null,
      reference: null,
      confirmed: false,
    });
    const staleCatalog = await seller.newPage();
    const staleScripts = observedScripts(staleCatalog);
    await staleCatalog.goto(`${origin}/dashboard/products`);
    await staleCatalog.getByRole("button", { name: "Check again", exact: true }).waitFor();
    await measured("published Woo catalog with a stale rate", staleCatalog, staleScripts);
    heldRead = Promise.withResolvers<void>();
    await staleCatalog.getByRole("button", { name: "Check again", exact: true }).click();
    await expect
      .poll(async () => (await page.request.get(`${origin}/dashboard/shop-job`)).json())
      .toMatchObject({ kind: "check", status: "running", read: 1 });
    const activeCatalog = await seller.newPage();
    const activeScripts = observedScripts(activeCatalog);
    await activeCatalog.goto(`${origin}/dashboard/products`);
    await activeCatalog
      .getByRole("heading", { name: "Checking your products", exact: true })
      .waitFor();
    await measured("published Woo catalog during a check", activeCatalog, activeScripts);
    await activeCatalog.close();
    const stopping = runner.stop();
    heldRead.resolve();
    await stopping;
    heldRead = null;
    const stoppedCatalog = await seller.newPage();
    const stoppedScripts = observedScripts(stoppedCatalog);
    await stoppedCatalog.goto(`${origin}/dashboard/products`);
    await stoppedCatalog.getByRole("button", { name: "Check again", exact: true }).waitFor();
    await measured(
      "published Woo catalog after an interrupted check",
      stoppedCatalog,
      stoppedScripts,
    );
    expect(await (await page.request.get(`${origin}/dashboard/shop-job`)).json()).toMatchObject({
      status: "stopped",
      stopCode: "interrupted",
      read: 1,
    });
    await stoppedCatalog.close();
    await staleCatalog.close();
    runner = start();

    heldRead = Promise.withResolvers<void>();
    shopCurrency = "USD";
    const connection = await shops.connectionOf(person.id);
    if (!connection) throw new Error("No shop connection");
    await shops.connect({
      ...connection,
      revision: "grant-two",
      currency: { code: "USD", decimals: 2 },
    });
    await expect
      .poll(async () => (await page.request.get(`${origin}/dashboard/shop-job`)).json())
      .toMatchObject({ kind: "check", status: "running", currency: "USD", read: 1 });
    const activeDollar = await seller.newPage();
    const activeDollarScripts = observedScripts(activeDollar);
    await activeDollar.goto(`${origin}/dashboard/woocommerce`);
    await activeDollar
      .getByRole("heading", { name: "Checking your products", exact: true })
      .waitFor();
    await measured("connected shop active in USD", activeDollar, activeDollarScripts);
    await activeDollar.close();
    heldRead.resolve();
    heldRead = null;
    await expect
      .poll(async () => (await page.request.get(`${origin}/dashboard/shop-job`)).json())
      .toMatchObject({
        kind: "check",
        status: "completed",
        currency: "USD",
        ready: 65,
        current: true,
      });
    const dollarPage = await seller.newPage();
    const dollarScripts = observedScripts(dollarPage);
    await dollarPage.goto(`${origin}/dashboard/woocommerce`);
    await dollarPage
      .getByRole("region", { name: "Shop products" })
      .getByText("65 of 65 products can sell through Agentify.", { exact: true })
      .waitFor();
    await measured("connected shop completed in USD", dollarPage, dollarScripts);
    expect(
      await dollarPage.getByRole("textbox", { name: "IDR per US dollar", exact: true }).count(),
    ).toBe(0);
    await runner.stop();
    const datedJob = await shops.jobs.request({
      accountId: person.id,
      merchantId: h.merchant.id,
      connectionRevision: "grant-two",
      shopUrl: connection.shopUrl,
      kind: "check",
    });
    expect((await shops.jobs.claim())?.id).toBe(datedJob.job.id);
    await shops.jobs.currency(datedJob.job.id, { code: "USD", decimals: 2 });
    await shops.jobs.total(datedJob.job.id, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T20:05:06Z"));
    try {
      await shops.jobs.finish(datedJob.job.id, { status: "completed", stopCode: null, why: null });
    } finally {
      vi.useRealTimers();
    }
    const noScript = await browser.newContext({ javaScriptEnabled: false });
    await noScript.addCookies(await seller.cookies());
    try {
      const initialPage = await noScript.newPage();
      for (const [zone, date, time] of [
        ["Asia/Makassar", "2026-10-31", "04:05:06 UTC+8"],
        ["invalid-zone", "2026-10-30", "20:05:06 UTC"],
        ["", "2026-10-30", "20:05:06 UTC"],
      ] as const) {
        await noScript.addCookies([
          { name: "agentify_zone", value: encodeURIComponent(zone), url: origin },
        ]);
        const projected = await (
          await initialPage.request.get(`${origin}/dashboard/shop-job`)
        ).json();
        expect(projected.when).toEqual({ date, time });
        await initialPage.goto(`${origin}/dashboard/woocommerce`);
        expect(
          await initialPage
            .getByRole("region", { name: "Shop products" })
            .getByText(`${date} ${time}`, { exact: true })
            .count(),
        ).toBe(1);
      }
    } finally {
      await noScript.close();
    }
    const reconnectJob = await shops.jobs.request({
      accountId: person.id,
      merchantId: h.merchant.id,
      connectionRevision: "grant-two",
      shopUrl: connection.shopUrl,
      kind: "check",
    });
    expect((await shops.jobs.claim())?.id).toBe(reconnectJob.job.id);
    await shops.jobs.currency(reconnectJob.job.id, { code: "USD", decimals: 2 });
    await shops.jobs.finish(reconnectJob.job.id, {
      status: "stopped",
      stopCode: "reconnect",
      why: "Your shop refused access. Reconnect it, then check again.",
    });
    await dollarPage.getByText("Reconnect required", { exact: true }).waitFor({ timeout: 10_000 });
    expect(await dollarPage.getByText("Connected", { exact: true }).count()).toBe(0);
    await dollarPage.close();
    const reconnectPage = await seller.newPage();
    const reconnectScripts = observedScripts(reconnectPage);
    await reconnectPage.goto(`${origin}/dashboard/woocommerce`);
    const reconnect = reconnectPage.getByRole("button", { name: "Connect again", exact: true });
    await reconnect.waitFor();
    const reconnectForm = reconnect.locator("xpath=ancestor::form");
    expect(await reconnectForm.getAttribute("action")).toBe("/dashboard/woocommerce/connect");
    for (const field of ["checked_shop", "shop_url"])
      expect(await reconnectForm.locator(`input[name="${field}"]`).inputValue()).toBe(
        connection.shopUrl,
      );
    await measured("connected shop requiring reconnect", reconnectPage, reconnectScripts);
    await reconnectPage.close();
  } finally {
    release.resolve();
    finish.resolve();
    heldRead?.resolve();
    await runner.stop();
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await identity.close();
    await h.stop();
  }
}, 60_000);
