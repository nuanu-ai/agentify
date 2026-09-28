import {
  BROWSER_OBSERVATION_IDS,
  type BrowserObservationInputV1,
  type BrowserObservationOutputV1,
  browserObservationOutputV1Schema,
} from "@agentify/scanner-contracts";
import { describe, expect, it } from "vitest";

import type { PageSignals } from "./browser-signals.js";
import { buildBrowserOutput, buildObservations, type ObservationRuntime } from "./observations.js";

const page = (overrides: Partial<PageSignals> = {}): PageSignals => ({
  renderedTextChars: 1_000,
  rawTextChars: 900,
  landmarkCounts: { main: 1, navigation: 1 },
  headingLevelCounts: { h1: 1, h2: 2 },
  interactiveControlCount: 4,
  unnamedControlCount: 0,
  formControlCount: 2,
  unlabeledFormControlCount: 0,
  formSemanticIssueCount: 0,
  webmcpPresent: false,
  webmcpToolCount: 0,
  challengeKind: null,
  hiddenInstructionCount: 0,
  apiDiscoveryCount: 1,
  licenseLinkCount: 1,
  ariaRoleCounts: { heading: 3, link: 4 },
  renderedMetadata: {
    canonical: "https://example.com/",
    hreflangCount: 1,
    jsonLdCount: 1,
    currencies: ["USD"],
    availability: ["instock"],
    priceCount: 1,
    hasContact: false,
    hasOpeningHours: false,
  },
  rawMetadata: {
    canonical: "https://example.com/",
    hreflangCount: 1,
    jsonLdCount: 1,
    currencies: ["USD"],
    availability: ["instock"],
    priceCount: 1,
    hasContact: false,
    hasOpeningHours: false,
  },
  visibleFacts: {
    currencies: ["USD"],
    availability: ["instock"],
  },
  titleSignature: "a".repeat(64),
  ...overrides,
});

const runtime = (pages: PageSignals[]): ObservationRuntime => ({
  pages,
  consoleErrorCategories: [],
  failedResourceCategories: [],
  mixedContentCount: 0,
  requestCount: 10,
  transferredBytes: 100_000,
  blockedMutationCount: 0,
  blockedDestinationCount: 0,
  byteBudgetExceeded: false,
  requestBudgetExceeded: false,
  pageFailureCount: 0,
  maxTotalBytes: 8 * 1024 * 1024,
  maxRequests: 80,
});

describe("browser observation evaluator", () => {
  it("always emits the 14 stable non-scoring observation IDs", () => {
    const findings = buildObservations(runtime([page()]));
    expect(findings).toHaveLength(14);
    expect(new Set(findings.map((finding) => finding.id)).size).toBe(14);
    expect(findings.map((finding) => finding.id)).toEqual(BROWSER_OBSERVATION_IDS);
    expect(findings.find((item) => item.id === "webmcp_surface")?.status).toBe("not_applicable");
  });

  it("separates observed site problems from provider unavailability", () => {
    const findings = buildObservations(
      runtime([
        page({
          rawTextChars: 50,
          interactiveControlCount: 10,
          unnamedControlCount: 8,
          challengeKind: "bot_challenge",
          hiddenInstructionCount: 1,
        }),
      ]),
    );
    expect(findings.find((item) => item.id === "rendered_content_delta")?.status).toBe("fail");
    expect(findings.find((item) => item.id === "accessibility_structure")?.status).toBe("fail");
    expect(findings.find((item) => item.id === "session_or_challenge_wall")?.status).toBe("fail");
    expect(findings.find((item) => item.id === "hidden_instruction_risk")?.status).toBe("fail");

    const unavailable = buildObservations(runtime([]));
    expect(unavailable).toHaveLength(14);
    expect(unavailable.every((item) => item.status === "unavailable")).toBe(true);
  });

  it("compares a bounded visible-fact sample instead of raw versus rendered JSON-LD", () => {
    const mismatched = buildObservations(
      runtime([
        page({
          visibleFacts: {
            currencies: ["EUR"],
            availability: ["outofstock"],
          },
        }),
      ]),
    ).find((item) => item.id === "public_fact_consistency");
    expect(mismatched).toMatchObject({
      status: "fail",
      summary_code: "public_facts_contradict",
      evidence: { comparable_fact_kind_count: 2, contradiction_count: 2 },
    });

    const noComparableFacts = buildObservations(
      runtime([
        page({
          visibleFacts: { currencies: [], availability: [] },
        }),
      ]),
    ).find((item) => item.id === "public_fact_consistency");
    expect(noComparableFacts).toMatchObject({
      status: "unavailable",
      summary_code: "public_facts_not_comparable",
    });
  });

  it("uses the complete form-semantic issue count and does not compare facts across products", () => {
    const findings = buildObservations(
      runtime([
        page({ formSemanticIssueCount: 1 }),
        page({
          renderedMetadata: {
            canonical: "https://example.com/second",
            hreflangCount: 1,
            jsonLdCount: 1,
            currencies: ["EUR"],
            availability: ["outofstock"],
            priceCount: 1,
            hasContact: false,
            hasOpeningHours: false,
          },
          rawMetadata: {
            canonical: "https://example.com/second",
            hreflangCount: 1,
            jsonLdCount: 1,
            currencies: ["EUR"],
            availability: ["outofstock"],
            priceCount: 1,
            hasContact: false,
            hasOpeningHours: false,
          },
          visibleFacts: {
            currencies: ["EUR"],
            availability: ["outofstock"],
          },
        }),
      ]),
    );
    expect(findings.find((item) => item.id === "form_semantics")?.status).toBe("partial");
    expect(findings.find((item) => item.id === "representative_page_consistency")?.status).toBe(
      "pass",
    );
  });
});

describe("the output the worker receives from the Actor", () => {
  // The worker reads the output as JSON from the run's key-value store and
  // parses it with the contract schema before anything is stored.
  const received = (run: ObservationRuntime, status: BrowserObservationOutputV1["status"]) =>
    browserObservationOutputV1Schema.parse(
      JSON.parse(
        JSON.stringify(
          buildBrowserOutput({
            operationId: "019f5d64-1234-7abc-8abc-1234567890ab",
            actorBuild: "1.0.42",
            status,
            runtime: run,
            totalMs: 9_000,
          }),
        ),
      ),
    );

  it("reports a page that made more than 1,000 requests instead of failing the run", () => {
    // A category page with 1,200 product images: the runner counts every
    // request the page makes, the ones it aborts past the budget included,
    // so robots.txt, the document and the images come to 1,202.
    const output = received(
      {
        ...runtime([page()]),
        requestCount: 1_202,
        requestBudgetExceeded: true,
        maxRequests: 243,
      },
      "partial",
    );
    expect(output.status).toBe("partial");
    expect(output.observations.find((item) => item.id === "browser_runtime_cost")).toMatchObject({
      status: "fail",
      summary_code: "browser_runtime_request_budget_exceeded",
      evidence: { request_count: 1_202 },
    });
  });

  it("reports a page behind a cookie wall instead of failing the run", () => {
    const output = received(runtime([page({ challengeKind: "cookie_wall" })]), "blocked");
    expect(output.status).toBe("blocked");
    expect(
      output.observations.find((item) => item.id === "session_or_challenge_wall"),
    ).toMatchObject({
      status: "fail",
      summary_code: "public_page_challenge_observed",
      evidence: { challenge_present: true, challenge_kind: "cookie_wall" },
    });
  });
});

void ({} as BrowserObservationInputV1);
