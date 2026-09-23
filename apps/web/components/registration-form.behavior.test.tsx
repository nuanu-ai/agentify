// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RegistrationForm } from "./registration-form";

const scanId = "019f5b6a-4b9f-7000-8000-0000000000aa";

function answerWith(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

async function askForALink() {
  sessionStorage.setItem(`agentify:scan-token:${scanId}`, "scan-token");
  render(<RegistrationForm scanId={scanId} />);
  await userEvent.type(screen.getByLabelText("Email"), "owner@example.com");
  await userEvent.click(screen.getByLabelText(/acknowledge the scanner data notice/i));
  await userEvent.click(screen.getByRole("button"));
  return () => screen.getByRole("button") as HTMLButtonElement;
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  cleanup();
});

describe("asking the scanner for a verification link", () => {
  it("counts down the wait the refusal carried, not one of its own", async () => {
    answerWith(429, {
      error: {
        code: "verification_link_cooldown",
        message:
          "No new link was sent, because one was asked for recently. You can ask for another in 45 seconds.",
        retryable: true,
        retry_after_seconds: 45,
        request_id: "019f5b6a-4b9f-7000-8000-000000000001",
      },
    });

    const button = await askForALink();

    await waitFor(() => expect(button().disabled).toBe(true));
    expect(button().textContent).toContain("45");
    expect(button().textContent).not.toContain("60");
    expect(screen.getByText(/45 seconds/)).toBeTruthy();
  });

  it("leaves the button working when the refusal names no wait", async () => {
    answerWith(429, {
      error: {
        code: "verification_link_cooldown",
        message:
          "No new link was sent, because one was asked for recently. We cannot tell how long the wait is, so try again later.",
        retryable: true,
        request_id: "019f5b6a-4b9f-7000-8000-000000000002",
      },
    });

    const button = await askForALink();

    await waitFor(() => expect(screen.getByText(/cannot tell/)).toBeTruthy());
    expect(button().disabled).toBe(false);
  });

  it("leaves the button working after a link goes out, having been told no wait", async () => {
    answerWith(202, { status: "verification_sent" });

    const button = await askForALink();

    await waitFor(() => expect(screen.getByText(/Check your inbox/)).toBeTruthy());
    expect(button().disabled).toBe(false);
    expect(button().textContent).not.toMatch(/\d/);
  });
});
