import { describe, expect, it } from "vitest";
import { merchantApplicationSchema } from "./merchant-application.js";

describe("merchant application contract", () => {
  const valid = {
    businessName: "Example shop",
    website: "https://example.com",
    email: "OWNER@example.com",
    category: "retail",
    country: "Indonesia",
    consent: true,
  };
  it("normalizes email and optional fields", () => {
    expect(merchantApplicationSchema.parse(valid)).toMatchObject({
      email: "owner@example.com",
      offer: "",
      companyFax: "",
    });
  });
  it("requires explicit consent and rejects unknown fields and unsupported URLs", () => {
    for (const invalid of [
      { ...valid, consent: false },
      { ...valid, extra: "unknown" },
      { ...valid, website: "file:///etc/passwd" },
      { ...valid, website: "https://user:password@example.com" },
    ])
      expect(merchantApplicationSchema.safeParse(invalid).success).toBe(false);
  });
});
