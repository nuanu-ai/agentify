// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onSite } from "../testing/on-site";
import { RegistrationForm } from "./registration-form";
import { SiteHeader } from "./site-chrome";

function visitorIs(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

/** Who is visiting at the end of the bar's row, rather than in the narrow window's menu. */
const doors = () => {
  const end = document.querySelector<HTMLElement>(".site-header-end > .site-visitor");
  if (end === null) throw new Error("the bar keeps no place for who is visiting");
  return within(end);
};

describe("who is visiting, in the scanner's bar", () => {
  it("names the signed-in address on the account's menu, with the account's settings and a sign-out that posts to the dashboard", async () => {
    visitorIs(200, { status: "signed_in", email: "owner@example.com", operator: false });

    render(onSite(<SiteHeader />));

    const address = await doors().findByText("owner@example.com");
    const account = address.closest("details");
    expect(account?.querySelector('a[href="/dashboard/settings"]')?.textContent).toBe("Settings");
    const form = account?.querySelector('form[action="/dashboard/sign-out"]');
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.querySelector("button")?.textContent).toMatch(/sign out/i);
  });

  it("shows an operator the way to the operator's workspace", async () => {
    visitorIs(200, { status: "signed_in", email: "operator@example.com", operator: true });

    const { container } = render(onSite(<SiteHeader />));

    await doors().findByText("operator@example.com");
    expect(container.querySelector('a[href="/dashboard/admin"]')?.textContent).toBe("Admin");
  });

  it("shows nobody else the way to the operator's workspace", async () => {
    for (const [status, body] of [
      [200, { status: "signed_in", email: "owner@example.com", operator: false }],
      [200, { status: "signed_out" }],
      [503, { status: "unknown" }],
    ] as const) {
      visitorIs(status, body);
      const { container } = render(onSite(<SiteHeader />));
      await vi.waitFor(() =>
        expect(container.querySelector('[aria-busy="false"]'), JSON.stringify(body)).toBeTruthy(),
      );
      expect(container.querySelector('a[href*="admin"]'), JSON.stringify(body)).toBeNull();
      vi.restoreAllMocks();
      cleanup();
    }
  });

  it("says it does not know who is signed in when the dashboard does not answer", async () => {
    visitorIs(503, { status: "unknown" });

    const { container } = render(onSite(<SiteHeader />));

    expect(await doors().findByText(/sign-in unknown/i)).toBeTruthy();
    expect(container.querySelector('form[action="/dashboard/sign-out"]')).toBeNull();
  });

  it("says it does not know who is signed in when the answer is not one it knows", async () => {
    for (const body of [
      { status: "signed_in", operator: false },
      { status: "signed_in", email: "", operator: false },
      { status: "signed_in", email: "owner@example.com", operator: "no" },
      { status: "somebody" },
      null,
    ]) {
      visitorIs(200, body);
      const { container } = render(onSite(<SiteHeader />));

      expect(await doors().findByText(/sign-in unknown/i), JSON.stringify(body)).toBeTruthy();
      expect(container.querySelector('form[action="/dashboard/sign-out"]')).toBeNull();
      vi.restoreAllMocks();
      cleanup();
    }
  });

  it("says the same when the question itself fails on the way", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    render(onSite(<SiteHeader />));

    expect(await doors().findByText(/sign-in unknown/i)).toBeTruthy();
  });

  it("shows a stranger the doors and nobody's address", async () => {
    visitorIs(200, { status: "signed_out" });

    const { container } = render(onSite(<SiteHeader />));

    // The header says when it has stopped finding out who is visiting, which
    // is what a screen reader announces and what the doors below settle on.
    await vi.waitFor(() => expect(container.querySelector('[aria-busy="false"]')).toBeTruthy());
    expect(container.querySelector('a[href="/docs/"]')).toBeTruthy();
    expect(container.querySelector('a[href="/dashboard/sign-in"]')).toBeTruthy();
    expect(container.querySelector('form[action="/dashboard/sign-out"]')).toBeNull();
    expect(doors().queryByText(/sign-in unknown/i)).toBeNull();
  });

  it("asks who is visiting once for a page that shows it twice", async () => {
    // The header's doors, its menu and the full-report form on a scan page
    // all need the answer; more than one question would renew the session
    // more than once in one moment.
    const fetched = visitorIs(200, {
      status: "signed_in",
      email: "owner@example.com",
      operator: false,
    });

    render(
      onSite(
        <>
          <SiteHeader />
          <RegistrationForm scanId="019f5b6a-4b9f-7000-8000-0000000000aa" />
        </>,
      ),
    );

    expect(await screen.findAllByText(/owner@example\.com/)).toHaveLength(3);
    expect(
      fetched.mock.calls.filter(([input]) => String(input).endsWith("/api/v2/session")),
    ).toHaveLength(1);
  });
});
