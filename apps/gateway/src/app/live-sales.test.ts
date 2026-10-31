import { describe, expect, it } from "vitest";
import { MemoryStore } from "../adapters/memory/store.js";
import type { JournalPress } from "../ports/journal.js";
import type { LiveSalesAsk, LiveSalesEffect } from "../ports/live-sales.js";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "../split/networks.js";
import { payoutSplitFor } from "../split/parameters.js";
import { countedIds } from "../testing/harness.js";
import { declineLiveSales, requestLiveSales } from "./live-sales.js";

const at = Date.parse("2026-10-30T14:00:00Z");
const input = {
  merchantId: "mch_one",
  accountId: "acc_one",
  sellerName: "Freeland",
  evidence: { integration: "api" as const, connectedAt: at - 1000 },
};
const press = (reason: string): JournalPress => ({
  at: at + 1000,
  action: "decline",
  actor: { kind: "account", id: "acc_operator" },
  subject: { kind: "merchant", id: input.merchantId },
  reason,
});
async function setup(refuse = false) {
  const notices: LiveSalesEffect[] = [];
  const store = new MemoryStore("eip155:8453", countedIds(), () => at, undefined, {
    stage(notice) {
      if (refuse) throw new Error("notice unavailable");
      return () => notices.push(notice);
    },
  });
  await store.addMerchant({ id: input.merchantId, name: "Merchant" }, at - 1000);
  return { store, notices };
}

describe("a merchant's live-sales request", () => {
  it("records one admission effect and refuses the admission if it cannot retain the effect", async () => {
    const refused = await setup(true);
    await expect(refused.store.grantLiveApproval(input.merchantId, at)).rejects.toThrow(
      "notice unavailable",
    );
    expect((await refused.store.merchantById(input.merchantId))?.liveApprovedAt).toBeNull();
    const { store, notices } = await setup();
    const grants = await Promise.all(
      Array.from({ length: 5 }, () => store.grantLiveApproval(input.merchantId, at)),
    );
    expect(grants.filter((grant) => grant?.changed)).toHaveLength(1);
    expect(notices).toMatchObject([
      { kind: "admitted", merchantId: input.merchantId, hasWallet: false, sellerName: null },
    ]);
    const note = "Fix your seller name.\nUse the name customers know.";
    await store.withdrawLiveApproval(input.merchantId, { ...press(note), action: "withdraw" });
    await store.withdrawLiveApproval(input.merchantId, { ...press(note), action: "withdraw" });
    expect(notices.map((notice) => notice.kind)).toEqual(["admitted", "withdrawn"]);
    expect(notices[1]).toMatchObject({ reason: note });
  });

  it("leaves a first wallet and split absent when its post-approval publication cannot be retained", async () => {
    const store = new MemoryStore("eip155:8453", countedIds(), () => at, undefined, {
      stage(event) {
        if (event.kind === "first_wallet") throw new Error("publication unavailable");
        return () => {};
      },
    });
    await store.addMerchant({ id: input.merchantId, name: "Merchant" }, at);
    await store.grantLiveApproval(input.merchantId, at);
    const address = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const split = payoutSplitFor(
      payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:8453"),
      input.merchantId,
      address,
    );
    await expect(
      store.setPayoutWallet(
        input.merchantId,
        { address: null, pending: null },
        { address, split, pending: null },
        at + 100,
      ),
    ).rejects.toThrow("publication unavailable");
    expect((await store.merchantById(input.merchantId))?.payoutWallet.address).toBeNull();
    expect(await store.payoutSplitAt(split.address)).toBeNull();
  });
  it("counts a stored request and decline once, never a retry or a rolled-back request", async () => {
    const { store } = await setup();
    await requestLiveSales(store, input, at, "live");
    await requestLiveSales(store, input, at + 1, "live");
    const request = await store.liveSalesRequest(input.merchantId);
    if (!request) throw new Error("request missing");
    await declineLiveSales(store, input.merchantId, request.id, press("Private operator note"));
    await declineLiveSales(store, input.merchantId, request.id, press("Repeated note"));
    expect(store.recordedAnalytics.map(({ event }) => event)).toEqual([
      {
        name: "agc_setup_result",
        actor: "human",
        source: "dashboard",
        refs: { merchant: input.merchantId, person: input.accountId },
        fields: { step: "live_request", integration: "api", outcome: "completed" },
      },
      {
        name: "agc_setup_result",
        actor: "operator",
        source: "dashboard",
        refs: { merchant: input.merchantId },
        fields: { step: "live_decline", integration: "api", outcome: "completed" },
      },
    ]);
    const refused = await setup(true);
    await expect(requestLiveSales(refused.store, input, at, "live")).rejects.toThrow();
    expect(refused.store.recordedAnalytics).toEqual([]);
  });

  it("accepts without a wallet and keeps a repeated request's date and evidence", async () => {
    const { store, notices } = await setup();
    const first = await requestLiveSales(store, input, at, "live");
    expect(first.kind).toBe("requested");
    const pending = await requestLiveSales(
      store,
      { ...input, evidence: { integration: "api", connectedAt: at + 100 } },
      at + 200,
      "live",
    );
    expect(pending.kind).toBe("pending");
    await store.switchIntegration(input.merchantId, "woocommerce");
    expect(
      (
        await requestLiveSales(
          store,
          { ...input, sellerName: "", evidence: null },
          at + 300,
          "live",
        )
      ).kind,
    ).toBe("pending");
    expect(await store.liveSalesRequest(input.merchantId)).toMatchObject({
      requestedAt: at,
      evidence: input.evidence,
      state: "pending",
      reminderDueAt: Date.parse("2026-11-03T14:00:00Z"),
    });
    expect((await store.merchantById(input.merchantId))?.payoutWallet.address).toBeNull();
    expect(notices).toHaveLength(1);
  });
  it("rolls back the name and request when its notice cannot be retained", async () => {
    const { store } = await setup(true);
    await expect(requestLiveSales(store, input, at, "live")).rejects.toThrow("notice unavailable");
    expect(await store.liveSalesRequest(input.merchantId)).toBeNull();
    expect((await store.merchantById(input.merchantId))?.serviceName).toBeNull();
  });
  it("keeps the full decline note and creates a new request only when asked again", async () => {
    const { store, notices } = await setup();
    await requestLiveSales(store, input, at, "live");
    const request = await store.liveSalesRequest(input.merchantId);
    if (!request) throw new Error("request missing");
    const note = "Please correct the seller name.\nUse the name buyers know.";
    await declineLiveSales(store, input.merchantId, request.id, press(note));
    expect(await store.liveSalesRequest(input.merchantId)).toMatchObject({
      state: "declined",
      decline: { reason: note, outcome: { kind: "done" } },
    });
    await requestLiveSales(store, input, at + 2000, "live");
    const again = await store.liveSalesRequest(input.merchantId);
    expect(again?.id).not.toBe(request?.id);
    expect(again?.requestedAt).toBe(at + 2000);
    await declineLiveSales(store, input.merchantId, request.id, press("Stale form"));
    expect((await store.liveSalesRequest(input.merchantId))?.state).toBe("pending");
    expect(notices.map((n) => n.kind)).toEqual(["requested", "declined", "requested"]);
  });
  it.each(["", "   "])(
    "refuses an empty decline note without changing the request (%j)",
    async (reason) => {
      const { store, notices } = await setup();
      await requestLiveSales(store, input, at, "live");
      const request = await store.liveSalesRequest(input.merchantId);
      if (!request) throw new Error("request missing");
      await expect(
        declineLiveSales(store, input.merchantId, request.id, press(reason)),
      ).rejects.toThrow();
      expect((await store.liveSalesRequest(input.merchantId))?.state).toBe("pending");
      expect(notices).toHaveLength(1);
    },
  );
  it("manual admission needs neither request, name nor wallet; admission resolves a pending request", async () => {
    const { store } = await setup();
    await store.addMerchant({ id: "mch_manual", name: "Merchant" }, at);
    expect(await store.grantLiveApproval("mch_manual", at)).toMatchObject({
      changed: true,
      merchant: { serviceName: null, payoutWallet: { address: null } },
    });
    await requestLiveSales(store, input, at, "live");
    await store.grantLiveApproval(input.merchantId, at + 1000);
    expect((await store.liveSalesRequest(input.merchantId))?.state).toBe("admitted");
  });
  it("refuses requests on test and invalid names before storing anything", async () => {
    const { store, notices } = await setup();
    await expect(requestLiveSales(store, input, at, "test")).rejects.toThrow();
    await expect(
      requestLiveSales(store, { ...input, sellerName: "" }, at, "live"),
    ).rejects.toThrow();
    expect(await store.liveSalesRequest(input.merchantId)).toBeNull();
    expect(notices).toEqual([]);
  });
  it.each([
    ["2026-10-26T14:00:00Z", "2026-10-28T14:00:00Z"],
    ["2026-10-29T23:59:59Z", "2026-11-02T23:59:59Z"],
    ["2026-10-31T01:00:00Z", "2026-11-03T01:00:00Z"],
    ["2026-11-01T01:00:00Z", "2026-11-03T01:00:00Z"],
  ])("dates its single reminder two UTC weekdays after %s", async (asked, due) => {
    const { store } = await setup();
    await requestLiveSales(store, input, Date.parse(asked), "live");
    expect((await store.liveSalesRequest(input.merchantId))?.reminderDueAt).toBe(Date.parse(due));
  });

  it.each(["integration", "host", "checkedAt", "ready", "read", "total", "complete"])(
    "refuses fresh shop evidence missing %s with an intelligible error",
    async (field) => {
      const { store, notices } = await setup();
      await store.switchIntegration(input.merchantId, "woocommerce");
      const evidence: Record<string, unknown> = {
        integration: "woocommerce",
        host: "woo.nuanu.ai",
        checkedAt: at - 1000,
        ready: 1,
        read: 2,
        total: 2,
        complete: true,
      };
      delete evidence[field];
      await expect(
        requestLiveSales(store, { ...input, evidence } as LiveSalesAsk, at, "live"),
      ).rejects.toThrow(/\S/);
      expect(await store.liveSalesRequest(input.merchantId)).toBeNull();
      expect(notices).toHaveLength(0);
    },
  );

  it("refuses absent code contact and missing requester or name on a new request", async () => {
    const { store } = await setup();
    for (const change of [
      { evidence: { integration: "api" } },
      { accountId: undefined },
      { sellerName: undefined },
      { evidence: null },
    ]) {
      await expect(
        requestLiveSales(store, { ...input, ...change } as LiveSalesAsk, at, "live"),
      ).rejects.toThrow(/\S/);
      expect(await store.liveSalesRequest(input.merchantId)).toBeNull();
    }
  });
});
