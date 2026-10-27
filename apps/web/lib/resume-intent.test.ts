// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberResumeIntent, takeResumeIntent } from "./resume-intent";

const NOW = 1_752_700_000_000;
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});
describe("resuming a scan action", () => {
  it("keeps two scans' intents separate and consumes each once", () => {
    rememberResumeIntent("scan-a", "download-md");
    rememberResumeIntent("scan-b", "copy-prompt");
    expect(takeResumeIntent("scan-a")).toBe("download-md");
    expect(takeResumeIntent("scan-a")).toBeNull();
    expect(takeResumeIntent("scan-b")).toBe("copy-prompt");
    expect(takeResumeIntent("scan-b")).toBeNull();
  });
  it("round-trips a fresh stored intent", () => {
    rememberResumeIntent("scan", "copy-prompt");
    vi.setSystemTime(NOW + 60_000);
    expect(takeResumeIntent("scan")).toBe("copy-prompt");
  });
  it("expires at twenty-four hours and rejects garbage", () => {
    rememberResumeIntent("before", "download-md");
    rememberResumeIntent("expired", "download-md");
    vi.setSystemTime(NOW + 86_400_000 - 1);
    expect(takeResumeIntent("before")).toBe("download-md");
    vi.setSystemTime(NOW + 86_400_000);
    expect(takeResumeIntent("expired")).toBeNull();
    expect(takeResumeIntent("absent")).toBeNull();
    for (const raw of [
      "not json",
      JSON.stringify({ intent: "drop-table", expires_at: NOW + 86_400_001 }),
    ]) {
      rememberResumeIntent("garbage", "download-md");
      const key = localStorage.key(0);
      if (!key) throw new Error("the intent was not stored");
      localStorage.setItem(key, raw);
      expect(takeResumeIntent("garbage")).toBeNull();
    }
  });
});
