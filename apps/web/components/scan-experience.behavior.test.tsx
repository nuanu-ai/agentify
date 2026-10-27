// @vitest-environment jsdom

/**
 * The scan page in a browser, with the API answered at the network's edge:
 * where the token comes from and where it is kept, how often the page asks,
 * and each state a scan can show, from waiting for capacity to the result.
 */

import { CHECK_DEFINITIONS } from "@agentify/scanner-contracts";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPublicAppConfig } from "../lib/app-config";
import { onSite } from "../testing/on-site";
import { PublicConfigProvider } from "./public-config";
import { ScanExperience } from "./scan-experience";
import { UrlScanForm } from "./url-scan-form";

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

/** A refusal in the envelope the site's own routes answer with. */
const refusal = (code: string, retryable: boolean, more: Record<string, unknown> = {}) => ({
  error: { code, message: `Refused: ${code}.`, retryable, request_id: "req-1", ...more },
});

/** Every status the page asked for, in order; the page's asks are what is observed. */
let statusAsks: { authorization: string | null }[] = [];
/** Every other address the page asked, a scan started among them. */
let otherAsks: string[] = [];

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
    otherAsks.push(`${init?.method ?? "GET"} ${address}`);
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

/** The scan page and the store's form, under one router, the scan's page first. */
function scanThenForm() {
  const router = createMemoryRouter(
    [
      {
        path: "/scan/:id",
        element: (
          <ScanExperience
            browserObservationsEnabled={false}
            publicShareEnabled
            registrationEnabled
            remediationPromptEnabled
            scanId={scanId}
            segment="store"
          />
        ),
      },
      { path: "/store", element: <UrlScanForm cta="Scan" segment="store" variant="store-v1" /> },
    ],
    { initialEntries: [`/scan/${scanId}?segment=store`] },
  );
  render(
    <PublicConfigProvider config={getPublicAppConfig()}>
      <RouterProvider router={router} />
    </PublicConfigProvider>,
  );
  return router;
}

/**
 * Lets `ms` of the page's time pass, landing every answer and render due by
 * then. The fake clock moves only here: one that also follows the wall clock
 * lets a loaded machine fire the next ask inside a window the test means to be
 * quiet.
 */
const timePasses = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  statusAsks = [];
  otherAsks = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
  localStorage.clear();
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

    expect(await screen.findByRole("heading", { name: /from its private link/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start a new scan" }).getAttribute("href")).toBe(
      "/store",
    );
    expect(statusAsks).toEqual([]);
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
    expect(screen.getByRole("heading", { name: /turned the scanner away/ })).toBeTruthy();

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

    expect((await screen.findAllByText(/waiting for scanner capacity/i)).length).toBeGreaterThan(0);
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

    expect(await screen.findByRole("heading", { name: /no reliable diagnostic/i })).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByRole("link", { name: "Try again" }).getAttribute("href")).toBe("/store");
  });

  it.each(["no_public_site", "forbidden_redirect", "certificate_invalid"])(
    "says why the scanner stopped a scan it knows the reason for (%s), and offers a new scan from the scan's own form with its address in it",
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

      const router = scanThenForm();

      await waitFor(() =>
        expect(document.querySelector(`h1[data-stop-reason="${stopReason}"]`)).not.toBeNull(),
      );
      expect(screen.queryByText("No reliable diagnostic was produced")).toBeNull();
      expect(screen.queryByRole("link", { name: "Try again" })).toBeNull();
      expect(screen.queryByRole("meter")).toBeNull();

      await userEvent.click(screen.getByRole("link", { name: "Start a new scan" }));
      await waitFor(() => expect(router.state.location.pathname).toBe("/store"));
      expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Website URL" }).value).toBe(
        "shop.example",
      );
    },
  );

  it.each([
    ["no_public_site", /no public website/i, /no server.*public internet.*private network/i],
    ["forbidden_redirect", /redirected.*does not go/i, /redirect.*HTTPS to HTTP.*five/i],
    [
      "certificate_invalid",
      /could not verify.*certificate/i,
      /certificate.*expired.*fix the certificate/i,
    ],
    [undefined, /no reliable diagnostic/i, /could read too little.*honest result/i],
  ] as const)(
    "explains the actual stop %s without inventing another cause",
    async (stopReason, headlinePattern, explanation) => {
      apiAnswers(() =>
        json(
          200,
          scan({
            status: "failed",
            progress: { completed: 18, total: 18 },
            checks: checks((id) => (id === 16 ? "pass" : "unavailable")),
            ...(stopReason ? { stop_reason: stopReason } : {}),
          }),
        ),
      );
      visit();
      const headline = await screen.findByRole("heading", { name: headlinePattern });
      expect(headline.nextElementSibling?.textContent).toMatch(explanation);
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

  it("leads the owner of a site that blocked the reader to how the scanner names itself", async () => {
    apiAnswers(() => json(200, blockedScan));

    visit();

    await waitFor(() => expect(document.querySelector("h1[data-access-blocked]")).not.toBeNull());
    const link = document.querySelector('main a[href="/docs/scanner#identity"]');
    expect(link?.textContent?.trim()).toBeTruthy();
  });

  it("shows a finished scan's level and score, and the ask for the full report", async () => {
    apiAnswers(() => json(200, finishedScan));

    visit();

    const meter = await screen.findByRole("meter");
    expect(meter.getAttribute("aria-valuenow")).toBe("46");
    expect(meter.getAttribute("aria-valuemin")).toBe("0");
    expect(meter.getAttribute("aria-valuemax")).toBe("100");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Readable");
    expect(await screen.findByLabelText("Email")).toBeTruthy();
  });

  it("copies readable teaser content, downloads its own file and authenticates its share preview", async () => {
    const requests: { url: string; authorization: string | null }[] = [];
    const copied: string[] = [];
    const downloaded: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded.push(this.getAttribute("href") ?? "");
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
      if (url.endsWith("/api/v2/session")) return json(200, { status: "signed_out" });
      if (url.endsWith("/status")) return json(200, finishedScan);
      if (url.endsWith("/share-preview"))
        return json(200, {
          host: "shop.example",
          score: 46,
          level: "readable",
          rubric_version: "gtm-v1.0.0",
          generated_at: "2026-10-10T12:00:00.000Z",
          existing_share: null,
        });
      if (url.endsWith("/contact-access")) return json(200, { status: "verified" });
      if (url.endsWith("/remediation-prompt?scope=teaser"))
        return json(200, {
          version: "remediation-prompt-v1.0.0",
          scope: "teaser",
          content: "# Teaser improvements\n\nPublish the missing business data.",
          included_findings: ["vertical_jsonld_missing"],
          generated_at: "2026-10-10T12:00:00.000Z",
        });
      throw new Error(`Unexpected scan page request: ${url}`);
    });
    visit();
    await userEvent.click(await screen.findByRole("button", { name: "Copy AI fix prompt" }));
    await waitFor(() =>
      expect(copied).toEqual(["# Teaser improvements\n\nPublish the missing business data."]),
    );
    await userEvent.click(screen.getByRole("button", { name: "Download .md" }));
    expect(downloaded).toEqual([`/api/v1/scans/${scanId}/remediation-prompt/download`]);
    expect(requests).toContainEqual({
      url: `/api/v1/scans/${scanId}/share-preview`,
      authorization: "Bearer scan-token",
    });
  });

  it("says an answer that is no scan's state cannot be read, rather than drawing it", async () => {
    apiAnswers(() => json(200, scan({ status: "somewhere" })));

    visit();

    expect(await screen.findByText(/Live status cannot be read right now/)).toBeTruthy();
    expect(screen.queryByText("somewhere")).toBeNull();
  });

  it("says it cannot reach the scanner while it cannot, and recovers once it answers again", async () => {
    vi.useFakeTimers();
    apiAnswers(
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => json(200, scan({})),
    );

    visit();
    await timePasses(0);
    const heading = screen.getByRole("heading", { name: /Waiting for the scan's status/ });
    // Nothing is known of the scan, so its badge is neither a check being run
    // nor a check that could not be: not knowing does not read as "no".
    const badge = heading.closest("section")?.querySelector("header .badge")?.textContent;
    expect(badge).toBe("Unknown");
    expect(heading.closest("section")?.textContent).toMatch(
      /cannot reach|could not reach|no answer|unavailable|cannot (?:be )?read/i,
    );
    await timePasses(2_100);

    expect(screen.getByText("7 of 18 checks reported")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Waiting for the scan's status/ })).toBeNull();
  });
});

describe("an answer that ends the asking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.setItem(TOKEN_KEY, "scan-token");
  });

  it.each([
    ["the scan is not found", 404, refusal("scan_not_found", false)],
    ["the token is refused", 401, refusal("unauthorized", false)],
    ["a refusal the API marks not worth repeating", 409, refusal("scan_closed", false)],
  ])(
    "ends the page when %s: it stops asking and offers a new scan, saying nothing of why",
    async (_when, status, body) => {
      apiAnswers(() => json(status, body));

      visit();
      await timePasses(0);

      expect(screen.getByText("This scan link no longer works")).toBeTruthy();
      expect(screen.getByRole("link", { name: "Start a new scan" }).getAttribute("href")).toBe(
        "/store",
      );
      expect(screen.queryByText("Reading the scan state…")).toBeNull();
      expect(screen.queryByText(/scan_not_found|Refused/)).toBeNull();
      await timePasses(60_000);
      expect(statusAsks).toHaveLength(1);
    },
  );

  it("ends a scan that disappears while it runs, and leaves none of its progress on the page", async () => {
    apiAnswers(
      () => json(200, scan({})),
      () => json(404, refusal("scan_not_found", false)),
    );

    visit();
    await timePasses(0);
    expect(screen.getByText("7 of 18 checks reported")).toBeTruthy();
    await timePasses(1_000);

    expect(screen.getByText("This scan link no longer works")).toBeTruthy();
    expect(screen.queryByText("7 of 18 checks reported")).toBeNull();
    expect(screen.queryByText("shop.example")).toBeNull();
    await timePasses(60_000);
    expect(statusAsks).toHaveLength(2);
  });
});

describe("leaving the page", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.setItem(TOKEN_KEY, "scan-token");
  });

  it("asks nothing more once the visitor has left, even when an answer was on its way", async () => {
    let answer: (response: Response) => void = () => undefined;
    apiAnswers(() => new Promise<Response>((resolve) => (answer = resolve)));

    const { unmount } = visit();
    await timePasses(0);
    expect(statusAsks).toHaveLength(1);
    unmount();
    answer(json(200, scan({})));
    await timePasses(60_000);

    expect(statusAsks).toHaveLength(1);
  });
});

describe("an answer worth asking again", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.setItem(TOKEN_KEY, "scan-token");
  });

  it("asks less often while the status cannot be read, and says when it asks next", async () => {
    apiAnswers(() => new Response("<html>Bad gateway</html>", { status: 502 }));

    visit();
    await timePasses(0);
    expect(statusAsks).toHaveLength(1);
    expect(screen.getByText(/asks again in 2 s/)).toBeTruthy();

    for (const [wait, asks] of [
      [2, 2],
      [4, 3],
      [8, 4],
      [16, 5],
      [30, 6],
      [30, 7],
    ] as const) {
      await timePasses(wait * 1_000 - 1);
      expect(statusAsks).toHaveLength(asks - 1);
      await timePasses(1);
      expect(statusAsks).toHaveLength(asks);
    }
    expect(screen.getByText(/asks again in 30 s/)).toBeTruthy();
    expect(screen.queryByText("This scan link no longer works")).toBeNull();
  });

  it("waits as long as a refusal worth repeating asks, in the refusal's own words", async () => {
    apiAnswers(
      () => json(429, refusal("too_many_requests", true, { retry_after_seconds: 45 })),
      () => json(200, scan({})),
    );

    visit();
    await timePasses(0);
    expect(screen.getByText(/Refused: too_many_requests\..*asks again in 45 s/)).toBeTruthy();

    await timePasses(44_999);
    expect(statusAsks).toHaveLength(1);
    await timePasses(1);
    expect(statusAsks).toHaveLength(2);
    expect(screen.getByText("7 of 18 checks reported")).toBeTruthy();
  });

  it("goes back to its usual pace once the status reads again, and starts its waits afresh", async () => {
    apiAnswers(
      () => json(503, refusal("busy", true)),
      () => json(503, refusal("busy", true)),
      () => json(200, scan({})),
      () => json(200, scan({})),
      () => json(503, refusal("busy", true)),
    );

    visit();
    await timePasses(0);
    await timePasses(2_000);
    await timePasses(4_000);
    expect(statusAsks).toHaveLength(3);
    expect(screen.queryByText(/asks again/)).toBeNull();

    await timePasses(1_000);
    expect(statusAsks).toHaveLength(4);
    await timePasses(1_000);
    expect(statusAsks).toHaveLength(5);
    expect(screen.getByText(/asks again in 2 s/)).toBeTruthy();
  });

  it.each([
    ["a rate limit", 429],
    ["a timeout", 408],
    ["a refused token", 401],
    ["a missing page", 404],
    ["a gone page", 410],
    ["a bad request", 400],
  ])(
    "keeps asking after %s in no envelope of the site's, and does not call the link invalid",
    async (_what, status) => {
      apiAnswers(
        () => new Response("<html>Wait</html>", { status }),
        () => json(200, scan({})),
      );

      visit();
      await timePasses(0);
      expect(screen.getByText(/asks again in 2 s/)).toBeTruthy();
      expect(screen.queryByText("This scan link no longer works")).toBeNull();
      await timePasses(2_000);

      expect(statusAsks).toHaveLength(2);
      expect(screen.getByText("7 of 18 checks reported")).toBeTruthy();
    },
  );
});

describe("trying a failed scan again", () => {
  beforeEach(() => {
    sessionStorage.setItem(TOKEN_KEY, "scan-token");
  });

  it("returns to the form the scan came from with its address filled in, and starts nothing until the owner presses", async () => {
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
    const router = scanThenForm();

    await userEvent.click(await screen.findByRole("link", { name: "Try again" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/store"));
    expect(router.state.location.search).toBe("");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Website URL" }).value).toBe(
      "shop.example",
    );
    expect(otherAsks.filter((asked) => asked.includes("/api/v1/scans"))).toEqual([]);
  });

  it("returns to the same form from a completed scan that has no result to show", async () => {
    apiAnswers(() =>
      json(200, scan({ status: "completed", progress: { completed: 18, total: 18 } })),
    );
    const router = scanThenForm();

    await userEvent.click(await screen.findByRole("link", { name: "Try again" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/store"));
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Website URL" }).value).toBe(
      "shop.example",
    );
  });
});
