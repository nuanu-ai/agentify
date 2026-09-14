import { describe, expect, it } from "vitest";

import {
  decryptEmail,
  deriveCapability,
  encryptEmail,
  normalizeEmail,
  sha256,
} from "./crypto";

describe("private capability and email crypto", () => {
  it("encrypts email with randomized authenticated ciphertext", () => {
    const key = Buffer.alloc(32, 7);
    const first = encryptEmail("owner@example.com", key);
    const second = encryptEmail("owner@example.com", key);
    expect(first).not.toBe(second);
    expect(first).not.toContain("owner@example.com");
    expect(decryptEmail(first, key)).toBe("owner@example.com");
  });

  it("normalizes lookup input and derives a 256-bit opaque capability", () => {
    expect(normalizeEmail(" OWNER@Example.COM ")).toBe("owner@example.com");
    const capability = deriveCapability("a".repeat(32), "scan", "id");
    expect(Buffer.from(capability, "base64url")).toHaveLength(32);
    expect(sha256(capability)).toMatch(/^[a-f0-9]{64}$/);
  });
});
