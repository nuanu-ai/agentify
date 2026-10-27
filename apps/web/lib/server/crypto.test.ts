import { describe, expect, it } from "vitest";

import {
  decryptSensitiveValue,
  deriveCapability,
  encryptSensitiveValue,
  normalizeEmail,
  sha256,
} from "./crypto";

describe("private capability and email crypto", () => {
  it("encrypts email with randomized authenticated ciphertext", () => {
    const key = Buffer.alloc(32, 7);
    const first = encryptSensitiveValue("owner@example.com", key);
    const second = encryptSensitiveValue("owner@example.com", key);
    expect(first).not.toBe(second);
    expect(first).not.toContain("owner@example.com");
    expect(decryptSensitiveValue(first, key)).toBe("owner@example.com");
    expect(() => decryptSensitiveValue(first, Buffer.alloc(32, 8))).toThrow();
    for (const field of [2, 3]) {
      const parts = first.split(".");
      const bytes = Buffer.from(parts[field] ?? "", "base64url");
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      parts[field] = bytes.toString("base64url");
      expect(() => decryptSensitiveValue(parts.join("."), key)).toThrow();
    }
  });

  it("normalizes lookup input and derives a 256-bit opaque capability", () => {
    expect(normalizeEmail(" OWNER@Example.COM ")).toBe("owner@example.com");
    const capability = deriveCapability("a".repeat(32), "scan", "id");
    expect(Buffer.from(capability, "base64url")).toHaveLength(32);
    expect(capability).toBe("Pt5CWDerDB6FFsLs95Kbkmk2vZ7c0evR_hSlvLgwgSg");
    expect(sha256(capability)).toBe(
      "e20521237766a8aa11da2f464cabd1b393a6acc846a4e82a0ee4334e90749e2b",
    );
    expect(deriveCapability("b".repeat(32), "scan", "id")).not.toBe(capability);
    expect(deriveCapability("a".repeat(32), "scan", "other-id")).not.toBe(capability);
    expect(deriveCapability("a".repeat(32), "scan-id")).not.toBe(capability);
  });
});
