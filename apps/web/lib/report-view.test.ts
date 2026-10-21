/**
 * What the full report says of its checks as a whole, composed on the server:
 * the tally at the head of the list, which counts each state on its own.
 */

import {
  CHECK_DEFINITIONS,
  type CheckStatus,
  type ReportResponse,
} from "@agentify/scanner-contracts";
import { describe, expect, it } from "vitest";

import { reportView } from "./report-view";

const reportWith = (statusOf: (id: number) => CheckStatus): ReportResponse => ({
  scan_id: "0190f4c5-0000-7000-8000-00000000c001",
  host: "shop.example",
  segment: "store",
  score: 46,
  coverage: 0.94,
  level: "readable",
  benchmark: null,
  scanned_at: "2026-10-13T12:00:00.000Z",
  checks: CHECK_DEFINITIONS.map((check) => ({
    id: check.id,
    label_code: check.labelCode,
    status: statusOf(check.id),
    summary_code: null,
    user_impact_code: null,
    fix_code: null,
    robots: null,
    evidence: {},
  })),
});

const SITE = { brand: "Agentify", promptEnabled: false, shareEnabled: false };

describe("the report's tally of its checks", () => {
  it("counts every state apart, an unavailable check never among the failures", () => {
    const view = reportView(
      reportWith((id) =>
        [3, 6].includes(id) ? "fail" : id === 7 ? "partial" : id === 9 ? "unavailable" : "pass",
      ),
      undefined,
      SITE,
    );

    expect(view.tally).toEqual([
      { status: "fail", count: 2 },
      { status: "partial", count: 1 },
      { status: "unavailable", count: 1 },
      { status: "pass", count: 14 },
    ]);
  });

  it("lists only the states some check is in, a check that does not apply among them", () => {
    const view = reportView(
      reportWith((id) => (id === 16 ? "not_applicable" : "pass")),
      undefined,
      SITE,
    );

    expect(view.tally).toEqual([
      { status: "not_applicable", count: 1 },
      { status: "pass", count: 17 },
    ]);
  });
});
