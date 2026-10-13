/**
 * Who is visiting, as the header of every scanner page and a report's prompt
 * ask it of the whole process over HTTP. The dashboard holds the only session;
 * a visitor without one, and a dashboard that does not answer, are here, and
 * a signed-in person is the integration suite's, which has a database.
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

describe("the visitor in the header", () => {
  it.each([
    ["no cookie", {}],
    ["cookies none of which is the session's", { cookie: "agentify_anonymous=a-visitor; x=1" }],
  ])("is signed out with %s, kept by nobody and given no cookie", async (_with, headers) => {
    const answered = await ask("/api/v2/session", { headers });

    expect(answered.status).toBe(200);
    expect(answered.headers.get("cache-control")).toBe("private, no-store");
    expect(answered.headers.get("set-cookie")).toBeNull();
    expect(await answered.json()).toEqual({ status: "signed_out" });
  });

  it("is unknown, and not signed out, where the dashboard does not answer", async () => {
    const answered = await ask("/api/v2/session", { headers: { cookie: SIGNED_IN } });

    expect(answered.status).toBe(503);
    expect(answered.headers.get("cache-control")).toBe("private, no-store");
    expect(await answered.json()).toEqual({ status: "unknown" });
  });

  it("is read alone", async () => {
    expect((await fromSite("/api/v2/session", "POST", {})).status).toBe(405);
    expect(await allowedAt("/api/v2/session")).toBe("GET, HEAD, OPTIONS");
  });
});

describe("whether a visitor may copy a report's prompt", () => {
  const ACCESS = "/api/v2/scans/0190f4c5-0000-7000-8000-000000000000/contact-access";

  it("asks a visitor who is not signed in to confirm their email", async () => {
    const answered = await ask(ACCESS);

    expect(answered.status).toBe(401);
    expect((await refusalOf(answered)).code).toBe("contact_verification_required");
  });

  it("says it cannot tell who is visiting, rather than asking for an email, where the dashboard does not answer", async () => {
    const answered = await ask(ACCESS, { headers: { cookie: SIGNED_IN } });

    expect(answered.status).toBe(503);
    expect((await refusalOf(answered)).code).toBe("visitor_unknown");
  });

  it("is read alone", async () => {
    expect((await fromSite(ACCESS, "POST", {})).status).toBe(405);
    expect(await allowedAt(ACCESS)).toBe("GET, HEAD, OPTIONS");
  });
});
