/**
 * The scanner API's answers as a page's own script reads them while the page
 * is first drawn. They are checked by hand rather than by the contract's
 * schemas because importing any schema evaluates them all and ships the whole
 * schema library with the page, which no first visit can carry. Each reader
 * accepts every answer the contract accepts and refuses one its page could not
 * draw: a missing field, a field of another kind, a state the page does not
 * know. The formats of strings no page reads, such as a timestamp, are left to
 * the API's own tests.
 */

import type {
  ApiErrorEnvelope,
  CreateScanResponse,
  ScanStatusResponse,
  SharePreviewResponse,
} from "@agentify/scanner-contracts";
import {
  CHECK_STATUSES,
  DIAGNOSTIC_LEVELS,
  ROBOTS_REASONS,
  SCAN_STATUSES,
  SCAN_STOP_REASONS,
} from "@agentify/scanner-contracts/browser";

type Fields = Readonly<Record<string, unknown>>;

const fields = (value: unknown): Fields | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : null;

const text = (value: unknown, least = 1): value is string =>
  typeof value === "string" && value.length >= least;

const whole = (value: unknown, least: number, most = Number.MAX_SAFE_INTEGER): value is number =>
  Number.isSafeInteger(value) && (value as number) >= least && (value as number) <= most;

const oneOf = <Value>(values: readonly Value[], value: unknown): value is Value =>
  values.some((known) => known === value);

const absentOr = (value: unknown, check: (present: unknown) => boolean): boolean =>
  value === undefined || check(value);

const nullOr = (value: unknown, check: (present: unknown) => boolean): boolean =>
  value === null || check(value);

const listOf = (value: unknown, most: number, check: (item: unknown) => boolean): boolean =>
  Array.isArray(value) && value.length <= most && value.every(check);

/** A refusal: what went wrong, in words for the visitor, and whether trying again can help. */
export function refusalIn(answer: unknown): ApiErrorEnvelope["error"] | null {
  const error = fields(fields(answer)?.error);
  if (
    error === null ||
    !text(error.code) ||
    !text(error.message) ||
    typeof error.retryable !== "boolean" ||
    !absentOr(error.retry_after_seconds, (seconds) => whole(seconds, 0)) ||
    !text(error.request_id)
  ) {
    return null;
  }
  return error as ApiErrorEnvelope["error"];
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A scan accepted: where it is and the token that reads it. */
export function acceptedScanIn(answer: unknown): CreateScanResponse | null {
  const scan = fields(answer);
  if (
    scan === null ||
    !(typeof scan.scan_id === "string" && UUID_V7.test(scan.scan_id)) ||
    !text(scan.access_token, 32) ||
    scan.status !== "accepted" ||
    !(typeof scan.status_url === "string" && scan.status_url.startsWith("/api/v1/scans/")) ||
    !whole(scan.estimated_seconds, 1)
  ) {
    return null;
  }
  return scan as CreateScanResponse;
}

const score = (value: unknown) => whole(value, 0, 100);

const progressCheck = (value: unknown): boolean => {
  const check = fields(value);
  return (
    check !== null &&
    whole(check.id, 1, 18) &&
    text(check.label_code) &&
    oneOf(CHECK_STATUSES, check.status) &&
    nullOr(check.robots, (reason) => oneOf(ROBOTS_REASONS, reason))
  );
};

const teaser = (value: unknown): boolean => {
  const teaser = fields(value);
  return (
    teaser !== null &&
    nullOr(teaser.score, score) &&
    typeof teaser.coverage === "number" &&
    teaser.coverage >= 0 &&
    teaser.coverage <= 1 &&
    oneOf(DIAGNOSTIC_LEVELS, teaser.level) &&
    listOf(teaser.top_findings, 3, (finding) => text(finding)) &&
    nullOr(teaser.positive, (finding) => text(finding)) &&
    whole(teaser.hidden_count, 0)
  );
};

/** Where a scan stands, its checks so far, and once it has one, the teaser of its result. */
export function scanStatusIn(answer: unknown): ScanStatusResponse | null {
  const scan = fields(answer);
  const progress = fields(scan?.progress);
  if (
    scan === null ||
    !oneOf(SCAN_STATUSES, scan.status) ||
    progress === null ||
    !whole(progress.completed, 0) ||
    progress.total !== 18 ||
    !listOf(scan.checks, 18, progressCheck) ||
    !text(scan.updated_at) ||
    !text(scan.target_host) ||
    !absentOr(scan.blocked, (blocked) => blocked === true) ||
    !absentOr(scan.stop_reason, (reason) => oneOf(SCAN_STOP_REASONS, reason)) ||
    !absentOr(scan.teaser, teaser)
  ) {
    return null;
  }
  return scan as ScanStatusResponse;
}

/** What a public link to a scan would show, and the link where one is already live. */
export function sharePreviewIn(answer: unknown): SharePreviewResponse | null {
  const preview = fields(answer);
  if (
    preview === null ||
    !text(preview.host) ||
    !score(preview.score) ||
    !oneOf(DIAGNOSTIC_LEVELS, preview.level) ||
    !text(preview.rubric_version) ||
    !text(preview.generated_at) ||
    !nullOr(preview.existing_share, (value) => {
      const share = fields(value);
      return (
        share !== null &&
        text(share.slug, 32) &&
        text(share.public_url) &&
        share.status === "published"
      );
    })
  ) {
    return null;
  }
  return preview as SharePreviewResponse;
}
