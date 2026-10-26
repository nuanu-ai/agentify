// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { rememberZone } from "./remember-zone.js";
import { ZONE_COOKIE, zoneIn } from "./zone.js";

const browserIn = (zone: string) =>
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
    ...new Intl.DateTimeFormat().resolvedOptions(),
    timeZone: zone,
  });

afterEach(() => {
  vi.restoreAllMocks();
  // biome-ignore lint/suspicious/noDocumentCookie: the test clears the one cookie the module writes
  document.cookie = `${ZONE_COOKIE}=; Path=/; Max-Age=0`;
});

describe("a browser's zone", () => {
  it("is named for the pages drawn after this one", () => {
    browserIn("Asia/Makassar");
    rememberZone();
    vi.restoreAllMocks();
    expect(zoneIn(document.cookie)).toBe("Asia/Makassar");
  });

  it("is named again once the browser has moved to another zone", () => {
    browserIn("Asia/Makassar");
    rememberZone();
    vi.restoreAllMocks();
    browserIn("Europe/Lisbon");
    rememberZone();
    vi.restoreAllMocks();
    expect(zoneIn(document.cookie)).toBe("Europe/Lisbon");
  });
});
