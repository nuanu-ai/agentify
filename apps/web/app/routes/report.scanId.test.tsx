/**
 * The full report, for the person it is filed under. Who is visiting, the
 * report and any card they saved are read from the dashboard and the
 * database, which a test does not have, so those are stubbed and the loader
 * is asked directly; the page is drawn from what the loader returned, as the
 * browser draws it. A stranger and a dashboard that does not answer are asked
 * of the whole process in `report.test.ts`.
 */

import { CHECK_DEFINITIONS, type ReportResponse } from "@agentify/scanner-contracts";
import { prerender } from "react-dom/static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReportLocked } from "../../components/report-locked";
import { ReportPage } from "../../components/report-page";
import { visitTo } from "../../testing/loader-args";
import { onSite } from "../../testing/on-site";

const SCAN = "0190f4c5-0000-7000-8000-00000000c001";

const person = {
  kind: "person",
  email: "owner@shop.example",
  operator: false,
  leadId: "0190f4c5-0000-7000-8000-00000000d001",
  setCookies: [],
};

const world = vi.hoisted(() => ({
  page: { kind: "stranger" } as Record<string, unknown>,
  card: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../../lib/server/reporting", () => ({
  loadReportPage: async () => world.page,
}));

vi.mock("../../lib/server/stripe-card-signal", () => ({
  getOwnedCardSignalForReport: async () => world.card,
}));

import { loader } from "./report.scanId";

/** A report of a store whose structured data fails, with robots.txt keeping out the MCP card. */
const report: ReportResponse = {
  scan_id: SCAN,
  host: "shop.example",
  segment: "store",
  score: 46,
  coverage: 0.78,
  level: "readable",
  benchmark: { sample_size: 42, average_score: 51.4 },
  scanned_at: "2026-10-13T23:30:00.000Z",
  checks: CHECK_DEFINITIONS.map((check) => ({
    id: check.id,
    label_code: check.labelCode,
    status:
      check.id === 6
        ? "fail"
        : check.id === 7
          ? "partial"
          : check.id === 9
            ? "unavailable"
            : "pass",
    summary_code: check.id === 6 ? "vertical_jsonld_missing" : null,
    user_impact_code: null,
    fix_code: check.id === 6 ? "publish_vertical_jsonld" : null,
    robots: check.id === 9 ? "disallowed" : null,
    evidence: (check.id === 6 ? { detected_types: ["Organization", "WebSite"] } : {}) as Record<
      string,
      string[]
    >,
  })),
};

const load = () =>
  loader(visitTo(`https://agentify.ad/report/${SCAN}`, { scanId: SCAN }, { cookie: "a=session" }));

const drawn = async () => {
  const page = await load();
  const { prelude } = await prerender(
    onSite(page.kind === "report" ? <ReportPage view={page.view} /> : <ReportLocked page={page} />),
  );
  // React marks where one text ends and the next begins; a reader sees one text.
  return (await new Response(prelude).text()).replaceAll("<!-- -->", "");
};

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://nobody:unused@127.0.0.1:1/nowhere");
  vi.stubEnv("REMEDIATION_PROMPT_ENABLED", "true");
  vi.stubEnv("PUBLIC_SHARE_ENABLED", "true");
  vi.stubEnv("CARD_SIGNAL_ENABLED", "false");
  vi.stubEnv("STRIPE_ADAPTER", "local");
  world.page = { kind: "report", visitor: person, report, browserObservation: undefined };
  world.card = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a report's page", () => {
  it("names the address a signed-in person is not, where the report is filed under another", async () => {
    world.page = { kind: "not_yours", email: "someone-else@shop.example" };

    const page = await drawn();

    expect(page).toContain("This report is not filed under someone-else@shop.example");
    expect(page).not.toContain("All 18 checks");
  });

  it("shows its owner the level, the score on the scan page's scale, the coverage and the segment's average", async () => {
    const page = await drawn();

    expect(page).toMatch(/<h1[^>]*>Readable<\/h1>/);
    expect(page).toContain("46<small>/100</small>");
    expect(page).toMatch(/<div[^>]*aria-valuenow="46"[^>]*role="meter"/);
    expect(page).toContain("Coverage 78%");
    expect(page).toContain("Segment average 51 from 42 scans");
    expect(page).toContain("not a certification");
  });

  it("names the day its scan was made, in UTC as the scan page and the public link name it", async () => {
    // Late on the 13th in UTC is already the 14th east of it.
    expect(await drawn()).toContain("Oct 13, 2026");
  });

  it("counts its checks by state at the head of the list, an unavailable check apart from the failures", async () => {
    const tally = /<ul aria-label="Checks by state"[^>]*>([\s\S]*?)<\/ul>/.exec(await drawn())?.[1];
    const words = tally
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    expect(words).toBe("Fail 1 Partial 1 Unavailable 1 Pass 15");
  });

  it("lists all eighteen checks in their groups, the first failure open with its fix and evidence", async () => {
    const page = await drawn();

    // Every disclosure but the header's menu is a check.
    expect(page.match(/<details(?! class="site-menu")/g)).toHaveLength(18);
    const opened = page.match(/<details[^>]*open=""[^>]*>[\s\S]*?<\/details>/g) ?? [];
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain(">06<");
    expect(opened[0]).toContain("Business-specific structured data");
    expect(page).toContain(
      "No business-specific structured-data type was found for this scan segment.",
    );
    expect(page).toContain(
      "<strong>Fix:</strong> Add the appropriate business-specific JSON-LD type",
    );
    expect(page).toContain("Detected Types");
    expect(page).toContain("Organization, WebSite");
    for (const group of ["Discovery", "Content", "Agent access", "Commerce", "Informational"]) {
      expect(page).toMatch(new RegExp(`<h3[^>]*>${group}</h3>`));
    }
  });

  it("says a check robots.txt kept the scanner from was not assessed, and infers no defect", async () => {
    const page = await drawn();

    expect(page).toContain("Not assessed: your robots.txt keeps the scanner out");
    expect(page).toContain('data-robots-notice="disallowed"');
  });

  it.each([
    ["true", 2],
    ["false", 0],
  ])(
    "offers a check's own fix where prompts are %s, for each check that failed or is partial",
    async (enabled, offered) => {
      vi.stubEnv("REMEDIATION_PROMPT_ENABLED", enabled);

      const page = await drawn();

      expect(page.match(/Copy this fix/g) ?? []).toHaveLength(offered);
    },
  );

  it("offers the card signal only where it is on, or its owner already gave one", async () => {
    const off = await drawn();
    vi.stubEnv("CARD_SIGNAL_ENABLED", "true");
    const on = await drawn();
    vi.stubEnv("CARD_SIGNAL_ENABLED", "false");
    world.card = {
      signalId: "0190f4c5-0000-7000-8000-00000000e001",
      status: "attached",
      clientSecret: null,
      adapter: "local",
    };
    const given = await drawn();

    expect(off).not.toContain('id="card-signal"');
    expect(on).toContain('id="card-signal"');
    expect(given).toContain("Card saved");
  });

  it("hands the browser a saved card's id, state and pending setup secret, and nothing else of it", async () => {
    // The pending setup's secret restores the provider's form after a reload;
    // nothing else the stored signal holds is the browser's business.
    world.card = {
      signalId: "0190f4c5-0000-7000-8000-00000000e001",
      status: "setup_pending",
      clientSecret: "the-setup-secret-the-provider-gave",
      adapter: "local",
      leadId: "0190f4c5-0000-7000-8000-00000000d001",
      setupIntentId: "the-provider-s-own-setup-id",
    };

    const handed = await load();

    expect(handed.kind === "report" ? handed.view.cardSignal : null).toEqual({
      adapter: "local",
      publishableKey: null,
      // The address the page is drawn for, which a setup names back.
      signedInAs: "owner@shop.example",
      initialSignal: {
        signalId: "0190f4c5-0000-7000-8000-00000000e001",
        status: "setup_pending",
        clientSecret: "the-setup-secret-the-provider-gave",
      },
    });
    expect(JSON.stringify(handed)).not.toContain("the-provider-s-own-setup-id");
    expect(JSON.stringify(handed)).not.toContain("00000000d001");
  });
});
