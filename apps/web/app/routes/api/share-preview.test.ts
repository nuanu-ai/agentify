/**
 * The preview of what sharing a scan would publish, asked of the whole process
 * over HTTP. The database it is pointed at listens nowhere and no dashboard is
 * configured, so these are the answers that need neither; the preview itself,
 * for a scan's token and for its owner, is held by the P4 integration test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask } from "../../../testing/scanner";

const PREVIEW = "/api/v1/scans/0190f4c5-1111-7222-8333-944455556666/share-preview";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("APP_BASE_URL", "https://test.agentify.ad");
  vi.stubEnv("DATABASE_URL", "postgresql://nobody:unused@127.0.0.1:1/nowhere");
  vi.stubEnv("DASHBOARD_IDENTITY_URL", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Refusal = { error: { code: string; retryable: boolean } };

describe("a share's preview", () => {
  it("is no scan to a visitor who shows neither the scan's token nor a session", async () => {
    const answered = await ask(PREVIEW);

    expect(answered.status).toBe(404);
    expect(answered.headers.get("cache-control")).toBe("no-store");
    expect(((await answered.json()) as Refusal).error.code).toBe("scan_not_found");
  });

  it("says it cannot tell who is asking, rather than that there is no scan, while the dashboard cannot answer", async () => {
    const answered = await ask(PREVIEW, { headers: { cookie: "agentify.session_token=a" } });

    expect(answered.status).toBe(503);
    expect(((await answered.json()) as Refusal).error).toMatchObject({
      code: "visitor_unknown",
      retryable: true,
    });
  });

  it("is read alone", async () => {
    const posted = await ask(PREVIEW, { method: "POST" });
    const asked = await ask(PREVIEW, { method: "OPTIONS" });

    expect(posted.status).toBe(405);
    expect(asked.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });
});
