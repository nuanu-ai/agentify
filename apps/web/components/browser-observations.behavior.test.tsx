// @vitest-environment jsdom

/**
 * The browser's observations on the scan page, with the API answered at the
 * network's edge: when the page asks again for them, and when it stops.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BrowserObservations } from "./browser-observations";

const scanId = "019f5b6a-4b9f-7000-8000-0000000000bb";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const refusal = (code: string, retryable: boolean) => ({
  error: { code, message: `Refused: ${code}.`, retryable, request_id: "req-1" },
});

const observed = {
  version: "browser-public-v2.0.0",
  status: "completed",
  non_scoring: true,
  pages_assessed: 2,
  findings: [],
  updated_at: "2026-10-26T12:00:00.000Z",
};

let asks = 0;

/** The API answering the observation with each of `answers` in turn, the last one from then on. */
function apiAnswers(...answers: (() => Response)[]) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    asks += 1;
    const answer = answers[Math.min(asks, answers.length) - 1];
    if (answer === undefined) throw new Error("no answer given");
    return answer();
  });
}

const timePasses = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

// The panel loads the contract that reads an observation once it has one; it
// is loaded here first, so the fake clock is not racing a module load.
beforeAll(() => import("@agentify/scanner-contracts"));

beforeEach(() => {
  asks = 0;
  vi.useFakeTimers();
  sessionStorage.setItem(`agentify:scan-token:${scanId}`, "scan-token");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
  cleanup();
});

describe("the browser's observations on the scan page", () => {
  it("say while they cannot be read when the page asks again, asking less often, and appear once they read", async () => {
    apiAnswers(
      () => new Response("<html>Bad gateway</html>", { status: 502 }),
      () => json(503, refusal("busy", true)),
      () => json(200, observed),
    );

    render(<BrowserObservations scanId={scanId} surface="scan" />);
    await timePasses(0);
    expect(screen.getByText(/temporarily unavailable.*asks again in 2 s/)).toBeTruthy();

    await timePasses(2_000);
    expect(asks).toBe(2);
    expect(screen.getByText(/asks again in 4 s/)).toBeTruthy();
    await timePasses(3_999);
    expect(asks).toBe(2);
    await timePasses(1);

    expect(asks).toBe(3);
    expect(screen.getByText(/Does not change the score/)).toBeTruthy();
    expect(screen.queryByText(/temporarily unavailable/)).toBeNull();
  });

  it.each([
    ["the API says there are none to show", () => json(404, refusal("not_found", false))],
    ["the API answers with nothing", () => new Response(null, { status: 204 })],
  ])("are not shown, and not asked for again, when %s", async (_when, answer) => {
    apiAnswers(answer);

    const { container } = render(<BrowserObservations scanId={scanId} surface="scan" />);
    await timePasses(0);
    await timePasses(60_000);

    expect(container.textContent).toBe("");
    expect(asks).toBe(1);
  });
});
