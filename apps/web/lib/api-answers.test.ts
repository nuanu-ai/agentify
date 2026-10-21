/**
 * The browser's readers of the API's answers against the contract's schemas,
 * on the same answers: each takes every answer the contract takes, with the
 * same data, and refuses each answer the contract refuses for a field that is
 * missing, of another kind, or out of its range. Formats of strings no page
 * reads are not among these, and neither are fields the contract does not
 * name.
 */

import {
  apiErrorEnvelopeSchema,
  CHECK_DEFINITIONS,
  createScanResponseSchema,
  scanStatusResponseSchema,
  sharePreviewResponseSchema,
} from "@agentify/scanner-contracts";
import { describe, expect, it } from "vitest";
import { acceptedScanIn, refusalIn, scanStatusIn, sharePreviewIn } from "./api-answers";

type Reader = (answer: unknown) => unknown;
type Schema = { safeParse(answer: unknown): { success: boolean; data?: unknown } };

const WRONG = [null, "", -1, 1.5, 101, true, {}, []] as const;

/**
 * The answer with one thing wrong at a time, at every depth: a field removed,
 * or replaced by something of another kind or out of range.
 */
function variants(valid: unknown, at = "answer"): [string, unknown][] {
  if (Array.isArray(valid)) {
    return valid.length === 0
      ? []
      : variants(valid[0], `${at}[0]`).map(([where, item]) => [where, [item, ...valid.slice(1)]]);
  }
  if (typeof valid !== "object" || valid === null) return [];
  const object = valid as Record<string, unknown>;
  return Object.keys(object).flatMap((key): [string, unknown][] => {
    const { [key]: _removed, ...without } = object;
    return [
      [`${at}.${key} absent`, without],
      ...WRONG.map((wrong): [string, unknown] => [
        `${at}.${key} = ${JSON.stringify(wrong)}`,
        { ...object, [key]: wrong },
      ]),
      ...variants(object[key], `${at}.${key}`).map(([where, inner]): [string, unknown] => [
        where,
        { ...object, [key]: inner },
      ]),
    ];
  });
}

function holdsTheContract(reader: Reader, schema: Schema, answers: readonly unknown[]) {
  for (const answer of answers) {
    const parsed = schema.safeParse(answer);
    expect(parsed.success, JSON.stringify(answer)).toBe(true);
    expect(reader(answer)).toEqual(parsed.data);
    for (const [where, variant] of variants(answer)) {
      expect(reader(variant) !== null, where).toBe(schema.safeParse(variant).success);
    }
  }
}

const checks = (status: string) =>
  CHECK_DEFINITIONS.map((check) => ({
    id: check.id,
    label_code: check.labelCode,
    status,
    robots: check.id === 9 ? "disallowed" : null,
  }));

describe("the browser's reading of an API answer", () => {
  it("takes the refusals the contract takes, and no other", () => {
    const envelope: Schema = {
      safeParse: (answer) => {
        const parsed = apiErrorEnvelopeSchema.safeParse(answer);
        return parsed.success ? { success: true, data: parsed.data.error } : parsed;
      },
    };
    holdsTheContract(refusalIn, envelope, [
      {
        error: {
          code: "hard_rate_limit",
          message: "This network reached the hard scan limit.",
          retryable: false,
          request_id: "0190f4c5-1111-7222-8333-944455556666",
        },
      },
      {
        error: {
          code: "verification_link_cooldown",
          message: "No new link was sent. You can ask for another in 45 seconds.",
          retryable: true,
          retry_after_seconds: 45,
          request_id: "0190f4c5-1111-7222-8333-944455556667",
        },
      },
    ]);
  });

  it("takes the accepted scans the contract takes, and no other", () => {
    holdsTheContract(acceptedScanIn, createScanResponseSchema, [
      {
        scan_id: "0190f4c5-1111-7222-8333-944455556666",
        access_token: "a".repeat(43),
        status: "accepted",
        status_url: "/api/v1/scans/0190f4c5-1111-7222-8333-944455556666/status",
        estimated_seconds: 30,
      },
    ]);
    expect(
      acceptedScanIn({
        scan_id: "0190f4c5-1111-4222-8333-944455556666",
        access_token: "a".repeat(43),
        status: "accepted",
        status_url: "/api/v1/scans/0190f4c5-1111-4222-8333-944455556666/status",
        estimated_seconds: 30,
      }),
    ).toBeNull();
  });

  it("takes the scan states the contract takes, and no other", () => {
    holdsTheContract(scanStatusIn, scanStatusResponseSchema, [
      {
        status: "accepted",
        progress: { completed: 0, total: 18 },
        checks: [],
        updated_at: "2026-10-13T09:00:00.000Z",
        target_host: "shop.example",
      },
      {
        status: "running",
        progress: { completed: 7, total: 18 },
        checks: checks("running"),
        updated_at: "2026-10-13T09:00:01.000Z",
        target_host: "shop.example",
      },
      {
        status: "failed",
        progress: { completed: 18, total: 18 },
        checks: checks("unavailable"),
        updated_at: "2026-10-13T09:00:30.000+02:00",
        target_host: "shop.example",
        blocked: true,
      },
      {
        status: "failed",
        progress: { completed: 18, total: 18 },
        checks: checks("unavailable"),
        updated_at: "2026-10-13T09:00:30.000Z",
        target_host: "shop.example",
        stop_reason: "no_public_site",
      },
      {
        status: "completed",
        progress: { completed: 18, total: 18 },
        checks: checks("pass"),
        updated_at: "2026-10-13T09:00:40.000Z",
        target_host: "shop.example",
        teaser: {
          score: 46,
          coverage: 0.78,
          level: "readable",
          top_findings: ["vertical_jsonld_missing", "markdown_negotiation_absent"],
          positive: "ssr_content_substantive",
          hidden_count: 7,
        },
      },
      {
        status: "partial",
        progress: { completed: 18, total: 18 },
        checks: checks("partial"),
        updated_at: "2026-10-13T09:00:40.000Z",
        target_host: "shop.example",
        teaser: {
          score: null,
          coverage: 0.5,
          level: "incomplete",
          top_findings: [],
          positive: null,
          hidden_count: 0,
        },
      },
    ]);
  });

  it("takes the share previews the contract takes, and no other", () => {
    holdsTheContract(sharePreviewIn, sharePreviewResponseSchema, [
      {
        host: "shop.example",
        score: 46,
        level: "readable",
        rubric_version: "gtm-v1.0.0",
        generated_at: "2026-07-13T12:00:00.000Z",
        existing_share: null,
      },
      {
        host: "shop.example",
        score: 46,
        level: "readable",
        rubric_version: "gtm-v1.0.0",
        generated_at: "2026-07-13T12:00:00.000Z",
        existing_share: {
          slug: "abcdefghijklmnopqrstuvwxyz_1234567890",
          public_url: "https://agentify.ad/s/abcdefghijklmnopqrstuvwxyz_1234567890",
          status: "published",
        },
      },
    ]);
  });

  it.each([
    ["a proxy's page", "<html>Bad gateway</html>"],
    ["nothing", null],
    ["a list", []],
  ])("refuses %s as every one of them", (_what, answer) => {
    for (const reader of [refusalIn, acceptedScanIn, scanStatusIn, sharePreviewIn]) {
      expect(reader(answer)).toBeNull();
    }
  });
});
