import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";
import { type AdminServed, adminServed } from "./testing/admin.js";
import { formsIn, readable } from "./testing/html.js";
import { memoryWooShops } from "./woo-shops.js";

let opened: AdminServed | null = null;
afterEach(async () => {
  await opened?.close();
  opened = null;
});

it("keeps automatic publication pending behind a check, then preserves the shop recovery when the intent settles", async () => {
  let pending = true;
  const shops = memoryWooShops();
  opened = await adminServed({
    channel: "live",
    shops,
    livePublicationPending: async () => pending,
  });
  const merchant = await opened.harnessed.addMerchant("Freeland");
  await opened.identity.make("owner@freeland.app", merchant.id);
  const person = await opened.identity.byEmail("owner@freeland.app");
  if (!person) throw new Error("missing seller");
  await shops.connect({
    accountId: person.id,
    shopUrl: "https://woo.nuanu.ai",
    consumerKey: "ck_private",
    consumerSecret: "cs_private",
    permissions: "read_write" as const,
    revision: "connected",
    connectedAt: new Date(),
    currency: { code: "USD", decimals: 2 as const },
  });
  await opened.harnessed.gateway.sellThrough(merchant.id, "woocommerce");
  const browser = await opened.signedIn("owner@freeland.app");
  const preparing = await browser.get("/products");
  expect(preparing.status).toBe(200);
  expect(readable(preparing.html)).toMatch(/preparing your publication/i);
  expect(readable(preparing.html)).not.toMatch(/pass this check/i);
  const { job } = await shops.jobs.request({
    accountId: person.id,
    merchantId: merchant.id,
    shopUrl: "https://woo.nuanu.ai",
    connectionRevision: "connected",
    kind: "check",
  });
  await shops.jobs.claim();
  const checking = await browser.get("/products");
  expect(checking.status).toBe(200);
  expect(readable(checking.html)).toContain("We'll publish the products that pass this check.");
  expect(readable(checking.html)).toContain("We'll email owner@freeland.app when it finishes.");
  expect(formsIn(checking.html).some((form) => form.action.includes("import"))).toBe(false);

  await shops.jobs.currency(job.id, { code: "USD", decimals: 2 });
  // Owned lab product 22 (2026-10-30 capture); a check records no publication receipt.
  await shops.jobs.record(
    job.id,
    {
      id: "22",
      title: "Gift Wrapping Guide",
      group: "ready",
      reason: "ready",
      why: "",
      published: false,
    },
    1,
  );
  await shops.jobs.finish(job.id, { status: "completed", stopCode: null, why: null });
  const checked = await browser.get("/products");
  expect(checked.status).toBe(200);
  expect(readable(checked.html)).toMatch(/preparing your publication/i);
  expect(readable(checked.html)).not.toMatch(/pass this check/i);
  expect(formsIn(checked.html).some((form) => form.fields.has("checked_job"))).toBe(false);

  pending = false;
  const retry = await shops.jobs.request({
    accountId: person.id,
    merchantId: merchant.id,
    shopUrl: "https://woo.nuanu.ai",
    connectionRevision: "connected",
    kind: "check",
  });
  await shops.jobs.claim();
  await shops.jobs.finish(retry.job.id, {
    status: "stopped",
    stopCode: "reconnect",
    why: "Reconnect your shop.",
  });
  const stopped = await browser.get("/products");
  expect(readable(stopped.html)).not.toContain("We'll publish the products that pass this check.");
  expect(readable(stopped.html)).toContain("Reconnect");
});

it("shows an unread account when the automatic publication state cannot be read", async () => {
  opened = await adminServed({
    channel: "live",
    livePublicationPending: async () => {
      throw new Error("publication state unavailable");
    },
  });
  const browser = await opened.signedIn("owner@freeland.app");
  const page = await browser.get("/products");
  expect(page.status).toBe(200);
  expect(readable(page.html)).toContain("We could not check your account");
  expect(readable(page.html)).not.toContain("We'll publish");
});

it.each(["publish", "check"] as const)(
  "offers a zero-read stopped %s its safe next action",
  async (kind) => {
    const shops = memoryWooShops();
    opened = await adminServed({ channel: "live", shops });
    const merchant = await opened.harnessed.addMerchant("Freeland");
    await opened.identity.make("owner@freeland.app", merchant.id);
    const person = await opened.identity.byEmail("owner@freeland.app");
    if (!person) throw new Error("missing seller");
    await opened.harnessed.store.setSellerSite(merchant.id, "https://woo.nuanu.ai", Date.now());
    await opened.harnessed.gateway.sellThrough(merchant.id, "woocommerce");
    const connection = {
      accountId: person.id,
      shopUrl: "https://woo.nuanu.ai",
      consumerKey: "ck_private",
      consumerSecret: "cs_private",
      permissions: "read_write" as const,
      revision: "connected",
      connectedAt: new Date(),
      currency: { code: "USD", decimals: 2 as const },
    };
    await shops.connect(connection);
    const { job } = await shops.jobs.request({
      accountId: person.id,
      merchantId: merchant.id,
      shopUrl: connection.shopUrl,
      connectionRevision: connection.revision,
      ...(kind === "publish" ? { kind, currency: connection.currency, rate: null } : { kind }),
    });
    await shops.jobs.claim();
    if (kind === "check") await shops.jobs.currency(job.id, connection.currency);
    await shops.jobs.finish(job.id, {
      status: "stopped",
      stopCode: "unread",
      why: "The shop could not be read.",
    });
    expect(await shops.jobs.rows(merchant.id, job.id)).toEqual([]);
    expect(await opened.harnessed.store.cards(merchant.id)).toEqual([]);

    const browser = await opened.signedIn("owner@freeland.app");
    const page = await browser.get("/products");
    expect(page.status).toBe(200);
    const form = formsIn(page.html).find((one) => one.fields.has("checked_job"));
    if (kind === "check") {
      expect(form).toBeUndefined();
      expect((await shops.jobs.latest(merchant.id)).some((one) => one.kind === "publish")).toBe(
        false,
      );
      return;
    }
    expect(form?.fields.get("checked_job")).toBe(job.id);
    expect(form?.presses.map((press) => press.label)).toContain("Sync with your shop");
    if (!form) throw new Error("the stopped publication offers no sync form");
    const sync = new JSDOM(page.html).window.document.querySelector(
      "main button.button-primary",
    ) as HTMLButtonElement | null;
    expect(sync?.textContent).toBe("Sync with your shop");
    expect(sync?.classList.contains("button-primary")).toBe(true);
    expect(sync?.disabled).toBe(false);
    expect(form.action.startsWith(`${opened.config.basePath}/`)).toBe(true);
    const pressed = await browser.post(
      form.action.slice(opened.config.basePath.length),
      Object.fromEntries(form.fields),
    );
    expect(pressed.status).toBe(200);
    const next = (await shops.jobs.latest(merchant.id)).find((one) => one.kind === "publish");
    expect(next).toMatchObject({
      kind: "publish",
      status: "queued",
      connectionRevision: "connected",
      currency: { code: "USD", decimals: 2 as const },
      rate: null,
      read: 0,
    });
    expect(next?.id).not.toBe(job.id);
    expect(await opened.harnessed.store.cards(merchant.id)).toEqual([]);
  },
);
