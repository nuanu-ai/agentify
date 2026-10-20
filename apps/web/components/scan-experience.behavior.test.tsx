// @vitest-environment jsdom

/**
 * The scan page in a browser, with the API answered at the network's edge:
 * where the token comes from and where it is kept, how often the page asks,
 * and each state a scan can show, from waiting for capacity to the result.
 */

import { CHECK_DEFINITIONS } from "@agentify/scanner-contracts";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onSite } from "../testing/on-site";
import { ScanExperience } from "./scan-experience";

const scanId = "019f5b6a-4b9f-7000-8000-0000000000bb";
const TOKEN_KEY = `agentify:scan-token:${scanId}`;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const checks = (status: (id: number) => string) =>
  CHECK_DEFINITIONS.map((check) => ({
    id: check.id,
    label_code: check.labelCode,
    status: status(check.id),
    robots: null,
  }));

const scan = (fields: Record<string, unknown>) => ({
  status: "running",
  progress: { completed: 7, total: 18 },
  checks: checks((id) => (id < 8 ? "pass" : id === 8 ? "running" : "pending")),
  updated_at: "2026-10-10T12:00:00.000Z",
  target_host: "shop.example",
  ...fields,
});

/**
 * The status of a scan the worker ended because the site answered its home
 * page with a bot challenge: the checks that needed the home page are
 * unavailable, the rest were read, and no verdict was given.
 */
const blockedScan = scan({
  status: "failed",
  progress: { completed: 18, total: 18 },
  checks: checks((id) => ([5, 6, 12, 13, 14, 15, 18].includes(id) ? "unavailable" : "pass")),
  blocked: true,
});

const finishedScan = scan({
  status: "completed",
  progress: { completed: 18, total: 18 },
  checks: checks(() => "pass"),
  teaser: {
    score: 46,
    coverage: 1,
    level: "readable",
    top_findings: ["vertical_jsonld_missing"],
    positive: "ssr_content_substantive",
    hidden_count: 7,
  },
});

/** Every status the page asked for, in order; the page's asks are what is observed. */
let statusAsks: { authorization: string | null }[] = [];

/** The API answering the status with each of `answers` in turn, the last one from then on. */
function apiAnswers(...answers: (() => Response | Promise<Response>)[]) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const address = String(input);
    if (address.endsWith("/api/v2/session")) return json(200, { status: "signed_out" });
    if (address.endsWith(`/api/v1/scans/${scanId}/status`)) {
      statusAsks.push({
        authorization: new Headers(init?.headers).get("authorization"),
      });
      const answer = answers[Math.min(statusAsks.length, answers.length) - 1];
      if (answer === undefined) throw new Error("no answer given");
      return answer();
    }
    return json(404, {});
  });
}

const visit = () =>
  render(
    onSite(
      <ScanExperience
        browserObservationsEnabled={false}
        publicShareEnabled
        registrationEnabled
        remediationPromptEnabled
        scanId={scanId}
        segment="store"
      />,
    ),
  );

/**
 * Lets `ms` of the page's time pass, landing every answer and render due by
 * then. The fake clock moves only here: one that also follows the wall clock
 * lets a loaded machine fire the next ask inside a window the test means to be
 * quiet.
 */
const timePasses = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  statusAsks = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  cleanup();
});

describe("the token that reads a scan", () => {
  it("is taken from the link's fragment, kept for the tab under the scan's key, and taken off the address", async () => {
    window.history.replaceState(
      null,
      "",
      `/scan/${scanId}?segment=store#access_token=from-the-link`,
    );
    apiAnswers(() => json(200, scan({})));

    visit();

    await screen.findByText("Reading public signals…");
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe("from-the-link");
    expect(statusAsks[0]?.authorization).toBe("Bearer from-the-link");
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?segment=store");
  });

  it("is asked for when the tab holds none, and the scan is not asked about", async () => {
    apiAnswers(() => json(200, scan({})));

    visit();

    expect(await screen.findByText("Open the original private scan link")).toBeTruthy();
    expect(statusAsks).toEqual([]);
  });

  it("is said to be no longer valid when the API refuses it, and the page stops asking", async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(TOKEN_KEY, "a-revoked-token");
    apiAnswers(() => json(401, { error: { code: "unauthorized" } }));

    visit();
    await timePasses(0);

    expect(screen.getByText("This scan link is no longer valid")).toBeTruthy();
    await timePasses(5_000);
    expect(statusAsks).toHaveLength(1);
  });
});

describe("how often the page asks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.setItem(TOKEN_KEY, "scan-token");
  });

  it.each([
    ["queued", 2_000],
    ["running", 1_000],
  ])("asks again every %s scan's interval: %ims", async (status, interval) => {
    apiAnswers(() => json(200, scan({ status })));
    visit();
    await timePasses(0);
    expect(statusAsks).toHaveLength(1);

    for (const asks of [2, 3, 4]) {
      await timePasses(interval - 1);
      expect(statusAsks).toHaveLength(asks - 1);
      await timePasses(1);
      expect(statusAsks).toHaveLength(asks);
    }
  });

  it("stops asking once the scan has ended", async () => {
    apiAnswers(() => json(200, blockedScan));
    visit();
    await timePasses(0);
    expect(screen.getByText("The site blocked our reader")).toBeTruthy();

    await timePasses(5_000);
    expect(statusAsks).toHaveLength(1);
  });
});

describe("a scan's states", () => {
  beforeEach(() => {
    sessionStorage.setItem(TOKEN_KEY, "scan-token");
  });

  it("says a queued scan waits for capacity", async () => {
    apiAnswers(() => json(200, scan({ status: "queued", checks: [] })));

    visit();

    expect(await screen.findAllByText("Waiting for scanner capacity")).toHaveLength(2);
  });

  it("shows a running scan's step and count, the store's own step among them", async () => {
    apiAnswers(() => json(200, scan({})));

    visit();

    expect(await screen.findByText("7 of 18 checks reported")).toBeTruthy();
    expect(screen.getByText("Checking catalog signals")).toBeTruthy();
  });

  it("says a scan without enough coverage produced no reliable diagnostic, and offers to start again", async () => {
    apiAnswers(() =>
      json(
        200,
        scan({
          status: "failed",
          progress: { completed: 4, total: 18 },
          checks: checks(() => "unavailable").slice(0, 4),
        }),
      ),
    );

    visit();

    expect(await screen.findByText("No reliable diagnostic was produced")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it.each(["private_address", "forbidden_redirect", "host_not_found", "secure_connection_failed"])(
    "says why the scanner stopped a scan it knows the reason for (%s), and offers a new scan rather than the same one again",
    async (stopReason) => {
      apiAnswers(() =>
        json(
          200,
          scan({
            status: "failed",
            progress: { completed: 18, total: 18 },
            checks: checks((id) => (id === 16 ? "pass" : "unavailable")),
            stop_reason: stopReason,
          }),
        ),
      );

      visit();

      await waitFor(() =>
        expect(document.querySelector(`h1[data-stop-reason="${stopReason}"]`)).not.toBeNull(),
      );
      expect(screen.queryByText("No reliable diagnostic was produced")).toBeNull();
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(screen.getByRole("link", { name: "Start a new scan" }).getAttribute("href")).toBe("/");
      expect(screen.queryByRole("meter")).toBeNull();
    },
  );

  it("says the site blocked the reader and shows no score", async () => {
    apiAnswers(() => json(200, blockedScan));

    visit();

    await waitFor(() => expect(document.querySelector("h1[data-access-blocked]")).not.toBeNull());
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByLabelText("Email")).toBeNull();
  });

  it("shows a finished scan's level and score, and the ask for the full report", async () => {
    apiAnswers(() => json(200, finishedScan));

    visit();

    expect(await screen.findByRole("meter")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Readable");
    expect(await screen.findByLabelText("Email")).toBeTruthy();
  });

  it("says an answer that is no scan's state is not one, rather than drawing it", async () => {
    apiAnswers(() => json(200, scan({ status: "somewhere" })));

    visit();

    expect(
      await screen.findByText("The scanner returned an invalid or unavailable status response."),
    ).toBeTruthy();
  });

  it("says it cannot reach the scanner while it cannot, and recovers once it answers again", async () => {
    vi.useFakeTimers();
    apiAnswers(
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => json(200, scan({})),
    );

    visit();
    await timePasses(0);
    expect(screen.getByText(/temporarily unreachable/)).toBeTruthy();
    await timePasses(2_100);

    expect(screen.getByText("7 of 18 checks reported")).toBeTruthy();
    expect(screen.queryByText(/temporarily unreachable/)).toBeNull();
  });
});
