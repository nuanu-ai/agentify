/**
 * The listing check the operator runs from Health: what it checked, what came
 * back and when, with no wallet address left in what it hands the screen. The
 * catalog, the door and the validator are stand-ins; nothing here reaches the
 * network.
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkListingNow, overTheNetwork, type Reach } from "./listing-check.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

  it("redacts nested wallet addresses while preserving transaction evidence", async () => {
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
    expect(shown).toContain("payTo");
    expect(shown).toContain("is not accepted");
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

    vi.useFakeTimers();
    let completed = false;
    const pending = checkListingNow(BASE, stalled, () => AT).then((value) => {
      completed = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const checked = await pending;

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

    vi.useFakeTimers();
    let completed = false;
    const pending = checkListingNow(BASE, stalled, () => AT).then((value) => {
      completed = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const checked = await pending;

    expect(checked.kind).toBe("catalog_unreadable");
  });

  it("aborts unanswered real HTTP door and catalog fetches at the shipped ten-second deadline", async () => {
    let arrived = 0;
    let bothArrived: () => void = () => undefined;
    const requests = new Promise<void>((resolve) => {
      bothArrived = resolve;
    });
    const silent = createServer(() => {
      if (++arrived === 2) bothArrived();
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const at = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("deadline elapsed", "TimeoutError")), ms);
      return controller.signal;
    });
    try {
      const reach = overTheNetwork();
      let completed = 0;
      const door = reach.door(`${at}/x402/itm_1/purchase`).then((value) => {
        completed++;
        return value;
      });
      const catalog = reach.catalog(at).catch((error: unknown) => {
        completed++;
        return error;
      });
      await requests;
      await vi.advanceTimersByTimeAsync(9_999);
      expect(completed).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(await door).toMatchObject({
        kind: "unreachable",
        why: expect.stringMatching(/10.*seconds/),
      });
      expect(await catalog).toBeInstanceOf(Error);
      expect(String(await catalog)).toMatch(/10.*seconds/);
    } finally {
      vi.useRealTimers();
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
