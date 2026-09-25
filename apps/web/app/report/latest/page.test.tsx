/**
 * Where a signed-in person who owns no merchant starts (ADR-0026 §1).
 *
 * The cabinet sends such a person here when their link had no destination of
 * its own, because the scanner is what knows whether they own a report. One
 * who owns none has to be sent back to the cabinet's start, which offers the
 * one control that makes a merchant; a page that sent them anywhere else, or
 * drew itself, would leave a person who has just signed in with nowhere to go.
 *
 * Who is visiting and which report is theirs are the cabinet's and the
 * database's answers, so they are given here; the redirect is Next's own,
 * read back off the error it throws the way Next reads it.
 */

import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
  visitor: { kind: "stranger" } as Record<string, unknown>,
  reports: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "a-session=present" }),
}));

vi.mock("../../../lib/server/auth", () => ({
  visitorOf: async () => world.visitor,
  latestReportOf: async (leadId: string) => world.reports.get(leadId),
}));

import LatestReportPage from "./page";

const person = (leadId: string | null) => ({
  kind: "person",
  email: "someone@example.com",
  operator: false,
  leadId,
  setCookies: [],
});

/** Where the page sent this visitor, or a failure naming what it did instead. */
async function sentTo(): Promise<string> {
  try {
    await LatestReportPage();
  } catch (thrown) {
    if (isRedirectError(thrown)) return getURLFromRedirectError(thrown);
    throw thrown;
  }
  throw new Error("the page drew itself instead of sending the visitor anywhere");
}

describe("the start of a signed-in person with no merchant", () => {
  beforeEach(() => {
    world.reports.clear();
  });

  it("sends a person whose address owns no reports back to the cabinet's start", async () => {
    world.visitor = person(null);

    expect(await sentTo()).toBe("/cabinet/");
  });

  it("sends a person whose lead has no report back to the cabinet's start as well", async () => {
    world.visitor = person("lead_without_reports");

    expect(await sentTo()).toBe("/cabinet/");
  });

  it("sends a person who owns a report to the latest of them, never to the cabinet", async () => {
    // The control for the two above: a page that sent everybody to the
    // cabinet would pass both of them.
    world.visitor = person("lead_with_reports");
    world.reports.set("lead_with_reports", "scan_latest");

    expect(await sentTo()).toBe("/report/scan_latest");
  });
});
