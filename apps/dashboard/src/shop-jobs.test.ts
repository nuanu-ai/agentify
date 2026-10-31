import { describe, expect, it } from "vitest";
import { type JobRequest, memoryShopJobs } from "./shop-jobs.js";

const input = {
  merchantId: "m1",
  accountId: "a1",
  connectionRevision: "r1",
  shopUrl: "https://woo.nuanu.ai",
  kind: "check" as const,
};
describe("persisted shop work", () => {
  it("admits one active job per merchant and reports a different requested kind as busy", async () => {
    const jobs = memoryShopJobs();
    const results = await Promise.all([
      jobs.request(input),
      jobs.request({
        ...input,
        kind: "publish",
        currency: { code: "USD", decimals: 2 },
        rate: null,
      }),
    ]);
    expect(results[0]?.job.id).toBe(results[1]?.job.id);
    expect(results[1]).toMatchObject({ accepted: false, job: { kind: "check" } });
  });
  it.each([
    { rate: null },
    { currency: { code: "USD", decimals: 2 } },
    { currency: { code: "IDR", decimals: 0 }, rate: null },
    {
      currency: { code: "IDR", decimals: 0 },
      rate: { version: 1, currency: "EUR", rate: "1", setAt: "2026-10-30T00:00:00Z" },
    },
  ])("refuses publication without a complete matching checked basis: %j", async (basis) => {
    const jobs = memoryShopJobs();
    await expect(
      jobs.request({ ...input, kind: "publish", ...basis } as JobRequest),
    ).rejects.toThrow("checked currency and exchange rate");
    expect(await jobs.latest(input.merchantId)).toEqual([]);
  });
  it("retains partial knowledge across interruption and keeps another merchant's rows private", async () => {
    const jobs = memoryShopJobs();
    const { job } = await jobs.request(input);
    await jobs.claim();
    await jobs.record(
      job.id,
      { id: "1", title: "Guide", group: "ready", reason: "ready", why: "", published: false },
      2,
    );
    await jobs.close();
    await jobs.interrupted();
    expect(await jobs.latest("m1")).toMatchObject([{ status: "stopped", read: 1, total: 2 }]);
    expect(await jobs.rows("m1", job.id)).toHaveLength(1);
    expect(await jobs.rows("other", job.id)).toEqual([]);
    expect((await jobs.request(input)).job.id).not.toBe(job.id);
  });
});
