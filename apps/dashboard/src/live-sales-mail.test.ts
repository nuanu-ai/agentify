import type { LiveSalesNotice, LiveSalesRequest } from "@agentify/gateway/live-sales";
import { describe, expect, it } from "vitest";
import { liveSalesMessage } from "./live-sales-message.js";

const askedAt = Date.parse("2026-10-30T14:00:00Z");
const request: LiveSalesRequest = {
  id: "lsr_1",
  merchantId: "mch_woo",
  accountId: "acc_merchant",
  requestedAt: askedAt,
  state: "pending",
  evidence: {
    integration: "woocommerce",
    host: "woo.nuanu.ai",
    checkedAt: askedAt - 60_000,
    ready: 1234,
    read: 2000,
    total: 2000,
    complete: true,
  },
  decline: null,
  reminderDueAt: Date.parse("2026-11-03T14:00:00Z"),
  reminderCreatedAt: null,
};
const event: LiveSalesNotice = {
  kind: "requested",
  request,
  sellerName: "Nuanu shop",
  hasWallet: false,
};
const messageFor = (notice = event, requesterEmail: string | null = "seller@example.com") =>
  liveSalesMessage({
    to: "operator@example.com",
    event: notice,
    requesterEmail,
    baseUrl: "https://agentify.example/dashboard",
    idempotencyKey: "live-sales-test",
  });

describe("live-sales mail", () => {
  it("gives an operator the dated checked counts, missing wallet and one merchant link", () => {
    const message = messageFor();
    expect(message.body).toContain("1,234 of 2,000");
    expect(message.body).toContain("woo.nuanu.ai");
    expect(message.body).toContain("2026-10-30 14:00:00 UTC");
    expect(message.body).toContain("seller@example.com");
    expect(message.body).toContain("No payout wallet yet");
    expect(message.body).toContain("https://agentify.example/dashboard/admin/merchants/mch_woo");
    expect(message.idempotencyKey).toBe("live-sales-test");
  });

  it("does not turn a partial check or missing legacy evidence into a complete catalog claim", () => {
    const partial = messageFor({
      ...event,
      request: {
        ...request,
        evidence: {
          integration: "woocommerce",
          host: "woo.nuanu.ai",
          checkedAt: askedAt - 60_000,
          ready: 1200,
          read: 1500,
          total: null,
          complete: false,
        },
      },
    });
    expect(partial.body).toContain("1,200");
    expect(partial.body).toContain("1,500");
    expect(partial.body).toMatch(/rest.*(?:unknown|don't know)|don't know.*rest/i);
    expect(partial.body).not.toContain("of 0");
    const legacy = messageFor(
      { ...event, request: { ...request, accountId: null, evidence: null } },
      null,
    );
    expect(legacy.body).not.toContain("null");
    expect(legacy.body).not.toContain("0 products");
    expect(legacy.body).toMatch(/recorded|existing/i);
  });

  it("keeps the complete decline note, escapes its HTML and explains the fix before the action", () => {
    const reason = 'Use the trading name <Nuanu> & keep "shop".\nThen ask again.';
    const message = messageFor({
      ...event,
      kind: "declined",
      request: {
        ...request,
        state: "declined",
        decline: {
          sequence: 23,
          at: askedAt + 3600_000,
          actor: { kind: "account", id: "acc_operator" },
          action: "decline",
          subject: { kind: "merchant", id: request.merchantId },
          outcome: { kind: "done" },
          reason,
        },
      },
    });
    expect(message.body).toContain(reason);
    expect(message.body).toContain("2026-10-30 15:00:00 UTC");
    expect(message.html).toContain("&lt;Nuanu&gt; &amp; keep &quot;shop&quot;");
    expect(message.html).not.toContain("<Nuanu>");
    expect(message.html).toMatch(
      /Use the trading name &lt;Nuanu&gt; &amp; keep &quot;shop&quot;\.\nThen ask again\.[\s\S]*Fix what the note asks, then ask again from your dashboard\.[\s\S]*<a\b[^>]*>Ask again in your dashboard<\/a>/,
    );
    expect(message.body).not.toContain("/admin/");
  });

  it("names the saved code contact without inventing products or a current connection", () => {
    const message = messageFor({
      ...event,
      hasWallet: true,
      request: {
        ...request,
        evidence: { integration: "api", connectedAt: askedAt - 24 * 3600_000 },
      },
    });
    expect(message.body).toContain("2026-10-29 14:00:00 UTC");
    expect(message.body).not.toContain("No payout wallet");
    expect(message.body).not.toContain("products");
  });
});
