/**
 * The full report, for the person it is filed under. Who is visiting and the
 * report are read from the dashboard and the database, which a test does not
 * have, so those are stubbed and the loader is asked directly; the page is
 * drawn from what the loader returned, as the browser draws it. A stranger and
 * a dashboard that does not answer are asked of the whole process in
 * `report.test.ts`.
 */

import { CHECK_DEFINITIONS, type ReportResponse } from "@agentify/scanner-contracts";
import { prerender } from "react-dom/static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportLocked } from "../../components/report-locked";
import { ReportPage } from "../../components/report-page";
import { barIn } from "../../testing/bar";
import { visitTo } from "../../testing/loader-args";
import { documentOf } from "../../testing/markup";
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
}));

vi.mock("../../lib/server/reporting", () => ({
  loadReportPage: async () => world.page,
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
  benchmark: { sample_size: 42, average_score: 55.4 },
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
    fix_code:
      check.id === 6 ? "publish_vertical_jsonld" : check.id === 9 ? "publish_mcp_card" : null,
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
  world.page = { kind: "report", visitor: person, report, browserObservation: undefined };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a report's page", () => {
  it.each([
    ["the report", undefined],
    ["a stranger's page", { kind: "stranger" }],
    ["the page for somebody else", { kind: "not_yours", email: "someone-else@shop.example" }],
    ["the page for a visitor nobody could tell", { kind: "unknown", scanId: SCAN }],
  ] as const)(
    "draws the site's one bar over %s, the scanner marked as where the page is",
    async (_, locked) => {
      if (locked !== undefined) world.page = locked;

      const bar = barIn(await drawn());

      expect(bar.count).toBe(1);
      expect(bar.whole).toBe(true);
      expect(bar.marked).toStrictEqual(["Scanner"]);
    },
  );

  it("names the address a signed-in person is, where the report is filed under another, and offers to sign in with another", async () => {
    world.page = { kind: "not_yours", email: "someone-else@shop.example" };

    const page = await drawn();

    expect(page).toContain("<strong>someone-else@shop.example</strong>");
    expect(page).toMatch(
      /<form[^>]*action="\/dashboard\/sign-out"[^>]*method="post"[^>]*>\s*<button[^>]*type="submit"/,
    );
    expect(page).not.toContain("All 18 checks");
  });

  it.each([
    [
      "somebody signed in as another address to sign out",
      { kind: "not_yours", email: "someone-else@shop.example" },
      /^<form[^>]*action="\/dashboard\/sign-out"[^>]*method="post"/,
    ],
    [
      "a stranger to sign in to read reports",
      { kind: "stranger" },
      /^<a[^>]*href="\/dashboard\/sign-in\?destination=reports"/,
    ],
  ] as const)("offers %s while keeping report data private", async (_, locked, way) => {
    world.page = locked;

    const panel =
      /<section class="message-panel">([\s\S]*?)<\/section>/.exec(await drawn())?.[1] ?? "";
    // Each locked state offers its applicable way on.
    const controls = panel.match(/<(?:a|form|button)\b[^>]*>/g) ?? [];

    expect(controls.some((control) => way.test(control))).toBe(true);
    expect(panel).not.toContain("All 18 checks");
    expect(panel).not.toContain('role="meter"');
  });

  it("shows its owner the level, the score on the scan page's scale, the coverage and the segment's average", async () => {
    const browserObservation = {
      version: "browser-public-v2.0.0",
      status: "partial",
      non_scoring: true,
      pages_assessed: 1,
      findings: [
        {
          id: "accessibility_structure",
          status: "partial",
          summary_code: "unnamed_controls_found",
          user_impact_code: "agents_cannot_identify_controls",
          remediation_code: "name_interactive_controls",
          evidence: { unnamed_control_count: 3 },
        },
      ],
      updated_at: "2026-10-13T23:30:00.000Z",
    };
    for (const observation of [undefined, browserObservation]) {
      world.page.browserObservation = observation;
      const page = await drawn();
      if (observation) {
        expect(page).toContain("Accessibility structure");
        expect(page).toContain("Does not change the score");
      }

      expect(page).toMatch(/<h1[^>]*>Readable<\/h1>/);
      expect(page).toContain("46<small>/100</small>");
      expect(page).toMatch(/<div[^>]*aria-valuenow="46"[^>]*role="meter"/);
      expect(page).toContain("Coverage 78%");
      expect(page).toContain("Segment average 55 from 42 scans");
      expect(page).toContain("not a certification");
    }
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
    const openText = documentOf(opened[0] ?? "").body.textContent;
    expect(openText).toMatch(/no business-specific structured-data type.*found/i);
    expect(openText).toMatch(/fix:.*add.*business-specific JSON-LD type/i);
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
    const document = documentOf(page);
    const row = [...document.querySelectorAll("details")].find((detail) =>
      detail.querySelector("summary")?.textContent?.trim().startsWith("09"),
    );
    expect(row?.textContent).toMatch(/not assessed/i);
    expect(row?.textContent).toMatch(/no defect.*inferred/i);
    expect(row?.querySelector("summary")?.textContent).toMatch(/unavailable/i);
    expect(row?.querySelector("summary")?.textContent).not.toMatch(/fail/i);
    expect(row?.textContent).not.toMatch(/fix:/i);
  });

  it.each([
    ["true", 2],
    ["false", 0],
  ])(
    "offers a check's own fix where prompts are %s, for each check that failed or is partial",
    async (enabled, offered) => {
      vi.stubEnv("REMEDIATION_PROMPT_ENABLED", enabled);

      const page = await drawn();

      const document = documentOf(page);
      for (const check of report.checks) {
        const number = String(check.id).padStart(2, "0");
        const row = [...document.querySelectorAll("details")].find((detail) =>
          detail.querySelector("summary")?.textContent?.trim().startsWith(number),
        );
        expect(row, number).toBeDefined();
        const copy = [...(row?.querySelectorAll("button") ?? [])].find((button) =>
          /Copy this fix/.test(button.textContent ?? ""),
        );
        expect(Boolean(copy), number).toBe(
          enabled === "true" && (check.id === 6 || check.id === 7),
        );
      }
      expect(page.match(/Copy this fix/g) ?? []).toHaveLength(offered);
    },
  );
});
