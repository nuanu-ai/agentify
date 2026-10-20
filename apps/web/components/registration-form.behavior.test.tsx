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

  it("files a signed-in person's own ask under the address it showed, sends none, and says so first", async () => {
    // The ask names the address the form showed, so a session changed in
    // another tab is refused rather than given the report. The API here
    // refuses an ask that names another address or none, or that does not
    // acknowledge the data notice, so the report opens only for the ask the
    // form must send.
    let settled = () => {};
    const answered = new Promise<void>((resolve) => {
      settled = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/api/v2/session")) {
        return json(200, { status: "signed_in", email: "owner@example.com", operator: false });
      }
      const ask = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      settled();
      return ask.email !== "owner@example.com" || ask.dataset_reuse_acknowledged !== true
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

    await answered;
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Opening the report keeps the button waiting; a refusal would say why.
    expect(screen.getByRole("button").textContent).toBe("Sending…");
    expect(screen.queryByText(/not one the form should send/)).toBeNull();
  });

  it("offers only a reload once the site says somebody else is signed in now", async () => {
    // The form still says the report goes under the address it was loaded
    // for; leaving its button there would invite pressing it again for nothing.
    answerWith(
      409,
      {
        error: {
          code: "signed_in_as_another_address",
          message:
            "You are signed in as somebody-else@example.com, so nothing was filed under owner@example.com.",
          retryable: false,
          request_id: "019f5b6a-4b9f-7000-8000-000000000004",
        },
      },
      { status: 200, body: { status: "signed_in", email: "owner@example.com", operator: false } },
    );
    sessionStorage.setItem(`agentify:scan-token:${scanId}`, "scan-token");
    render(<RegistrationForm scanId={scanId} />);
    await userEvent.click(await screen.findByLabelText(/acknowledge the scanner data notice/i));
    await userEvent.click(screen.getByRole("button"));

    expect(await screen.findByText(/somebody-else@example\.com/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("link", { name: /reload/i })).toBeTruthy();
  });

  it.each([
    ["never arrived", () => Promise.reject(new TypeError("Failed to fetch"))],
    [
      "was a success the form cannot read, such as a sign-in portal's page",
      async () =>
        new Response("<html>Sign in to the network</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ],
    [
      "came from something other than the site",
      async () =>
        new Response("<html>Bad gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    ],
  ])(
    "says it cannot tell whether a signed-in ask was filed when the answer %s, and lets it be pressed again",
    async (_case, lost) => {
      // The site may have filed the report before the answer was lost, so
      // neither "nothing happened" nor silence is true.
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
        String(input).endsWith("/api/v2/session")
          ? json(200, { status: "signed_in", email: "owner@example.com", operator: false })
          : await lost(),
      );
      sessionStorage.setItem(`agentify:scan-token:${scanId}`, "scan-token");
      render(<RegistrationForm scanId={scanId} />);
      await userEvent.click(await screen.findByLabelText(/acknowledge the scanner data notice/i));
      await userEvent.click(screen.getByRole("button"));

      expect(await screen.findByText(/cannot tell whether/i)).toBeTruthy();
      expect(screen.getByText(/press .* again/i)).toBeTruthy();
      expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false);
    },
  );

  it("says it cannot tell whether a link was sent when a stranger's answer never arrived", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/api/v2/session")) return json(200, { status: "signed_out" });
      throw new TypeError("Failed to fetch");
    });

    const button = await askForALink();

    expect(await screen.findByText(/cannot tell whether/i)).toBeTruthy();
    expect(screen.getByText(/inbox/i)).toBeTruthy();
    expect(button().disabled).toBe(false);
  });

  it("says a link was sent, and no longer that the report opens without one, when the session ended in another tab", async () => {
    // The page was loaded signed in; by the press the session had ended, so the
    // site took the ask as a stranger's and mailed a link to the address shown.
    answerWith(
      202,
      { status: "verification_sent" },
      { status: 200, body: { status: "signed_in", email: "owner@example.com", operator: false } },
    );
    sessionStorage.setItem(`agentify:scan-token:${scanId}`, "scan-token");
    render(<RegistrationForm scanId={scanId} />);
    expect(await screen.findByText(/without a message/)).toBeTruthy();
    await userEvent.click(screen.getByLabelText(/acknowledge the scanner data notice/i));
    await userEvent.click(screen.getByRole("button"));

    expect(await screen.findByText(/Check your inbox/)).toBeTruthy();
    expect(screen.queryByText(/without a message/)).toBeNull();
    expect(screen.getByRole("button").textContent).not.toBe("Open the full report");
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
