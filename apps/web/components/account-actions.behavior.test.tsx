// @vitest-environment jsdom

import {
  accountDataRequestSchema,
  accountUnsubscribeRequestSchema,
} from "@agentify/scanner-contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountActions } from "./account-actions";

const OWNER = "owner@example.com";
const SOMEBODY_ELSE = "somebody-else@example.com";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A refusal in the shape the site's own routes answer in. */
const refusal = (status: number, code: string, message: string) =>
  json(status, {
    error: { code, message, retryable: false, request_id: "019f5b6a-4b9f-7000-8000-0000000000bb" },
  });

/**
 * The site as these buttons meet it: who the page is told is signed in, and
 * the two account routes, which hold a body to the same contracts the real
 * routes do and act only for a press naming the address signed in by the time
 * it arrives.
 */
function siteWith({
  visitor,
  signedInNow = OWNER,
}: {
  visitor: { status: number; body: unknown };
  signedInNow?: string;
}) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const address = String(input);
    if (address.endsWith("/api/v2/session")) return json(visitor.status, visitor.body);
    const sent = JSON.parse(String(init?.body ?? "null")) as unknown;
    const unsubscribe = address.endsWith("/unsubscribe");
    const parsed = (
      unsubscribe ? accountUnsubscribeRequestSchema : accountDataRequestSchema
    ).safeParse(sent);
    if (!parsed.success) return refusal(400, "invalid", "Invalid.");
    if (parsed.data.signed_in_as !== signedInNow) {
      return refusal(
        409,
        "page_not_matched",
        `The page this came from could not be matched to the address signed in now, ${signedInNow}, so nothing was changed. Reload the page to act as this address.`,
      );
    }
    return unsubscribe
      ? json(200, { status: "unsubscribed" })
      : json(200, { status: "requested", type: "type" in parsed.data ? parsed.data.type : "" });
  });
}

const signedIn = { status: 200, body: { status: "signed_in", email: OWNER, operator: false } };

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("the account requests on the site's own pages", () => {
  it("keeps the irreversible deletion off the primary button until it is confirmed", async () => {
    siteWith({ visitor: signedIn });
    render(<AccountActions mode="data" />);

    const asked = await screen.findByRole("button", { name: "Delete my data" });
    expect(asked.classList.contains("button-primary")).toBe(false);
    await userEvent.click(asked);
    expect(
      screen.getByRole("button", { name: "Confirm deletion" }).classList.contains("button-primary"),
    ).toBe(true);
  });

  it("say which address they act for, and send it with the press", async () => {
    siteWith({ visitor: signedIn });
    render(<AccountActions mode="data" />);

    expect(await screen.findByText(OWNER)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Request data access" }));

    expect(await screen.findByText("Request recorded.")).toBeTruthy();
  });

  it("name the address in the deletion's confirmation, and send it with the deletion", async () => {
    siteWith({ visitor: signedIn });
    render(<AccountActions mode="data" />);

    await userEvent.click(await screen.findByRole("button", { name: "Delete my data" }));
    expect(screen.getByText(new RegExp(`For ${OWNER}, this closes report access`))).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Confirm deletion" }));

    expect(await screen.findByText(/Deletion was requested/)).toBeTruthy();
  });

  it("send it with an unsubscribe too", async () => {
    siteWith({ visitor: signedIn });
    render(<AccountActions mode="unsubscribe" />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Unsubscribe from marketing" }),
    );

    expect(await screen.findByText(/unsubscribed/i)).toBeTruthy();
  });

  it("stop offering anything to press once the site says somebody else is signed in now", async () => {
    // The page still says it was loaded for the first address; leaving its
    // buttons there would invite pressing them again for nothing.
    siteWith({ visitor: signedIn, signedInNow: SOMEBODY_ELSE });
    render(<AccountActions mode="data" />);

    await userEvent.click(await screen.findByRole("button", { name: "Request data access" }));

    expect(await screen.findByText(new RegExp(SOMEBODY_ELSE))).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("link", { name: /reload/i })).toBeTruthy();
  });

  it("say they cannot tell whether a deletion went through when its answer was lost, and what a reload shows if it did", async () => {
    // The deletion may have been carried out before the answer was lost;
    // "nothing was changed" would invite repeating an irreversible step
    // on a promise that may be false.
    siteWith({ visitor: signedIn });
    render(<AccountActions mode="data" />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete my data" }));
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await userEvent.click(screen.getByRole("button", { name: "Confirm deletion" }));

    const told = await screen.findByText(/cannot tell whether/i);
    expect(told.textContent).toMatch(/reload/i);
    expect(told.textContent).toMatch(/sign in/i);
    expect(screen.queryByText(/nothing was changed/i)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Confirm deletion" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("say they cannot tell, not that nothing changed, when the answer is not one the site gives", async () => {
    // A proxy's error page in place of the site's answer says nothing about
    // whether the site recorded the request.
    siteWith({ visitor: signedIn });
    render(<AccountActions mode="data" />);
    const pressed = await screen.findByRole("button", { name: "Request data access" });
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response("<html>Bad gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );

    await userEvent.click(pressed);

    expect(await screen.findByText(/cannot tell whether/i)).toBeTruthy();
    expect(screen.queryByText(/nothing was changed/i)).toBeNull();
  });

  it("pass on the site's own refusal in its own words", async () => {
    siteWith({ visitor: signedIn });
    render(<AccountActions mode="data" />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete my data" }));
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      refusal(
        503,
        "deletion_cleanup_failed",
        "Deletion could not be recorded, so report access remains unchanged. Try again shortly.",
      ),
    );

    await userEvent.click(screen.getByRole("button", { name: "Confirm deletion" }));

    expect(await screen.findByText(/report access remains unchanged/)).toBeTruthy();
    expect(screen.queryByText(/cannot tell/i)).toBeNull();
  });

  it("offer nothing to press to somebody not signed in", async () => {
    // There is no address to act for, so there is nothing a press could do but
    // be refused.
    siteWith({ visitor: { status: 200, body: { status: "signed_out" } } });
    render(<AccountActions mode="data" />);

    expect(await screen.findByRole("link", { name: /sign in/i })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offer nothing to press while it cannot tell who is visiting", async () => {
    siteWith({ visitor: { status: 503, body: null } });
    render(<AccountActions mode="data" />);

    expect(await screen.findByText(/cannot tell who is visiting/i)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
