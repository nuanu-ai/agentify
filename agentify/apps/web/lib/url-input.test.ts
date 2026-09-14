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
    ["http://localhost", "Enter a public website domain"],
    [
      "https://example.com/?auth=secret",
      "Remove secret or authentication parameters",
    ],
  ])("rejects %s", (input, expectedMessage) => {
    const result = validateSubmittedUrl(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(expectedMessage);
  });

  it("removes fragments before sending a URL to the server", () => {
    expect(validateSubmittedUrl("https://example.com/path#private")).toEqual({
      ok: true,
      normalized: "https://example.com/path",
      submittedWithoutScheme: false,
    });
  });
});
