/**
 * A report and the prompts made from it, asked of the whole process over
 * HTTP: the full report, the full prompt and its file, and the prompt of the
 * visible findings and its file. Who may read them is decided by the
 * dashboard's session and the database; what is answered before either, and
 * when the dashboard does not answer, is here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allowedAt,
  fromSite,
  refusalOf,
  SIGNED_IN,
  stubOfflineScanner,
} from "../../../../testing/api";
import { ask } from "../../../../testing/scanner";

beforeEach(stubOfflineScanner);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const SCAN = "0190f4c5-0000-7000-8000-000000000000";

const FULL_REPORT = `/api/v1/reports/${SCAN}`;
const FULL_PROMPT = `/api/v1/reports/${SCAN}/remediation-prompt`;
const FULL_PROMPT_FILE = `/api/v1/reports/${SCAN}/remediation-prompt/download`;
const TEASER_PROMPT = `/api/v1/scans/${SCAN}/remediation-prompt`;
const TEASER_PROMPT_FILE = `/api/v1/scans/${SCAN}/remediation-prompt/download`;

describe("the full report", () => {
  it("is not there for a visitor who is not signed in", async () => {
    const answered = await ask(FULL_REPORT);

    expect(answered.status).toBe(404);
    expect(answered.headers.get("cache-control")).toBe("no-store");
    expect((await refusalOf(answered)).code).toBe("report_not_found");
  });
});

describe("the full prompt and its file", () => {
  it.each([
    [FULL_PROMPT, "?scope=full"],
    [FULL_PROMPT_FILE, ""],
  ])("are not offered while prompt export is switched off: %s", async (path, query) => {
    vi.stubEnv("REMEDIATION_PROMPT_ENABLED", "false");

    const answered = await ask(`${path}${query}`);

    expect(answered.status).toBe(404);
    expect((await refusalOf(answered)).code).toBe("not_found");
  });

  it.each(["", "?scope=teaser"])(
    "refuses a prompt asked without the full scope: %o",
    async (query) => {
      const answered = await ask(`${FULL_PROMPT}${query}`);

      expect(answered.status).toBe(400);
      expect(await refusalOf(answered)).toMatchObject({
        code: "invalid_scope",
        message: "Expected scope=full.",
      });
    },
  );

  it.each([
    [FULL_PROMPT, "?scope=full"],
    [FULL_PROMPT_FILE, ""],
  ])("are not there for a visitor who is not signed in: %s", async (path, query) => {
    const answered = await ask(`${path}${query}`);

    expect(answered.status).toBe(404);
    expect(answered.headers.get("content-disposition")).toBeNull();
    expect((await refusalOf(answered)).code).toBe("prompt_not_found");
  });
});

describe("the prompt of the visible findings and its file", () => {
  it.each([
    [TEASER_PROMPT, "?scope=teaser"],
    [TEASER_PROMPT_FILE, ""],
  ])("are not offered while prompt export is switched off: %s", async (path, query) => {
    vi.stubEnv("REMEDIATION_PROMPT_ENABLED", "false");

    const answered = await ask(`${path}${query}`);

    expect(answered.status).toBe(404);
    expect((await refusalOf(answered)).code).toBe("not_found");
  });

  it.each(["", "?scope=full"])(
    "refuses a prompt asked without the teaser scope: %o",
    async (query) => {
      const answered = await ask(`${TEASER_PROMPT}${query}`);

      expect(answered.status).toBe(400);
      expect(await refusalOf(answered)).toMatchObject({
        code: "invalid_scope",
        message: "Expected scope=teaser.",
      });
    },
  );

  it.each([
    [TEASER_PROMPT, "?scope=teaser", "Confirm your email to copy or download the prompt."],
    [TEASER_PROMPT_FILE, "", "Confirm your email to download the prompt."],
  ])(
    "ask a visitor who is not signed in to confirm their email: %s",
    async (path, query, message) => {
      const answered = await ask(`${path}${query}`);

      expect(answered.status).toBe(401);
      expect(answered.headers.get("content-disposition")).toBeNull();
      expect(await refusalOf(answered)).toMatchObject({
        code: "contact_verification_required",
        message,
      });
    },
  );
});

describe("every report and prompt route", () => {
  const ROUTES = [
    [FULL_REPORT, ""],
    [FULL_PROMPT, "?scope=full"],
    [FULL_PROMPT_FILE, ""],
    [TEASER_PROMPT, "?scope=teaser"],
    [TEASER_PROMPT_FILE, ""],
  ] as const;

  it.each(ROUTES)(
    "says it cannot tell who is visiting, rather than that nothing is there, where the dashboard does not answer: %s",
    async (path, query) => {
      const answered = await ask(`${path}${query}`, { headers: { cookie: SIGNED_IN } });

      expect(answered.status).toBe(503);
      expect(await refusalOf(answered)).toMatchObject({
        code: "visitor_unknown",
        retryable: true,
        retry_after_seconds: 30,
      });
    },
  );

  it.each(ROUTES)("is read alone: %s", async (path) => {
    expect((await fromSite(path, "POST", {})).status).toBe(405);
    expect(await allowedAt(path)).toBe("GET, HEAD, OPTIONS");
  });
});
