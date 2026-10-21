/**
 * How a log line names an order. The identifier is the key to the order and
 * its goods, and logs are read by more people than the database, so the line
 * carries a fingerprint: the same for every line about one order, different
 * between orders, and found from the identifier by the query the operator's
 * runbook gives, which computes the identifier's SHA-256.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { orderFingerprint } from "./order-fingerprint.js";

/** An identifier in the shape the gateway issues. */
const ORDER_ID = "ord_7c1e05a9c4d84f0b9e2d6c3b1a8f5e47";

describe("an order's fingerprint in the log", () => {
  it("is the same for every line about one order", () => {
    expect(orderFingerprint(ORDER_ID)).toBe(orderFingerprint(ORDER_ID));
  });

  it("tells ten thousand orders apart", () => {
    const orderIds = Array.from(
      { length: 10_000 },
      (_, n) => `ord_${n.toString(16).padStart(32, "0")}`,
    );

    expect(new Set(orderIds.map(orderFingerprint)).size).toBe(orderIds.length);
  });

  it("carries no part of the identifier it stands for", () => {
    const written = orderFingerprint(ORDER_ID);

    expect(written).not.toContain(ORDER_ID);
    expect(written).not.toContain(ORDER_ID.slice("ord_".length, "ord_".length + 8));
    expect(written).not.toMatch(/ord_[0-9a-f]/);
  });

  it("is the first twelve hex characters of the identifier's SHA-256, as the runbook's query reads it", () => {
    const digest = createHash("sha256").update(ORDER_ID, "utf8").digest("hex");

    expect(orderFingerprint(ORDER_ID)).toBe(`order ${digest.slice(0, 12)}`);
  });
});
