import { describe, expect, it } from "vitest";

import {
  SCANNER_AUTH_LINK_TTL_SECONDS,
  scannerAuthEmail,
} from "./scanner-auth-email";

function hrefFrom(html: string): string {
  const value = html.match(/href="([^"]+)"/)?.[1];
  if (!value) throw new Error("email_action_link_missing");
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

describe("scanner auth email", () => {
  it.each(["registration", "recovery"] as const)(
    "keeps the %s capability link intact in HTML and plain text",
    (purpose) => {
      const url =
        'https://agentify.ad/auth/callback#state=demo&token=unsafe"<>&value';
      const email = scannerAuthEmail(purpose, url);

      expect(hrefFrom(email.html)).toBe(url);
      expect(email.text).toContain(url);
      expect(email.html).toContain("&amp;token=");
      expect(email.html).not.toContain('token=unsafe"<');
    },
  );

  it.each(["registration", "recovery"] as const)(
    "states the one-hour lifetime for a %s link in both alternatives",
    (purpose) => {
      const email = scannerAuthEmail(
        purpose,
        "https://agentify.ad/auth/callback#state=demo&token=demo",
      );

      expect(SCANNER_AUTH_LINK_TTL_SECONDS).toBe(60 * 60);
      expect(email.text).toMatch(/one hour/i);
      expect(email.html).toMatch(/one hour/i);
    },
  );

  it("distinguishes first-time confirmation from access recovery", () => {
    const url = "https://agentify.ad/auth/callback#state=demo&token=demo";
    const registration = scannerAuthEmail("registration", url);
    const recovery = scannerAuthEmail("recovery", url);

    expect(registration.text).toMatch(/confirm/i);
    expect(recovery.text).toMatch(/recover/i);
    expect(registration).not.toEqual(recovery);
  });
});
