import { afterEach, describe, expect, it, vi } from "vitest";

import { cookieHeader, readCookie } from "./cookies";

afterEach(() => {
  vi.useRealTimers();
});

const withCookie = (cookie: string) => new Request("https://agentify.ad/", { headers: { cookie } });

describe("a cookie the scanner reads", () => {
  it("is found by its name among the others, decoded", () => {
    expect(
      readCookie(withCookie("theme=dark; agentify_anonymous=a%20b; x=1"), "agentify_anonymous"),
    ).toBe("a b");
  });

  it("is the last one where a name is sent twice", () => {
    expect(
      readCookie(
        withCookie("agentify_anonymous=first; agentify_anonymous=second"),
        "agentify_anonymous",
      ),
    ).toBe("second");
  });

  it("is not there where it was not sent, or cannot be decoded", () => {
    expect(readCookie(withCookie("theme=dark"), "agentify_anonymous")).toBeUndefined();
    expect(readCookie(new Request("https://agentify.ad/"), "agentify_anonymous")).toBeUndefined();
    expect(
      readCookie(withCookie("agentify_anonymous=%E0%A4%A"), "agentify_anonymous"),
    ).toBeUndefined();
  });
});

describe("a cookie the scanner sets", () => {
  it("lasts as long by its expiry as by its age, so a browser reading either keeps it", () => {
    vi.useFakeTimers({ now: new Date("2026-10-13T00:00:00Z") });

    const header = cookieHeader("agentify_anonymous", "a b", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 60,
    });
    expect(header.split(/;\s*/)).toEqual(
      expect.arrayContaining([
        "agentify_anonymous=a%20b",
        expect.stringMatching(/^path=\/$/i),
        expect.stringMatching(/^expires=Tue, 13 Oct 2026 00:01:00 GMT$/i),
        expect.stringMatching(/^max-age=60$/i),
        expect.stringMatching(/^secure$/i),
        expect.stringMatching(/^httponly$/i),
        expect.stringMatching(/^samesite=lax$/i),
      ]),
    );
  });

  it("is cleared with an age of nothing and no expiry", () => {
    const header = cookieHeader("agentify_anonymous", "", {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 0,
    });
    expect(header.split(/;\s*/)).toEqual(
      expect.arrayContaining([
        "agentify_anonymous=",
        expect.stringMatching(/^path=\/$/i),
        expect.stringMatching(/^max-age=0$/i),
        expect.stringMatching(/^httponly$/i),
        expect.stringMatching(/^samesite=lax$/i),
      ]),
    );
    expect(header).not.toMatch(/(?:^|;)\s*expires=/i);
  });
});
