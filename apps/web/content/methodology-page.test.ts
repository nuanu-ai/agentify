/**
 * The methodology is a page of the documentation, written in Markdown apart
 * from the code that runs the scan. These hold what it says of the scan to
 * the scan: every check by its number and its name, in order, how many there
 * are, and the versions of the rubric and of the browser layer.
 */

import { readFileSync } from "node:fs";
import { canonicalCheckLabel } from "@agentify/remediation";
import {
  BROWSER_OBSERVATION_VERSION,
  CHECK_DEFINITIONS,
  SCAN_RUBRIC_VERSION,
} from "@agentify/scanner-contracts";
import { describe, expect, it } from "vitest";

const PAGE = readFileSync(new URL("../../docs/scanner/methodology.md", import.meta.url), "utf8");
const TEXT = PAGE.replace(/\s+/g, " ");

describe("the documentation's methodology", () => {
  it("lists every check the scan runs, by its number and its name, in order", () => {
    const listed = [...PAGE.matchAll(/^- `#(\d+)` (.+)$/gm)].map(([, id = "", label = ""]) => ({
      id: Number(id),
      label,
    }));

    expect(listed).toEqual(
      CHECK_DEFINITIONS.map((check) => ({
        id: check.id,
        label: canonicalCheckLabel(check.labelCode),
      })),
    );
  });

  it("counts the checks as the scan does", () => {
    const counts = [...TEXT.matchAll(/\b(\d+)(?: checks|-check)\b/g)].map(([, count]) =>
      Number(count),
    );

    expect(counts.length).toBeGreaterThan(0);
    expect(new Set(counts)).toEqual(new Set([CHECK_DEFINITIONS.length]));
  });

  it("names the versions of the rubric and of the browser layer the scan reports", () => {
    expect(TEXT).toContain(`\`${SCAN_RUBRIC_VERSION}\``);
    expect(TEXT).toContain(`\`${BROWSER_OBSERVATION_VERSION}\``);
  });
});
