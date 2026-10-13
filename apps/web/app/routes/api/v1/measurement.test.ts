/**
 * What the scanner's pages measure of a visit, asked of the whole process over
 * HTTP: the campaign a visitor arrived from, and the events a page reports.
 * Whether anything is kept is the visitor's consent and the database's to
 * decide; what is refused before either, and what a visitor with no cookie
 * gets, is here.
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

const RETURNING_VISITOR = "agentify_anonymous=a-visitor";

describe("a campaign's attribution", () => {
  const touch = {
    segment: "store",
    landing_variant: "store-v1",
    partner_click_id: "partner-click-0001",
    touch: { utm_source: "newsletter", utm_campaign: "autumn" },
  };
  const attribute = (body: unknown, headers: Record<string, string> = {}) =>
    fromSite("/api/v1/attribution", "POST", body, headers);

  it("is refused when it comes from another origin", async () => {
    const answered = await attribute(touch, { origin: "https://elsewhere.example" });

    expect(answered.status).toBe(403);
    expect((await refusalOf(answered)).code).toBe("invalid_origin");
  });

  it.each([
    ["names a segment the site does not have", { ...touch, segment: "wholesale" }],
    ["carries a field the route does not know", { ...touch, referrer: "a-page" }],
    ["carries what may be a phone number", { ...touch, touch: { utm_term: "call 5551234567" } }],
    ["carries a click id that is not a hash", { ...touch, touch: { fbclid_hash: "a-click" } }],
  ])("is refused when it %s", async (_why, body) => {
    const answered = await attribute(body);

    expect(answered.status).toBe(400);
    expect((await refusalOf(answered)).code).toBe("invalid_attribution");
  });

  it("keeps nothing of a visitor who has no cookie yet, and sets none", async () => {
    const answered = await attribute(touch);

    expect(answered.status).toBe(204);
    expect(answered.headers.get("cache-control")).toBe("no-store");
    expect(answered.headers.get("set-cookie")).toBeNull();
    expect(await answered.text()).toBe("");
  });

  it("says a returning visitor's touch could not be saved, and to send it again, where the database cannot be reached", async () => {
    const answered = await attribute(touch, { cookie: RETURNING_VISITOR });

    expect(answered.status).toBe(503);
    expect(answered.headers.get("set-cookie")).toBeNull();
    expect(await refusalOf(answered)).toMatchObject({
      code: "attribution_unavailable",
      retryable: true,
      retry_after_seconds: 5,
    });
  });

  it("takes a post alone", async () => {
    expect((await ask("/api/v1/attribution")).status).toBe(405);
    expect(await allowedAt("/api/v1/attribution")).toBe("OPTIONS, POST");
  });
});

describe("a page's event", () => {
  const SCAN = "0190f4c5-0000-7000-8000-000000000000";
  const event = (name: string, fields: Record<string, unknown> = {}) => ({
    event_id: "0190f4c5-2222-7000-8000-000000000000",
    name,
    ...fields,
  });
  const report = (body: unknown, headers: Record<string, string> = {}) =>
    fromSite("/api/v1/events", "POST", body, headers);

  it("is refused when it comes from another origin", async () => {
    const answered = await report(event("landing_view"), { origin: "https://elsewhere.example" });

    expect(answered.status).toBe(403);
    expect((await refusalOf(answered)).code).toBe("invalid_origin");
  });

  it.each([
    ["is not one the site measures", event("button_clicked")],
    ["has no id", { name: "landing_view" }],
    ["names a scan by something other than its id", event("results_viewed", { scan_id: "1" })],
  ])("is refused when it %s", async (_why, body) => {
    const answered = await report(body);

    expect(answered.status).toBe(400);
    expect((await refusalOf(answered)).code).toBe("invalid_event");
  });

  it("is refused when it names no scan where its kind needs one", async () => {
    const answered = await report(event("registration_started"));

    expect(answered.status).toBe(400);
    expect((await refusalOf(answered)).code).toBe("invalid_event_context");
  });

  it.each([
    [
      "a landing view from a visitor with no cookie",
      event("landing_view", { segment: "store", landing_variant: "store-v1" }),
    ],
    [
      "a registration started without the scan's token",
      event("registration_started", { scan_id: SCAN }),
    ],
    ["a result viewed by nobody who may see it", event("results_viewed", { scan_id: SCAN })],
  ])("is not recorded for %s", async (_what, body) => {
    const answered = await report(body);

    expect(answered.status).toBe(404);
    expect((await refusalOf(answered)).code).toBe("analytics_context_not_found");
  });

  it("says it cannot tell who viewed a result, rather than that nobody may, where the dashboard does not answer", async () => {
    const answered = await report(event("results_viewed", { scan_id: SCAN }), {
      cookie: SIGNED_IN,
    });

    expect(answered.status).toBe(503);
    expect((await refusalOf(answered)).code).toBe("visitor_unknown");
  });

  it("takes a post alone", async () => {
    expect((await ask("/api/v1/events")).status).toBe(405);
    expect(await allowedAt("/api/v1/events")).toBe("OPTIONS, POST");
  });
});
