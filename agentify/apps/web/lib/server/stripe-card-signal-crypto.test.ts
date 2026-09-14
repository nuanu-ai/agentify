import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decryptPaymentMethodId,
  encryptPaymentMethodId,
  localWebhookSignature,
  verifyLocalWebhookSignature,
} from "./stripe-card-signal-crypto";

describe("card signal cryptography", () => {
  it("encrypts payment method IDs with authenticated random ciphertext", () => {
    const key = randomBytes(32);
    const first = encryptPaymentMethodId("pm_local_secret", key);
    const second = encryptPaymentMethodId("pm_local_secret", key);
    expect(first).not.toBe(second);
    expect(first).not.toContain("pm_local_secret");
    expect(decryptPaymentMethodId(first, key)).toBe("pm_local_secret");
    expect(() =>
      decryptPaymentMethodId(`${first.slice(0, -1)}x`, key),
    ).toThrow();
  });

  it("verifies timestamped local webhook signatures and rejects tampering", () => {
    const now = Date.UTC(2026, 6, 12, 10, 0, 0);
    const body = '{"id":"evt_test"}';
    const signature = localWebhookSignature(body, "test-secret", now / 1000);
    expect(() =>
      verifyLocalWebhookSignature(body, signature, "test-secret", now),
    ).not.toThrow();
    expect(() =>
      verifyLocalWebhookSignature(`${body} `, signature, "test-secret", now),
    ).toThrow("stripe_signature_invalid");
    expect(() =>
      verifyLocalWebhookSignature(
        body,
        signature,
        "test-secret",
        now + 301_000,
      ),
    ).toThrow("stripe_signature_expired");
  });
});
