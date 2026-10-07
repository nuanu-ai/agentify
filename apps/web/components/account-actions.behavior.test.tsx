// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountActions } from "./account-actions";

const OWNER = "owner@example.com";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * The site as these buttons meet it: who the session is, and the two account
 * routes, which do what they are asked only for a press that names the address
 * signed in, as the routes themselves do.
 */
function siteWith(visitor: { status: number; body: unknown }) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const address = String(input);
    if (address.endsWith("/api/v2/session")) return json(visitor.status, visitor.body);
    const sent = JSON.parse(String(init?.body ?? "null")) as { signed_in_as?: string } | null;
    if (sent?.signed_in_as !== OWNER) {
      return json(409, { error: { code: "page_not_matched", message: "Nothing was changed." } });
    }
    return address.endsWith("/unsubscribe")
      ? json(200, { status: "unsubscribed" })
      : json(200, { status: "requested", type: "access" });
  });
}

const signedIn = { status: 200, body: { status: "signed_in", email: OWNER, operator: false } };

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("the account requests on the site's own pages", () => {
  it("say which address they act for, and send it with the press", async () => {
    siteWith(signedIn);
    render(<AccountActions mode="data" />);

    expect(await screen.findByText(OWNER)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Request data access" }));

    expect(await screen.findByText("Request recorded.")).toBeTruthy();
  });

  it("send it with an unsubscribe too", async () => {
    siteWith(signedIn);
    render(<AccountActions mode="unsubscribe" />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Unsubscribe from marketing" }),
    );

    expect(await screen.findByText("Request recorded.")).toBeTruthy();
  });

  it("offer nothing to press to somebody not signed in", async () => {
    // There is no address to act for, so there is nothing a press could do but
    // be refused.
    siteWith({ status: 200, body: { status: "signed_out" } });
    render(<AccountActions mode="data" />);

    expect(await screen.findByRole("link", { name: /sign in/i })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offer nothing to press while it cannot tell who is visiting", async () => {
    siteWith({ status: 503, body: null });
    render(<AccountActions mode="data" />);

    expect(await screen.findByText(/cannot tell who is visiting/i)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
