/**
 * Example states of a scan for a developer, drawn on the scan page at
 * `?fixture=<name>` outside production instead of a live scan: one running,
 * one that failed, one the site turned away, one robots.txt kept out, one
 * at whose address no public website answers, and
 * teasers complete, partial and with checks robots.txt kept the scanner from.
 * The page's loader builds them, so none of this reaches a browser that did
 * not ask for one.
 */

import { CHECK_DEFINITIONS, type ScanStatusResponse } from "@agentify/scanner-contracts";

const SCAN_FIXTURES = [
  "running",
  "partial",
  "failed",
  "blocked",
  "private",
  "teaser",
  "robots",
  "robots-partial",
] as const;

export type ScanFixtureName = (typeof SCAN_FIXTURES)[number];

export type ScanFixture = Readonly<{ name: ScanFixtureName; status: ScanStatusResponse }>;

// The checks robots.txt rules on: every check but the three that read
// robots.txt itself and the platform fingerprint.
const ROBOTS_CHECK_IDS: readonly number[] = [4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 17, 18];
const WELL_KNOWN_CHECK_IDS: readonly number[] = [9, 10, 17];

/** The example state named, or null for a name that is none of them. */
export function scanFixture(name: string | null): ScanFixture | null {
  const known = SCAN_FIXTURES.find((fixture) => fixture === name);
  return known === undefined ? null : { name: known, status: statusOf(known) };
}

function statusOf(name: ScanFixtureName): ScanStatusResponse {
  const now = new Date().toISOString();
  if (name === "robots") {
    return {
      status: "failed",
      progress: { completed: 18, total: 18 },
      checks: CHECK_DEFINITIONS.map((check) => {
        const robots = ROBOTS_CHECK_IDS.includes(check.id);
        return {
          id: check.id,
          label_code: check.labelCode,
          status: robots ? ("unavailable" as const) : ("pass" as const),
          robots: robots ? ("disallowed" as const) : null,
        };
      }),
      updated_at: now,
      target_host: "example.com",
    };
  }
  if (name === "private") {
    return {
      status: "failed",
      progress: { completed: 18, total: 18 },
      checks: CHECK_DEFINITIONS.map((check) => ({
        id: check.id,
        label_code: check.labelCode,
        status:
          check.id === 16
            ? ("pass" as const)
            : check.id === 11
              ? ("not_applicable" as const)
              : ("unavailable" as const),
        robots: null,
      })),
      updated_at: now,
      target_host: "example.com",
      stop_reason: "no_public_site",
    };
  }
  if (name === "failed" || name === "blocked") {
    return {
      status: "failed",
      progress: { completed: 4, total: 18 },
      checks: CHECK_DEFINITIONS.slice(0, 4).map((check) => ({
        id: check.id,
        label_code: check.labelCode,
        status: "unavailable" as const,
        robots: null,
      })),
      updated_at: now,
      target_host: "example.com",
      ...(name === "blocked" ? { blocked: true as const } : {}),
    };
  }
  if (name === "running") {
    return {
      status: "running",
      progress: { completed: 7, total: 18 },
      checks: CHECK_DEFINITIONS.slice(0, 9).map((check, index) => ({
        id: check.id,
        label_code: check.labelCode,
        status:
          index < 7 ? ("pass" as const) : index === 7 ? ("running" as const) : ("pending" as const),
        robots: null,
      })),
      updated_at: now,
      target_host: "example.com",
    };
  }
  const wellKnownDisallowed = name === "robots-partial";
  return {
    status: name === "partial" || wellKnownDisallowed ? "partial" : "completed",
    progress: { completed: 18, total: 18 },
    checks: CHECK_DEFINITIONS.map((check, index) => ({
      id: check.id,
      label_code: check.labelCode,
      status:
        (name === "partial" && index > 13) ||
        (wellKnownDisallowed && [...WELL_KNOWN_CHECK_IDS, 14].includes(check.id))
          ? ("unavailable" as const)
          : index % 4 === 0
            ? ("partial" as const)
            : ("pass" as const),
      robots:
        wellKnownDisallowed && WELL_KNOWN_CHECK_IDS.includes(check.id)
          ? ("disallowed" as const)
          : null,
    })),
    updated_at: now,
    target_host: "example.com",
    teaser: {
      score: 46,
      coverage: name === "partial" ? 0.78 : 1,
      level: "readable",
      top_findings: ["vertical_jsonld_missing", "markdown_negotiation_absent"],
      positive: "ssr_content_substantive",
      hidden_count: 7,
    },
  };
}
