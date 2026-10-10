import { describe, expect, it } from "vitest";

import { validateSubmittedUrl } from "./url-input";

describe("landing URL syntax validation", () => {
  it("accepts a bare public domain and supplies HTTPS", () => {
    expect(validateSubmittedUrl("example.com")).toEqual({
      ok: true,
      normalized: "https://example.com/",
      submittedWithoutScheme: true,
    });
  });

  it.each([
    ["file:///etc/passwd", "Only public HTTP or HTTPS URLs"],
    ["https://user:secret@example.com", "Remove the username or password"],
    ["http://example.com:3000", "Only standard web ports"],
    ["https://example.com/?auth=secret", "Remove secret or authentication parameters"],
  ])("rejects %s", (input, expectedMessage) => {
    const result = validateSubmittedUrl(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(expectedMessage);
  });

  // An address that can never be scanned is refused here, in words that say
  // what to type instead, rather than after a scan has been opened for it.
  it.each([
    "127.0.0.1",
    "http://10.0.0.8/",
    "2130706433",
    "[::1]",
    "https://[2001:db8::1]/",
    "localhost",
    "http://localhost",
    "shop",
    "shop.",
  ])("refuses %s and names an address to type instead", (input) => {
    const result = validateSubmittedUrl(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/example\.com/);
  });

  it("removes fragments before sending a URL to the server", () => {
    expect(validateSubmittedUrl("https://example.com/path#private")).toEqual({
      ok: true,
      normalized: "https://example.com/path",
      submittedWithoutScheme: false,
    });
  });
});
