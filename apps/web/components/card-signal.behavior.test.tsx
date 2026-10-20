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

const notMatched = {
  error: {
    code: "page_not_matched",
    message:
      "The page this came from could not be matched to the address signed in now, somebody-else@example.com, so nothing was changed. Reload the page to act as this address.",
    retryable: false,
    request_id: "019f5b6a-4b9f-7000-8000-0000000000f3",
  },
};

const lost = () => Promise.reject(new TypeError("Failed to fetch"));

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("the optional card signal's presses", () => {
  it("say they cannot tell whether the card form was prepared when the answer was lost, and let it be tried again", async () => {
    siteWith(lost);
    render(
      <CardSignal
        adapter="local"
        enabled
        publishableKey={null}
        scanId={scanId}
        signedInAs="owner@example.com"
      />,
    );
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
        signedInAs="owner@example.com"
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
        signedInAs="owner@example.com"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /simulate provider confirmation/i }));

    const told = await screen.findByText(/cannot tell whether/i);
    expect(told.textContent).toMatch(/reload/i);
    expect(screen.queryByText(/confirmation failed/i)).toBeNull();
  });

  it("name the address the page was loaded for with the setup", async () => {
    // The session can change in another tab while the report stays open; the
    // site refuses a setup that names another address than the one signed in
    // now, or none, so the form is ready only for the press the page must send.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if ((init?.method ?? "GET") === "GET") return json(200, { status: "setup_pending" });
      const sent = JSON.parse(String(init?.body ?? "{}")) as { signed_in_as?: unknown };
      return sent.signed_in_as === "owner@example.com"
        ? json(201, {
            signal_id: signalId,
            status: "setup_pending",
            client_secret: "local-secret",
            adapter: "local",
          })
        : json(409, {
            error: {
              code: "page_not_matched",
              message: "The page this came from could not be matched to the address signed in now.",
              retryable: false,
              request_id: "019f5b6a-4b9f-7000-8000-0000000000f2",
            },
          });
    });
    render(
      <CardSignal
        adapter="local"
        enabled
        publishableKey={null}
        scanId={scanId}
        signedInAs="owner@example.com"
      />,
    );
    await userEvent.click(screen.getByRole("checkbox"));

    await userEvent.click(screen.getByRole("button", { name: /secure card form/i }));

    expect(await screen.findByText("Secure card form ready.")).toBeTruthy();
  });

  it("name the address the page was loaded for with a confirmation and a removal", async () => {
    // The site refuses either press when it names another address than the
    // one signed in now, or none.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const method = init?.method ?? "GET";
      if (method === "GET") return json(200, { status: "setup_pending" });
      const sent = JSON.parse(String(init?.body ?? "{}")) as { signed_in_as?: unknown };
      if (sent.signed_in_as !== "owner@example.com") return json(409, notMatched);
      return String(input).endsWith("/local-confirm")
        ? json(200, { status: "attached" })
        : json(200, { status: "detached" });
    });
    render(
      <CardSignal
        adapter="local"
        enabled
        initialSignal={{ signalId, status: "setup_pending", clientSecret: "local-secret" }}
        publishableKey={null}
        scanId={scanId}
        signedInAs="owner@example.com"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /simulate provider confirmation/i }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove card" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, remove card" }));

    expect(await screen.findByText("Card removed and verified with the provider.")).toBeTruthy();
  });

  it("offer only a reload once the site says somebody else is signed in now", async () => {
    // A press again could only be refused again.
    siteWith(async () => json(409, notMatched));
    render(
      <CardSignal
        adapter="local"
        enabled
        publishableKey={null}
        scanId={scanId}
        signedInAs="owner@example.com"
      />,
    );
    await userEvent.click(screen.getByRole("checkbox"));

    await userEvent.click(screen.getByRole("button", { name: /secure card form/i }));

    expect(await screen.findByText(/could not be matched/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("link", { name: /reload/i })).toBeTruthy();
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
    render(
      <CardSignal
        adapter="local"
        enabled
        publishableKey={null}
        scanId={scanId}
        signedInAs="owner@example.com"
      />,
    );
    await userEvent.click(screen.getByRole("checkbox"));

    await userEvent.click(screen.getByRole("button", { name: /secure card form/i }));

    expect(await screen.findByText(/could not be prepared/)).toBeTruthy();
    expect(screen.queryByText(/cannot tell/i)).toBeNull();
  });
});
