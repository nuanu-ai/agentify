import type { LiveSalesNotice } from "@agentify/gateway/live-sales";
import { afterEach, expect, it } from "vitest";
import { type AdminServed, adminServed } from "./testing/admin.js";
import { formsIn, readable } from "./testing/html.js";
import { memoryWooShops, type WooShops } from "./woo-shops.js";

let open: AdminServed | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});
const OWNER = "owner@shop.example";
const note = `Please use the name buyers know.\n${"Check the legal shop name. ".repeat(30)}`;

async function seller(
  channel: "live" | "test" | "sandbox" = "live",
  connected = true,
  shops?: WooShops,
) {
  const notices: LiveSalesNotice[] = [];
  open = await adminServed({
    channel: channel === "sandbox" ? "test" : channel,
    ...(shops === undefined ? {} : { shops }),
    ...(channel === "test"
      ? { environment: { FACILITATOR_URL: "https://x402.org/facilitator" } }
      : {}),
    liveSalesNotices: {
      stage: (notice) => () => {
        notices.push(notice);
      },
    },
  });
  const id = await open.harnessed.gateway.registerMerchant();
  await open.identity.make(OWNER, id);
  if (connected) await open.harnessed.store.noteContact(id, open.harnessed.now(), "api");
  const browser = await open.signedIn(OWNER);
  return { served: open, browser, id, notices };
}

async function checkedShop(channel: "test" | "sandbox" = "test") {
  const shops = memoryWooShops();
  const owned = await seller(channel, false, shops);
  const person = await owned.served.identity.byEmail(OWNER);
  if (!person) throw new Error("seller missing");
  await owned.served.identity.acknowledgeTest(person.id);
  await owned.served.harnessed.store.setServiceName(owned.id, "Freeland", Date.now());
  await owned.served.harnessed.store.setSellerSite(owned.id, "https://woo.nuanu.ai", Date.now());
  await owned.served.harnessed.gateway.sellThrough(owned.id, "woocommerce");
  const connection = {
    accountId: person.id,
    shopUrl: "https://woo.nuanu.ai",
    consumerKey: "ck_test",
    consumerSecret: "cs_test",
    permissions: "read_write",
    revision: "checked-profile",
    connectedAt: new Date(),
    currency: { code: "USD", decimals: 2 as const },
  };
  await shops.connect(connection);
  const { job } = await shops.jobs.request({
    accountId: person.id,
    merchantId: owned.id,
    connectionRevision: connection.revision,
    shopUrl: connection.shopUrl,
    kind: "check",
  });
  await shops.jobs.claim();
  await shops.jobs.currency(job.id, connection.currency);
  await shops.jobs.record(
    job.id,
    {
      id: "1",
      title: "Writing assistant",
      group: "ready",
      reason: "ready",
      why: "",
      published: false,
    },
    1,
  );
  await shops.jobs.finish(job.id, { status: "completed", stopCode: null, why: null });
  return { ...owned, shops, person, connection, job };
}

it("saves the test shop profile and queues its checked publication with one Products form", async () => {
  const { served, browser, id, shops, job } = await checkedShop();
  const form = formsIn((await browser.get("/products")).html).find(
    (entry) => entry.fields.get("intent") === "save-onboarding-profile",
  );
  expect(form?.fields.get("checked_job")).toBe(job.id);
  const result = await browser.post("/products", {
    intent: "save-onboarding-profile",
    checked_job: job.id,
    seller_name: "Nuanu shop",
    payout_wallet: "0x0000000000000000000000000000000000000001",
  });
  expect(result.status).toBe(200);
  expect(await served.harnessed.store.merchantById(id)).toMatchObject({
    serviceName: "Nuanu shop",
    payoutWallet: { address: "0x0000000000000000000000000000000000000001" },
  });
  expect((await shops.jobs.latest(id)).find((entry) => entry.kind === "publish")).toMatchObject({
    status: "queued",
    connectionRevision: "checked-profile",
    currency: { code: "USD", decimals: 2 },
  });
});

it.each(["foreign", "stale"] as const)(
  "retains saved profile facts when the combined press names a %s shop check",
  async (kind) => {
    const { served, browser, id, shops, job, connection } = await checkedShop();
    let checkedJob = job.id;
    if (kind === "foreign") {
      const foreign = await shops.jobs.request({
        accountId: "acc_other",
        merchantId: "mch_other",
        connectionRevision: "foreign",
        shopUrl: connection.shopUrl,
        kind: "check",
      });
      await shops.jobs.claim();
      await shops.jobs.currency(foreign.job.id, connection.currency);
      await shops.jobs.finish(foreign.job.id, { status: "completed", stopCode: null, why: null });
      checkedJob = foreign.job.id;
    } else await shops.connect({ ...connection, revision: "reconnected" });
    const result = await browser.post("/products", {
      intent: "save-onboarding-profile",
      checked_job: checkedJob,
      seller_name: "Nuanu shop",
      payout_wallet: "0x0000000000000000000000000000000000000001",
    });
    expect(result.status).toBe(409);
    expect(await served.harnessed.store.merchantById(id)).toMatchObject({
      serviceName: "Nuanu shop",
      payoutWallet: { address: "0x0000000000000000000000000000000000000001" },
    });
    expect((await shops.jobs.latest(id)).some((entry) => entry.kind === "publish")).toBe(false);
    expect(readable(result.html)).toContain("Your seller name and wallet were saved.");
    expect(readable(result.html)).toContain("Check your products again before publishing.");
  },
);

it.each(["invalid-name", "invalid-wallet", "unknown-wallet"] as const)(
  "does not publish the checked shop after an %s profile result",
  async (failure) => {
    const { served, browser, id, shops, job } = await checkedShop();
    if (failure === "unknown-wallet") {
      const save = served.harnessed.store.setPayoutWallet.bind(served.harnessed.store);
      served.harnessed.store.setPayoutWallet = async (...args) => {
        const result = await save(...args);
        if (args[0] === id) throw new Error("wallet write answer unavailable after saving");
        return result;
      };
    }
    const result = await browser.post("/products", {
      intent: "save-onboarding-profile",
      checked_job: job.id,
      seller_name: failure === "invalid-name" ? "" : "Nuanu shop",
      payout_wallet:
        failure === "invalid-wallet"
          ? "not-a-wallet"
          : "0x0000000000000000000000000000000000000001",
    });
    expect(result.status).toBe(failure === "unknown-wallet" ? 503 : 400);
    expect((await shops.jobs.latest(id)).some((entry) => entry.kind === "publish")).toBe(false);
    expect((await served.harnessed.store.merchantById(id))?.payoutWallet.address).toBe(
      failure === "unknown-wallet" ? "0x0000000000000000000000000000000000000001" : null,
    );
    if (failure === "unknown-wallet") {
      expect(readable(result.html)).toContain("Your seller name was saved.");
      expect(readable(result.html)).toContain("We couldn't confirm your wallet.");
    }
  },
);

it("keeps saved profile facts visible when starting publication loses its answer", async () => {
  const { served, browser, id, shops, job } = await checkedShop();
  const request = shops.jobs.request.bind(shops.jobs);
  shops.jobs.request = async (input) => {
    const result = await request(input);
    if (input.kind === "publish") throw new Error("publication answer lost after write");
    return result;
  };
  const result = await browser.post("/products", {
    intent: "save-onboarding-profile",
    checked_job: job.id,
    seller_name: "Nuanu shop",
    payout_wallet: "0x0000000000000000000000000000000000000001",
  });
  expect(result.status).toBe(503);
  expect((await served.harnessed.store.merchantById(id))?.serviceName).toBe("Nuanu shop");
  expect((await shops.jobs.latest(id)).find((entry) => entry.kind === "publish")?.status).toBe(
    "queued",
  );
  expect(readable(result.html)).toContain("Your seller name and wallet were saved.");
  expect(readable(result.html)).toContain("couldn't confirm whether publication started");
});

it("publishes the sandbox shop after saving its name without requiring a wallet", async () => {
  const { served, browser, id, shops, job } = await checkedShop("sandbox");
  const result = await browser.post("/products", {
    intent: "save-onboarding-profile",
    checked_job: job.id,
    seller_name: "Nuanu shop",
  });
  expect(result.status).toBe(200);
  expect((await served.harnessed.store.merchantById(id))?.payoutWallet.address).toBeNull();
  expect((await shops.jobs.latest(id)).find((entry) => entry.kind === "publish")?.status).toBe(
    "queued",
  );
});

it("requests live sales from connected code without a wallet, retaining the request when code goes quiet and the browser returns", async () => {
  const { served, browser, id, notices } = await seller();
  const form = formsIn((await browser.get("/products")).html).find(
    (entry) => entry.fields.get("intent") === "request-live-sales",
  );
  expect(form?.fields.has("seller_name")).toBe(true);
  expect(form?.fields.has("payout_wallet")).toBe(false);
  expect(
    (await browser.post("/products", { intent: "request-live-sales", seller_name: "Freeland" }))
      .status,
  ).toBe(303);
  const first = await served.harnessed.store.liveSalesRequest(id);
  expect(first?.state).toBe("pending");
  expect((await served.harnessed.store.merchantById(id))?.payoutWallet.address).toBeNull();
  served.harnessed.advance(2 * 60 * 60_000);
  await served.harnessed.gateway.sellThrough(id, "woocommerce");
  await served.harnessed.gateway.sellThrough(id, "api");
  const returned = await served.signedIn(OWNER);
  const pending = await returned.get("/products");
  expect(readable(pending.html)).toContain("Request sent");
  expect(
    formsIn(pending.html).some((entry) => entry.fields.get("intent") === "save-onboarding-wallet"),
  ).toBe(true);
  expect((await returned.post("/products", { intent: "request-live-sales" })).status).toBe(303);
  expect((await served.harnessed.store.liveSalesRequest(id))?.id).toBe(first?.id);
  expect(notices).toHaveLength(1);
});

it("refuses an invalid name before asking and keeps the submitted value editable", async () => {
  const { served, browser, id } = await seller();
  const invalid = "A title longer than thirty-two characters from a shop";
  const refused = await browser.post("/products", {
    intent: "request-live-sales",
    seller_name: invalid,
  });
  expect(refused.status).toBe(400);
  expect(
    formsIn(refused.html)
      .find((entry) => entry.fields.has("seller_name"))
      ?.fields.get("seller_name"),
  ).toBe(invalid);
  expect(await served.harnessed.store.liveSalesRequest(id)).toBeNull();
  expect((await served.harnessed.store.merchantById(id))?.serviceName).toBeNull();
});

it("saves the test seller name and wallet together before offering the code publishing guide", async () => {
  const { served, browser, id } = await seller("test");
  const person = await served.identity.byEmail(OWNER);
  if (!person) throw new Error("seller missing");
  await served.identity.acknowledgeTest(person.id);
  const before = await browser.get("/products");
  const form = formsIn(before.html).find(
    (entry) => entry.fields.get("intent") === "save-onboarding-profile",
  );
  expect(form?.fields.has("seller_name")).toBe(true);
  expect(form?.fields.has("payout_wallet")).toBe(true);
  const wallet = "0x0000000000000000000000000000000000000001";
  expect(
    (
      await browser.post("/products", {
        intent: "save-onboarding-profile",
        seller_name: "Freeland",
        payout_wallet: wallet,
      })
    ).status,
  ).toBe(303);
  expect(await served.harnessed.store.merchantById(id)).toMatchObject({
    serviceName: "Freeland",
    payoutWallet: { address: wallet },
  });
  const after = await browser.get("/products");
  expect(after.html).toContain('href="/docs/quickstart#_4-publish-one-card"');
  expect(
    formsIn(after.html).some((entry) => entry.fields.get("intent") === "save-onboarding-profile"),
  ).toBe(false);
});

it("declines only the reviewed request through the authenticated operator form and shows the full note to the seller", async () => {
  const { served, browser, id } = await seller();
  await browser.post("/products", { intent: "request-live-sales", seller_name: "Freeland" });
  const first = await served.harnessed.store.liveSalesRequest(id);
  if (!first) throw new Error("request missing");
  const operator = await served.signedIn("op@agentify.example", { operator: true });
  const page = await operator.get(`/admin/merchants/${id}`);
  const form = formsIn(page.html).find((entry) => entry.action.endsWith("/decline"));
  expect(form?.fields.get("request_id")).toBe(first.id);
  expect(readable(page.html)).toContain("No payout wallet yet");
  expect(
    (
      await operator.post(`/admin/merchants/${id}/decline`, {
        request_id: first.id,
        confirm: "yes",
      })
    ).status,
  ).toBe(409);
  expect((await served.harnessed.store.liveSalesRequest(id))?.state).toBe("pending");
  await operator.post(`/admin/merchants/${id}/decline`, {
    request_id: first.id,
    confirm: "yes",
    reason: note,
  });
  const journal = await operator.get(`/admin/journal?q=${id}`);
  expect(readable(journal.html)).toContain("Declined the live-sales request");
  expect(readable(journal.html)).toContain(note.replace(/\s+/g, " ").trim());
  const declined = await browser.get("/products");
  expect(readable(declined.html)).toContain(note.replace(/\s+/g, " ").trim());
  expect(
    formsIn(declined.html).some((entry) => entry.fields.get("intent") === "request-live-sales"),
  ).toBe(true);
  await browser.post("/products", { intent: "request-live-sales", seller_name: "Freeland" });
  const next = await served.harnessed.store.liveSalesRequest(id);
  expect(next?.id).not.toBe(first.id);
  await operator.post(`/admin/merchants/${id}/decline`, {
    request_id: first.id,
    confirm: "yes",
    reason: "Stale form",
  });
  expect((await served.harnessed.store.liveSalesRequest(id))?.state).toBe("pending");
  expect(readable((await browser.get("/products")).html)).toContain("Request sent");
});

it("shows the newer withdrawal after a declined request was manually admitted, preserving the old full note only in history", async () => {
  const { served, browser, id } = await seller();
  await browser.post("/products", { intent: "request-live-sales", seller_name: "Freeland" });
  const request = await served.harnessed.store.liveSalesRequest(id);
  if (!request) throw new Error("request missing");
  const operator = await served.signedIn("op@agentify.example", { operator: true });
  const path = `/admin/merchants/${id}`;
  await operator.post(`${path}/decline`, { request_id: request.id, confirm: "yes", reason: note });
  expect(readable((await browser.get("/products")).html)).toContain(
    note.replace(/\s+/g, " ").trim(),
  );
  expect((await operator.post(`${path}/admit`, { confirm: "yes" })).status).toBe(200);
  const newer = "Correct the current seller site before asking again.";
  expect((await operator.post(`${path}/withdraw`, { confirm: "yes", reason: newer })).status).toBe(
    200,
  );
  const products = readable((await browser.get("/products")).html);
  expect(products).toContain(newer);
  expect(products).not.toContain(note.replace(/\s+/g, " ").trim());
  const journal = readable((await operator.get(`/admin/journal?q=${id}`)).html);
  expect(journal).toContain(note.replace(/\s+/g, " ").trim());
  expect(journal).toContain(newer);
});

it("reports the saved name separately when the wallet is refused after that write", async () => {
  const { served, browser, id } = await seller("test");
  const payout = (await served.harnessed.store.merchantById(served.harnessed.merchant.id))
    ?.payoutWallet.split;
  if (!payout) throw new Error("seeded merchant has no payout split");
  const failed = await browser.post("/products", {
    intent: "save-onboarding-profile",
    seller_name: "Freeland",
    payout_wallet: payout.address,
  });
  expect(failed.status).toBe(400);
  expect((await served.harnessed.store.merchantById(id))?.serviceName).toBe("Freeland");
  expect((await served.harnessed.store.merchantById(id))?.payoutWallet.address).toBeNull();
  expect(readable(failed.html)).toContain("Your seller name was saved.");
  expect(readable(failed.html)).not.toContain("Nothing was changed");
  expect(readable(failed.html)).not.toContain("couldn't confirm your wallet");
});

it("refuses a forged live request without server-observed integration evidence", async () => {
  const { served, browser, id } = await seller("live", false);
  const refused = await browser.post("/products", {
    intent: "request-live-sales",
    seller_name: "Freeland",
    evidence: JSON.stringify({ integration: "api", connectedAt: Date.now() }),
  });
  expect(refused.status).toBe(409);
  expect(await served.harnessed.store.liveSalesRequest(id)).toBeNull();
  expect((await served.harnessed.store.merchantById(id))?.serviceName).toBeNull();
});

it("keeps the sandbox wallet optional when its first seller name is saved", async () => {
  const { served, browser, id } = await seller("sandbox");
  const form = formsIn((await browser.get("/products")).html).find(
    (entry) => entry.fields.get("intent") === "save-onboarding-profile",
  );
  expect(form?.fields.has("seller_name")).toBe(true);
  expect(form?.fields.has("payout_wallet")).toBe(false);
  expect(
    (
      await browser.post("/products", {
        intent: "save-onboarding-profile",
        seller_name: "Freeland",
      })
    ).status,
  ).toBe(303);
  expect((await served.harnessed.store.merchantById(id))?.payoutWallet.address).toBeNull();
  expect((await browser.get("/products")).html).toContain(
    'href="/docs/quickstart#_4-publish-one-card"',
  );
});

it("follows the current code integration after a shop disconnect, retaining shop work as history", async () => {
  const shops = memoryWooShops();
  const { served, browser, id } = await seller("live", false, shops);
  const person = await served.identity.byEmail(OWNER);
  if (!person) throw new Error("seller missing");
  await shops.connect({
    accountId: person.id,
    shopUrl: "https://woo.nuanu.ai",
    consumerKey: "ck_private",
    consumerSecret: "cs_private",
    permissions: "read_write",
    revision: "previous-connection",
    connectedAt: new Date(),
    currency: { code: "USD", decimals: 2 },
  });
  await served.harnessed.gateway.sellThrough(id, "woocommerce");
  const { job } = await shops.jobs.request({
    accountId: person.id,
    merchantId: id,
    shopUrl: "https://woo.nuanu.ai",
    connectionRevision: "previous-connection",
    kind: "check",
  });
  await shops.jobs.claim();
  await shops.jobs.finish(job.id, { status: "completed", stopCode: null, why: null });
  await shops.forget(person.id);
  await served.harnessed.gateway.sellThrough(id, "api");
  const returned = await browser.get("/products");
  expect(formsIn(returned.html).some((entry) => entry.fields.has("shop_url"))).toBe(false);
  expect(readable(returned.html)).toContain("npm install");
  expect(returned.html).not.toContain("ways=choose");
  await served.harnessed.addKey(id);
  const code = await browser.get("/products");
  expect(formsIn(code.html).some((entry) => entry.fields.has("shop_url"))).toBe(false);
  expect(readable(code.html)).toContain("npm install");
});

it("keeps a failed request retryable when its transactional notice writer is unavailable", async () => {
  open = await adminServed({ channel: "live" });
  const id = await open.harnessed.gateway.registerMerchant();
  await open.identity.make(OWNER, id);
  await open.harnessed.store.noteContact(id, open.harnessed.now(), "api");
  const browser = await open.signedIn(OWNER);
  const failed = await browser.post("/products", {
    intent: "request-live-sales",
    seller_name: "Freeland",
  });
  expect(failed.status).toBe(503);
  expect(
    formsIn(failed.html)
      .find((entry) => entry.fields.get("intent") === "request-live-sales")
      ?.fields.get("seller_name"),
  ).toBe("Freeland");
  expect(await open.harnessed.store.liveSalesRequest(id)).toBeNull();
  expect((await open.harnessed.store.merchantById(id))?.serviceName).toBeNull();
});

it("retains the known name save when the wallet write loses its answer", async () => {
  const { served, browser, id } = await seller("test");
  const real = served.harnessed.store.setPayoutWallet.bind(served.harnessed.store);
  served.harnessed.store.setPayoutWallet = async (...args) => {
    if (args[0] === id) throw new Error("wallet store unavailable");
    return await real(...args);
  };
  const failed = await browser.post("/products", {
    intent: "save-onboarding-profile",
    seller_name: "Freeland",
    payout_wallet: "0x0000000000000000000000000000000000000001",
  });
  expect(failed.status).toBe(503);
  expect((await served.harnessed.store.merchantById(id))?.serviceName).toBe("Freeland");
  expect((await served.harnessed.store.merchantById(id))?.payoutWallet.address).toBeNull();
  expect(readable(failed.html)).toContain("Your seller name was saved.");
  expect(readable(failed.html)).toContain("We couldn't confirm your wallet.");
  expect(readable(failed.html)).not.toContain("Nothing was changed");
});
