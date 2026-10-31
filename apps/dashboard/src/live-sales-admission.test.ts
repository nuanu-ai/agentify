import { describe, expect, it } from "vitest";
import { liveSalesMessage } from "./live-sales-message.js";
import { publicationMailEvent } from "./live-sales-publication.js";
import type { ShopJob } from "./shop-jobs.js";

const trigger = {
  kind: "admitted" as const,
  approvalAt: Date.parse("2026-10-30T14:00:00Z"),
  id: "decision_one",
  merchantId: "mch_one",
  at: Date.parse("2026-10-30T14:00:00Z"),
  sellerName: "Freeland",
  sellerSite: "https://freeland.app",
  integration: "woocommerce" as const,
  hasWallet: true,
  reason: null,
};
const job: ShopJob = {
  id: "job_one",
  merchantId: "mch_one",
  accountId: "acc_one",
  connectionRevision: "one",
  shopUrl: "https://woo.nuanu.ai",
  kind: "publish",
  status: "completed",
  sequence: 2,
  startedAt: "2026-10-30T14:00:00Z",
  endedAt: "2026-10-30T14:02:00Z",
  revision: 3,
  read: 3,
  total: 3,
  why: null,
  stopCode: null,
  currency: { code: "USD", decimals: 2 },
  rate: null,
};
const rows = [
  {
    id: "1",
    title: "Writing assistant",
    group: "ready" as const,
    reason: "ready",
    why: "",
    published: true,
  },
  {
    id: "2",
    title: "Writing assistant",
    group: "fix" as const,
    reason: "price",
    why: "Set a price.",
    published: false,
  },
  {
    id: "3",
    title: "Writing assistant",
    group: "unsupported" as const,
    reason: "variations",
    why: "Variants are not supported.",
    published: false,
  },
];
const mail = (event: ReturnType<typeof publicationMailEvent>) =>
  liveSalesMessage({
    to: "owner@example.com",
    event,
    requesterEmail: null,
    baseUrl: "https://agentify.ad/dashboard",
    idempotencyKey: "one",
  });
describe("the seller's admission publication email", () => {
  it("reports only actual on-sale rows and only fixable products as needing shop changes", () => {
    const event = publicationMailEvent(trigger, job, rows);
    const message = mail(event);
    expect(event.publication).toMatchObject({ published: 1, fix: 1, read: 3, total: 3 });
    // The subject counts what went on sale, never what was read.
    expect(message.subject).toMatch(/\b1\b/);
    expect(message.subject).not.toMatch(/\b3\b/);
    expect(message.body).toContain("1 more product can go on sale once you fix it in your shop.");
    expect(message.body).toContain("approved Freeland");
    expect(message.html).toContain("Open your products");
  });
  it("keeps partial coverage and an unknown total explicit after a stopped publication", () => {
    const event = publicationMailEvent(
      trigger,
      { ...job, status: "stopped", total: null, stopCode: "unknown" },
      rows,
    );
    const message = mail(event);
    expect(message.subject).toContain("Publishing stopped partway");
    expect(message.body).toContain("We don't know about the rest yet.");
    expect(message.body).not.toContain("of 3");
  });
  it("does not claim that no cards were published when none were confirmed for sale at completion", () => {
    const event = publicationMailEvent(
      trigger,
      job,
      rows.map((row) => ({ ...row, published: false })),
    );
    const message = mail(event);
    expect(event.publication).toMatchObject({ published: 0, status: "completed" });
    expect(message.subject).toContain("No products were confirmed for sale");
    expect(message.body).not.toContain("No products were published");
    expect(message.body).toContain("When this publication finished");
  });
  it("still asks a shop whose publication waits on its check to look at the shop and rate", () => {
    const message = mail({ ...trigger, next: "products", publication: null });
    expect(message.body).toContain(
      "Check your connected shop and exchange rate before publishing products.",
    );
  });
  it("does not announce approval again when the first wallet starts publication", () => {
    const message = mail(publicationMailEvent({ ...trigger, kind: "first_wallet" }, job, rows));
    expect(message.subject).toMatch(/\b1\b/);
    expect(`${message.subject}\n${message.body}`).not.toContain("approved");
    expect(message.body).toContain("We published 1 product from woo.nuanu.ai.");
  });
});
