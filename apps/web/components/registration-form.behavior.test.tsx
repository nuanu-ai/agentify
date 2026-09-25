// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RegistrationForm } from "./registration-form";

const scanId = "019f5b6a-4b9f-7000-8000-0000000000aa";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * The two answers the form reads: whose session this browser is, which the
 * form asks first, and the answer to the ask itself.
 */
function answerWith(
  status: number,
  body: unknown,
  visitor: { status: number; body: unknown } = { status: 200, body: { status: "signed_out" } },
) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) =>
      String(input).endsWith("/api/v2/session")
        ? json(visitor.status, visitor.body)
        : json(status, body),
    );
}

async function askForALink() {
  sessionStorage.setItem(`agentify:scan-token:${scanId}`, "scan-token");
  render(<RegistrationForm scanId={scanId} />);
  await userEvent.type(await screen.findByLabelText("Email"), "owner@example.com");
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

  it("files a signed-in person's own ask under their address, sends none, and says so first", async () => {
    // The page names the address the report is filed under before the press,
    // and the ask carries the person's own choices and no address: the
    // session decides whose it is (ADR-0026 §1, §2).
    const fetched = answerWith(
      200,
      { status: "report_ready", report_url: `/report/${scanId}`, email: "owner@example.com" },
      { status: 200, body: { status: "signed_in", email: "owner@example.com", operator: false } },
    );
    sessionStorage.setItem(`agentify:scan-token:${scanId}`, "scan-token");
    render(<RegistrationForm scanId={scanId} />);

    expect(await screen.findByText(/owner@example\.com/)).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    await userEvent.click(screen.getByLabelText(/acknowledge the scanner data notice/i));
    await userEvent.click(screen.getByRole("button"));

    const ask = fetched.mock.calls.find(([input]) => String(input).includes("/registrations"));
    const sent = JSON.parse(String(ask?.[1]?.body ?? "{}")) as Record<string, unknown>;
    expect(sent.email).toBeUndefined();
    expect(sent.dataset_reuse_acknowledged).toBe(true);
  });

  it("says it cannot tell who is visiting when the cabinet does not answer, and offers no ask", async () => {
    // Not knowing who somebody is must not look like knowing they are nobody:
    // a stranger's form here would send a link to whatever address is typed
    // over a session the page could not see (ADR-0026 §2).
    answerWith(202, { status: "verification_sent" }, { status: 503, body: { status: "unknown" } });
    sessionStorage.setItem(`agentify:scan-token:${scanId}`, "scan-token");
    render(<RegistrationForm scanId={scanId} />);

    expect(await screen.findByText(/cannot tell who is visiting/i)).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
