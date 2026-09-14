import { describe, expect, it } from "vitest";

import {
  parseResumeIntent,
  resumeIntentKey,
  serializeResumeIntent,
} from "./resume-intent";

const NOW = 1_752_700_000_000;

describe("resume intent storage format", () => {
  it("keys the intent to one scan", () => {
    expect(resumeIntentKey("019f-abc")).toBe("b2a:resume-intent:019f-abc");
  });

  it("round-trips a stored intent while it is fresh", () => {
    const raw = serializeResumeIntent("download-md", NOW);
    expect(parseResumeIntent(raw, NOW + 60_000)).toBe("download-md");
    expect(
      parseResumeIntent(serializeResumeIntent("copy-prompt", NOW), NOW),
    ).toBe("copy-prompt");
  });

  it("expires after 24 hours and rejects garbage", () => {
    const raw = serializeResumeIntent("download-md", NOW);
    expect(parseResumeIntent(raw, NOW + 25 * 60 * 60 * 1000)).toBeNull();
    expect(parseResumeIntent(null, NOW)).toBeNull();
    expect(parseResumeIntent("not json", NOW)).toBeNull();
    expect(
      parseResumeIntent(
        JSON.stringify({ intent: "drop-table", expires_at: NOW + 1 }),
        NOW,
      ),
    ).toBeNull();
  });
});
