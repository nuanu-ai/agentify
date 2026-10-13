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
    // The ask carries no address: the session decides whose it is. The API
    // here refuses an ask that names one, or that does not acknowledge the
    // data notice, so the report opens only for the ask the form must send.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/api/v2/session")) {
        return json(200, { status: "signed_in", email: "owner@example.com", operator: false });
      }
      const ask = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return "email" in ask || ask.dataset_reuse_acknowledged !== true
        ? json(400, {
            error: {
              code: "invalid_request",
              message: "This ask is not one the form should send.",
              retryable: false,
              request_id: "019f5b6a-4b9f-7000-8000-000000000003",
            },
          })
        : json(200, {
            status: "report_ready",
            report_url: `/report/${scanId}`,
            email: "owner@example.com",
          });
    });
    sessionStorage.setItem(`agentify:scan-token:${scanId}`, "scan-token");
    render(<RegistrationForm scanId={scanId} />);

    expect(await screen.findByText(/owner@example\.com/)).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    await userEvent.click(screen.getByLabelText(/acknowledge the scanner data notice/i));
    await userEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("Sending…"));
    expect(screen.queryByText(/not one the form should send/)).toBeNull();
  });

  it("links the data notice from the box that acknowledges it", async () => {
    // The visitor is asked to acknowledge a notice, so the notice is one
    // press away from the box, and the same page the footer calls Privacy.
    answerWith(202, { status: "verification_sent" });
    render(<RegistrationForm scanId={scanId} />);

    const acknowledgement = await screen.findByLabelText(/acknowledge the scanner data notice/i);
    const notice = acknowledgement.closest("label")?.querySelector("a");
    expect(notice?.getAttribute("href")).toBe("/privacy");
  });

  it("says it cannot tell who is visiting when the dashboard does not answer, and offers no ask", async () => {
    // A stranger's form here would send a link to whatever address is typed,
    // over a session the page could not see.
    answerWith(202, { status: "verification_sent" }, { status: 503, body: { status: "unknown" } });
    sessionStorage.setItem(`agentify:scan-token:${scanId}`, "scan-token");
    render(<RegistrationForm scanId={scanId} />);

    expect(await screen.findByText(/cannot tell who is visiting/i)).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
