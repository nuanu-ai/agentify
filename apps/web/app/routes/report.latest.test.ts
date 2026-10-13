/**
 * The dashboard sends a signed-in person who owns no merchant here when their
 * link had no destination of its own. One who owns no report must go back to
 * the dashboard's start, which offers the control that makes a merchant;
 * anywhere else would leave a person who has just signed in with nowhere to go.
 *
 * Who is visiting and which reports they own are read from the dashboard and
 * the database, which a test does not have, so they are stubbed here and the
 * loader is asked directly; where it sent the visitor is read off the redirect
 * it threw. What needs neither, a stranger and a dashboard that does not
 * answer, is asked of the whole process in `report.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
  visitor: { kind: "stranger" } as Record<string, unknown>,
  reports: new Map<string, string>(),
}));

vi.mock("../../lib/server/auth", () => ({
  visitorOf: async () => world.visitor,
  latestReportOf: async (leadId: string) => world.reports.get(leadId),
}));

import { loader } from "./report.latest";

const person = (leadId: string | null) => ({
  kind: "person",
  email: "someone@example.com",
  operator: false,
  leadId,
  setCookies: [],
});

/** Where the loader sent this visitor, or a failure naming what it did instead. */
async function sentTo(): Promise<string | null> {
  try {
    await loader({
      request: new Request("http://127.0.0.1/report/latest", {
        headers: { cookie: "agentify.session_token=present" },
      }),
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);
  } catch (thrown) {
    if (thrown instanceof Response && thrown.status === 307) return thrown.headers.get("location");
    throw thrown;
  }
  throw new Error("the page drew itself instead of sending the visitor anywhere");
}

describe("the start of a signed-in person with no merchant", () => {
  beforeEach(() => {
    world.reports.clear();
  });

  it("sends a person whose address owns no reports back to the dashboard's start", async () => {
    world.visitor = person(null);

    expect(await sentTo()).toBe("/dashboard/");
  });

  it("sends a person whose lead has no report back to the dashboard's start as well", async () => {
    world.visitor = person("lead_without_reports");

    expect(await sentTo()).toBe("/dashboard/");
  });

  it("sends a person who owns a report to the latest of them, never to the dashboard", async () => {
    // The control for the two above: a page that sent everybody to the
    // dashboard would pass both of them.
    world.visitor = person("lead_with_reports");
    world.reports.set("lead_with_reports", "scan_latest");

    expect(await sentTo()).toBe("/report/scan_latest");
  });
});
