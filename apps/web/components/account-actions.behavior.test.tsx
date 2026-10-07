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
    if (!parsed.success) return json(400, { error: { code: "invalid", message: "Invalid." } });
    if (parsed.data.signed_in_as !== signedInNow) {
      return json(409, {
        error: {
          code: "page_not_matched",
          message: `The page this came from could not be matched to the address signed in now, ${signedInNow}, so nothing was changed. Reload the page to act as this address.`,
        },
      });
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

    expect(await screen.findByText("Request recorded.")).toBeTruthy();
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

  it("say nothing was changed when the press never got an answer", async () => {
    siteWith({ visitor: signedIn });
    render(<AccountActions mode="data" />);
    const pressed = await screen.findByRole("button", { name: "Request data access" });
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await userEvent.click(pressed);

    expect(await screen.findByText(/nothing was changed/i)).toBeTruthy();
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
