import { afterEach, expect, it } from "vitest";
import { type AdminServed, adminServed } from "./testing/admin.js";
import { memoryWooShops } from "./woo-shops.js";

let running: AdminServed | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

it("the seller and an authenticated operator read the same bounded job; other sellers cannot select it", async () => {
  const shops = memoryWooShops();
  running = await adminServed({ shops });
  const seller = await running.signedIn("shop@example.com");
  const operator = await running.signedIn("operator@example.com", { operator: true });
  const stranger = await running.signedIn("stranger@example.com");
  const person = await running.identity.byEmail("shop@example.com");
  if (!person?.merchant) throw new Error("The signed-in seller was not attached");
  await shops.connect({
    accountId: person.id,
    shopUrl: "https://woo.nuanu.ai",
    consumerKey: "ck_private",
    consumerSecret: "cs_private",
    permissions: "read_write",
    revision: "grant-1",
    connectedAt: new Date(),
    currency: { code: "USD", decimals: 2 },
  });
  await running.harnessed.gateway.sellThrough(person.merchant.id, "woocommerce");
  const beforeCheck = await operator.get("/admin/merchants/" + person.merchant.id);
  expect(beforeCheck.html).toContain("No product check yet.");
  expect(beforeCheck.html).not.toContain("Preparing to check");
  const { job } = await shops.jobs.request({
    accountId: person.id,
    merchantId: person.merchant.id,
    shopUrl: "https://woo.nuanu.ai",
    connectionRevision: "grant-1",
    kind: "check",
  });
  await shops.jobs.claim();
  for (let id = 1; id <= 70; id++)
    await shops.jobs.record(
      job.id,
      {
        id: String(id),
        title: "Guide " + id,
        group: "ready",
        reason: "ready",
        why: "",
        published: false,
      },
      70,
    );
  const active = JSON.parse((await seller.get("/shop-job")).html);
  expect(active).toMatchObject({ status: "running", read: 70, total: 70, ready: 70, groups: [] });
  await shops.jobs.finish(job.id, { status: "completed", stopCode: null, why: null });
  const own = await seller.get("/shop-job?show_ready_ready=60");
  const same = await operator.get(
    "/admin/merchants/" + person.merchant.id + "/shop-job?show_ready_ready=60",
  );
  expect(own.status).toBe(200);
  expect(same.status).toBe(200);
  const sellerView = JSON.parse(own.html);
  const operatorView = JSON.parse(same.html);
  const { reconnectInstruction: sellerInstruction, ...sellerWords } = sellerView.words;
  const { reconnectInstruction: operatorInstruction, ...operatorWords } = operatorView.words;
  expect({ ...operatorView, words: operatorWords }).toEqual({ ...sellerView, words: sellerWords });
  expect(sellerInstruction).toMatch(/^Reconnect the shop/);
  expect(operatorInstruction).toMatch(/merchant needs to reconnect/);
  expect(sellerView.groups[0].reasons[0].rows).toHaveLength(60);
  expect(own.html).not.toContain("ck_private");
  expect(own.html).not.toContain("cs_private");
  expect((await stranger.get("/shop-job?merchant_id=" + person.merchant.id)).html).toBe("null");
  expect((await stranger.get("/admin/merchants/" + person.merchant.id + "/shop-job")).status).toBe(
    404,
  );
  expect((await running.visitor().get("/shop-job")).status).toBe(404);
  const page = await operator.get("/admin/merchants/" + person.merchant.id);
  expect(page.status).toBe(200);
  expect(page.html).toContain("<script");
  expect(page.html).toContain(
    `href="${running.config.basePath}/admin/merchants/${person.merchant.id}?show_ready_ready=60"`,
  );
  const expanded = await operator.get(`/admin/merchants/${person.merchant.id}?show_ready_ready=60`);
  expect(expanded.html).toContain("Guide 60");
  expect(expanded.html).not.toContain("Guide 61");
  const list = await operator.get("/admin/merchants");
  expect(list.html).not.toContain("<script");
  const endedAt = (await shops.jobs.latest(person.merchant.id))[0]?.endedAt;
  if (!endedAt) throw new Error("No completed check timestamp");
  for (const [zone, offset] of [
    ["Asia/Makassar", 8],
    ["invalid-zone", 0],
    ["", 0],
  ] as const) {
    seller.cookie("agentify_zone", encodeURIComponent(zone));
    const projected = JSON.parse((await seller.get("/shop-job")).html);
    const wall = new Date(Date.parse(endedAt) + offset * 3_600_000).toISOString();
    expect(projected.when).toEqual({
      date: wall.slice(0, 10),
      time: `${wall.slice(11, 19)} UTC${offset ? "+8" : ""}`,
    });
  }
});

it("a flagged operator cannot read shop work when this dashboard has no operator workspace", async () => {
  const shops = memoryWooShops();
  running = await adminServed({ shops, workspace: false });
  const operator = await running.signedIn("operator@example.com", { operator: true });
  const person = await running.identity.byEmail("operator@example.com");
  if (!person?.merchant) throw new Error("No merchant");
  await shops.jobs.request({
    accountId: person.id,
    merchantId: person.merchant.id,
    kind: "check",
    connectionRevision: "private-grant",
    shopUrl: "https://woo.nuanu.ai",
  });
  const denied = await operator.get(`/admin/merchants/${person.merchant.id}/shop-job`);
  expect(denied.status).toBe(404);
  expect(denied.html).not.toContain("woo.nuanu.ai");
});
