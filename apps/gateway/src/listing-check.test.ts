/**
 * The listing check the operator runs from Health: what it checked, what came
 * back and when, with no wallet address left in what it hands the screen. The
 * catalog, the door and the validator are stand-ins; nothing here reaches the
 * network.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { checkListingNow, overTheNetwork, type Reach } from "./listing-check.js";

const AT = Date.parse("2026-10-24T09:00:00.000Z");
const BASE = "https://agentify.example";
const PAY_TO = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const TRANSACTION = `0x${"ab".repeat(32)}`;

/** A challenge naming the purchase as a POST, as the door promises. */
const challenge = encodePaymentRequiredHeader({
  x402Version: 2,
  resource: { url: `${BASE}/x402/itm_1/purchase` },
  accepts: [],
  extensions: { bazaar: { info: { input: { method: "POST" } } } },
} as unknown as Parameters<typeof encodePaymentRequiredHeader>[0]);

const reachWith = (validated: unknown, status = 200): Reach => ({
  catalog: async () => ({ items: [{ id: "itm_1" }] }),
  door: async () => ({ kind: "answered", status: 402, challenge }),
  validate: async () => ({ kind: "answered", status, body: validated }),
});

describe("checking the listing now", () => {
  it("says what it checked and when, and passes only where every probe was accepted", async () => {
    const checked = await checkListingNow(`${BASE}/`, reachWith({ valid: true }), () => AT);

    expect(checked.checkedAt).toBe(AT);
    expect(checked.kind).toBe("checked");
    if (checked.kind !== "checked") return;
    expect(checked.passed).toBe(true);
    expect(checked.probes).toBe(2);
    expect(
      checked.resources.map((each) => ("resource" in each ? each.resource : null)),
    ).toStrictEqual([`${BASE}/x402/itm_1/purchase`]);
  });

  it("does not pass a probe nobody gave a verdict on", async () => {
    const checked = await checkListingNow(BASE, reachWith("<html>", 503), () => AT);

    expect(checked.kind === "checked" && checked.passed).toBe(false);
    expect(checked.kind === "checked" && checked.unanswered.length).toBe(1);
  });

  it("replaces every wallet address in what came back with the words a wallet, and keeps a transaction", async () => {
    const checked = await checkListingNow(
      BASE,
      reachWith({
        valid: false,
        errors: [`payTo ${PAY_TO} is not accepted`, { lower: PAY_TO.toLowerCase(), TRANSACTION }],
      }),
      () => AT,
    );

    const shown = JSON.stringify(checked);
    expect(shown).not.toMatch(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/);
    expect(shown).toContain("payTo a wallet is not accepted");
    expect(shown).toContain(TRANSACTION);
  });

  it("stops when its time is up, and names every product it did not check rather than passing them", async () => {
    // The operator's request waits on this check; a catalog of any size, or a
    // door that never answers, must not hold it open.
    const stalled: Reach = {
      ...reachWith({ valid: true }),
      catalog: async () => ({ items: [{ id: "itm_1" }, { id: "itm_2" }, { id: "itm_3" }] }),
      door: async (resource) =>
        resource.includes("itm_2")
          ? await new Promise<never>(() => undefined)
          : { kind: "answered", status: 402, challenge },
    };

    const checked = await checkListingNow(BASE, stalled, () => AT, 100);

    expect(checked.kind).toBe("checked");
    if (checked.kind !== "checked") return;
    expect(checked.passed).toBe(false);
    expect(checked.unchecked).toStrictEqual(["itm_2", "itm_3"]);
    expect(checked.resources.map((each) => each.itemId)).toStrictEqual(["itm_1"]);
  });

  it("says the catalog could not be read when it does not answer in time", async () => {
    const stalled: Reach = {
      ...reachWith({ valid: true }),
      catalog: async () => await new Promise<never>(() => undefined),
    };

    const checked = await checkListingNow(BASE, stalled, () => AT, 100);

    expect(checked.kind).toBe("catalog_unreadable");
  });

  it("gives up on a fetch that does not answer in time, as no verdict, and on a catalog that does not", async () => {
    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const at = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
    try {
      const reach = overTheNetwork(100);

      expect(await reach.door(`${at}/x402/itm_1/purchase`)).toMatchObject({
        kind: "unreachable",
        why: "no answer within 0.1 seconds",
      });
      await expect(reach.catalog(at)).rejects.toThrow("no answer within 0.1 seconds");
    } finally {
      silent.closeAllConnections();
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  it("says the catalog could not be read rather than checking nothing quietly", async () => {
    const unreadable: Reach = {
      ...reachWith({ valid: true }),
      catalog: async () => {
        throw new Error("https://agentify.example/catalog answered 502");
      },
    };

    const checked = await checkListingNow(BASE, unreadable, () => AT);

    expect(checked).toStrictEqual({
      kind: "catalog_unreadable",
      base: BASE,
      why: "https://agentify.example/catalog answered 502",
      checkedAt: AT,
    });
  });
});
