import type { PublicShareSnapshot } from "@agentify/scanner-contracts";
import { describe, expect, it } from "vitest";

import { shareCopy } from "./share-copy";

const LEVELS: PublicShareSnapshot["level"][] = [
  "invisible",
  "readable",
  "callable_ready",
  "ahead_of_market",
  "incomplete",
];

// Words that would be either an unsupportable promise or a false certification
// claim. The provocative tone must never cross into these (brand §11 + truth).
const FORBIDDEN = /guarantee|ranking|\btraffic\b|\bsales\b|#1|in chatgpt/i;

function snap(
  overrides: Partial<PublicShareSnapshot> = {},
): PublicShareSnapshot {
  return {
    host: "bloomandco.com",
    score: 46,
    level: "readable",
    rubric_version: "gtm-v1.0.0",
    generated_at: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("shareCopy", () => {
  it("classifies an invisible result as critical", () => {
    const copy = shareCopy(snap({ level: "invisible", score: 18 }));
    expect(copy.tone).toBe("critical");
  });

  it("classifies an ahead-of-market result as positive", () => {
    const copy = shareCopy(snap({ level: "ahead_of_market", score: 88 }));
    expect(copy.tone).toBe("positive");
  });

  it("classifies an incomplete scan as neutral", () => {
    const copy = shareCopy(snap({ level: "incomplete", score: 0 }));
    expect(copy.tone).toBe("neutral");
  });

  it("puts the host in every scored headline", () => {
    for (const level of LEVELS) {
      if (level === "incomplete") continue;
      const copy = shareCopy(snap({ level, host: "acme.store" }));
      expect(copy.headline).toContain("acme.store");
    }
  });

  it("includes the score in the subline for scored levels", () => {
    const copy = shareCopy(snap({ level: "invisible", score: 12 }));
    expect(copy.subline).toContain("12");
  });

  it("never uses a forbidden promise or certification claim", () => {
    for (const level of LEVELS) {
      const copy = shareCopy(snap({ level }));
      const all = `${copy.kicker} ${copy.headline} ${copy.subline}`;
      expect(all).not.toMatch(FORBIDDEN);
      if (/certification/i.test(all))
        expect(all).toMatch(/not a certification/i);
    }
  });

  it("strips a leading www. from the host", () => {
    const copy = shareCopy(snap({ level: "readable", host: "www.acme.store" }));
    expect(copy.headline).toContain("acme.store");
    expect(copy.headline).not.toContain("www.");
  });
});
