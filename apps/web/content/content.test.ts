import { describe, expect, it } from "vitest";

import { LANDINGS } from "./landing";
import { EVIDENCE_CLASSES, getSource, SOURCES } from "./sources";

describe("marketing content registry", () => {
  it("keeps all segment pages on one typed composition", () => {
    expect(Object.keys(LANDINGS).sort()).toEqual(["local", "owner", "store"]);
    for (const landing of Object.values(LANDINGS)) {
      expect(landing.pains).toHaveLength(3);
      expect(landing.reportPreviewFixture).toBe("canonical-example-v1");
      expect(landing.pains.every((pain) => pain.sourceIds.length > 0)).toBe(
        true,
      );
      for (const pain of landing.pains) {
        for (const sourceId of pain.sourceIds)
          expect(getSource(sourceId).id).toBe(sourceId);
      }
    }
  });

  it("contains no placeholder or non-HTTPS sources", () => {
    for (const source of Object.values(SOURCES)) {
      expect(source.url.startsWith("https://")).toBe(true);
      expect(source.url).not.toContain("example.com");
      expect(source.caveat.length).toBeGreaterThan(20);
      expect(EVIDENCE_CLASSES).toContain(source.evidenceClass);
    }
  });
});
