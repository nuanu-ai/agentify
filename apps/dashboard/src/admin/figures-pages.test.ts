import { createRequire } from "node:module";

/**
 * Overview, Money and Health served over HTTP to an operator, as a browser
 * with no script reads them: every page says when its figures were read, and
 * a Check now press is answered with the page carrying the check's answer.
 * The channel's facilitator here is the sandbox's, so the key check asks
 * nobody; nothing here reaches the network.
 */

import { asTyped } from "@agentify/ui/units";
import { decodeFunctionData, type Hex, parseAbi } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AdminServed, adminServed } from "../testing/admin.js";
import { readable } from "../testing/html.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: { document: Document } };
};
const documentOf = (html: string) => new JSDOM(html).window.document;

const OPERATOR = "operator@example.com";
const SECOND = "second@example.com";
const AS_OPERATOR = { confirm: "yes", reason: "Joins the team that looks after the channel" };

let served: AdminServed | null = null;

afterEach(async () => {
  vi.useRealTimers();
  await served?.close();
  served = null;
});

const anOperator = async () => {
  served = await adminServed();
  return await served.signedIn(OPERATOR, { operator: true });
};

describe("the figures' pages", () => {
  it("draw the overview's figures, chart and funnel, each with when it was read", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-24T09:00:00Z") });
    served = await adminServed();
    const operator = await served.signedIn(OPERATOR, { operator: true });
    const { harnessed } = served;
    harnessed.advance(Date.now() - harnessed.now());
    await harnessed.store.noteContact(harnessed.merchant.id, harnessed.now());
    const published = await harnessed.gateway.publishCard(harnessed.merchant.id, {
      merchant_item_id: "room-101",
      title: "A room for the night",
      description: "One night in a room",
      price: { amount: "80.00", currency: "USD" },
      result: { access_code: { type: "string" } },
      fulfillment: "async",
      fulfill_deadline_seconds: 3600,
    });
    if (!published.ok) throw new Error("the product was refused");
    const offered = await harnessed.gateway.beginPurchase(published.id, {});
    if (offered.step !== "pay") throw new Error("the purchase was refused");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");
    const html = (await operator.get("/admin")).html;
    const page = documentOf(html);
    const tile = (label: string) =>
      [...page.querySelectorAll(".tile")].find(
        (one) => asTyped(one.querySelector(".label")?.textContent ?? "") === label,
      );
    expect(tile("Merchants selling")?.querySelector(".figure")?.textContent).toBe("1of 2");
    expect(tile("Orders · 7 days")?.querySelector(".figure")?.textContent).toBe("1");
    expect(tile("Settled · 7 days")?.querySelector(".figure")?.textContent).toBe("80.00USD");
    expect(page.querySelector(".op-asof .when")?.textContent).toBe("2026-10-24 09:00:00 UTC");
    const chart = page.querySelector('[aria-labelledby="sales-title"] svg');
    expect(chart).not.toBeNull();
    expect(chart?.getAttribute("aria-label")).toMatch(/80\.00\sUSD in all/);
    expect(
      [...(chart?.querySelectorAll("rect") ?? [])].some(
        (bar) => Number(bar.getAttribute("height")) > 2,
      ),
    ).toBe(true);
    const steps = page.querySelectorAll('[aria-labelledby="funnel-title"] ol li');
    expect(steps.length).toBeGreaterThan(0);
    expect([...steps].some((step) => step.querySelector(".n")?.textContent === "1")).toBe(true);
  });

  it("say the overview's latest journal rows in the Journal's own words", async () => {
    served = await adminServed();
    const operator = await served.signedIn(OPERATOR, { operator: true });
    await served.signedIn(SECOND);
    const id = (await served.identity.byEmail(SECOND))?.id ?? "";
    await operator.post(`/admin/accounts/${id}/grant-operator`, AS_OPERATOR);

    const overview = readable((await operator.get("/admin")).html);
    const journal = readable((await operator.get("/admin/journal")).html);

    const said = `Made ${SECOND} an operator`;
    expect(journal).toContain(said);
    expect(overview).toContain(said);
  });

  it("draw the overview's and the Journal's rows by identifier where the addresses cannot be read", async () => {
    let addressesRead = true;
    served = await adminServed({
      identity: (real) => ({
        ...real,
        accountsNamed: async (named) => {
          if (!addressesRead) throw new Error("the connection dropped");
          return await real.accountsNamed(named);
        },
      }),
    });
    const operator = await served.signedIn(OPERATOR, { operator: true });
    await served.signedIn(SECOND);
    const id = (await served.identity.byEmail(SECOND))?.id ?? "";
    await operator.post(`/admin/accounts/${id}/grant-operator`, AS_OPERATOR);
    addressesRead = false;

    for (const path of ["/admin", "/admin/journal"]) {
      const page = readable((await operator.get(path)).html);
      expect(page).toContain(id);
      expect(page).toContain("an operator");
      expect(page).not.toContain("a deleted account");
      expect(page).not.toContain(SECOND);
    }
  });

  it("draw Money with its splits and the operator's payout", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-10-24T09:00:00Z") });
    served = await adminServed({ channel: "live" });
    const operator = await served.signedIn(OPERATOR, { operator: true });
    const split = (await served.harnessed.store.merchantById(served.harnessed.merchant.id))
      ?.payoutWallet.split;
    expect(split).toBeDefined();
    const page = documentOf((await operator.get("/admin/money?period=7d")).html);
    expect(page.querySelector(".op-asof .when")?.textContent).toBe("2026-10-24 09:00:00 UTC");
    const payout = page.querySelector('[aria-labelledby="payout-title"]');
    expect(payout?.textContent).toContain(served.harnessed.merchant.wallet);
    expect(payout?.textContent).toContain(split?.address);
    expect(payout?.textContent).toContain(served.harnessed.runtime.config.payoutSplit.multicall3);
    const data = payout?.querySelector("textarea")?.textContent;
    expect(data).toMatch(/^0x82ad56cb[0-9a-f]+$/);
    const decoded = decodeFunctionData({
      abi: parseAbi([
        "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
      ]),
      data: data as Hex,
    });
    expect(
      decoded.args[0].filter((call) => call.target.toLowerCase() === split?.address.toLowerCase()),
    ).toHaveLength(1);
  });

  it("answer a Check now press with Health carrying the check's answer", async () => {
    const operator = await anOperator();

    const pressed = await operator.post("/admin/health", { check: "key" });

    expect(pressed.status).toBe(200);
    expect(readable(pressed.html)).toContain("is not Coinbase's facilitator");
  });
});
