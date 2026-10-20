// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CardSignal } from "./card-signal";

const scanId = "019f5b6a-4b9f-7000-8000-0000000000ee";
const signalId = "019f5b6a-4b9f-7000-8000-0000000000ef";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The provider's state as the page polls it, and `pressed` for the press under test. */
function siteWith(pressed: () => Promise<Response>, status = "setup_pending") {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) =>
    (init?.method ?? "GET") === "GET" ? json(200, { status }) : await pressed(),
  );
}

const lost = () => Promise.reject(new TypeError("Failed to fetch"));

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("the optional card signal's presses", () => {
  it("say they cannot tell whether the card form was prepared when the answer was lost, and let it be tried again", async () => {
    siteWith(lost);
    render(<CardSignal adapter="local" enabled publishableKey={null} scanId={scanId} />);
    await userEvent.click(screen.getByRole("checkbox"));

    await userEvent.click(screen.getByRole("button", { name: /secure card form/i }));

    expect(await screen.findByText(/cannot tell whether/i)).toBeTruthy();
    expect(screen.queryByText(/failed to fetch/i)).toBeNull();
    expect((screen.getByRole("button", { name: /try again/i }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("say they cannot tell whether the card was removed when the answer was lost, and that a reload shows it", async () => {
    // The provider may have removed the card before the answer was lost.
    siteWith(lost, "attached");
    render(
      <CardSignal
        adapter="local"
        enabled
        initialSignal={{ signalId, status: "attached", clientSecret: null }}
        publishableKey={null}
        scanId={scanId}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove card" }));

    await userEvent.click(screen.getByRole("button", { name: "Yes, remove card" }));

    const told = await screen.findByText(/cannot tell whether/i);
    expect(told.textContent).toMatch(/reload/i);
  });

  it("say they cannot tell whether a confirmation went through when its answer was lost, not that it failed", async () => {
    siteWith(lost);
    render(
      <CardSignal
        adapter="local"
        enabled
        initialSignal={{ signalId, status: "setup_pending", clientSecret: "local-secret" }}
        publishableKey={null}
        scanId={scanId}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /simulate provider confirmation/i }));

    const told = await screen.findByText(/cannot tell whether/i);
    expect(told.textContent).toMatch(/reload/i);
    expect(screen.queryByText(/confirmation failed/i)).toBeNull();
  });

  it("pass on the site's own refusal in its own words", async () => {
    siteWith(async () =>
      json(502, {
        error: {
          code: "card_signal_setup_failed",
          message: "The card signal could not be prepared. Your report is still available.",
          retryable: true,
          request_id: "019f5b6a-4b9f-7000-8000-0000000000f0",
        },
      }),
    );
    render(<CardSignal adapter="local" enabled publishableKey={null} scanId={scanId} />);
    await userEvent.click(screen.getByRole("checkbox"));

    await userEvent.click(screen.getByRole("button", { name: /secure card form/i }));

    expect(await screen.findByText(/could not be prepared/)).toBeTruthy();
    expect(screen.queryByText(/cannot tell/i)).toBeNull();
  });
});
