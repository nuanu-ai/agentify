// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthCallback } from "./auth-callback";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {} }),
}));

const cooldown = {
  error: {
    code: "verification_link_cooldown",
    message: "No new link was sent yet. You can ask for another in 45 seconds.",
    retryable: true,
    retry_after_seconds: 45,
    request_id: "019f5b6a-4b9f-7000-8000-000000000003",
  },
};

function answerRecoveryWith(refusal: unknown) {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
    if (body.action === "session") {
      return new Response(JSON.stringify({ status: "recovery_requested" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(refusal), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
}

async function askForAFreshLink() {
  render(<AuthCallback turnstileSiteKey={null} />);
  await userEvent.type(await screen.findByLabelText("Email"), "owner@example.com");
  await userEvent.click(screen.getByRole("button", { name: /link/i }));
  // The form is unmounted while the request is in flight, so the field a
  // caller types into afterwards has to be looked up again.
  return {
    email: () => screen.getByLabelText("Email"),
    button: () => screen.getByRole("button") as HTMLButtonElement,
  };
}

beforeEach(() => {
  window.history.replaceState({}, "", "/auth/callback?recover=1");
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("recovering a report when the door refuses", () => {
  it("holds the button for the wait the refusal named", async () => {
    answerRecoveryWith(cooldown);

    const { button } = await askForAFreshLink();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("45 seconds");
    expect(button().disabled).toBe(true);
    expect(button().textContent).toContain("45");
  });

  it("drops a refusal that was about another address", async () => {
    answerRecoveryWith(cooldown);

    const { email, button } = await askForAFreshLink();

    await waitFor(() => expect(button().disabled).toBe(true));
    await userEvent.type(email(), "x");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button().disabled).toBe(false);
  });
});
