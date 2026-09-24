// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SiteDoors } from "./site-chrome";

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

describe("the header's doors", () => {
  it("carries the signed-in address and a sign-out that posts to the cabinet", async () => {
    // A person signed in anywhere on the site sees who they are signed in as
    // on every page with a header, and can sign out from it (ADR-0026 §3).
    visitorIs(200, { status: "signed_in", email: "owner@example.com" });

    const { container } = render(<SiteDoors />);

    expect(await screen.findByText("owner@example.com")).toBeTruthy();
    const form = container.querySelector('form[action="/cabinet/sign-out"]');
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.querySelector("button")?.textContent).toMatch(/sign out/i);
  });

  it("says it cannot tell who is visiting when the cabinet does not answer", async () => {
    visitorIs(503, { status: "unknown" });

    const { container } = render(<SiteDoors />);

    expect(await screen.findByText(/cannot tell who is visiting/i)).toBeTruthy();
    expect(container.querySelector('form[action="/cabinet/sign-out"]')).toBeNull();
  });

  it("says the same when the question itself fails on the way", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    render(<SiteDoors />);

    expect(await screen.findByText(/cannot tell who is visiting/i)).toBeTruthy();
  });

  it("shows a stranger the doors and nobody's address", async () => {
    const fetched = visitorIs(200, { status: "signed_out" });

    const { container } = render(<SiteDoors />);

    await vi.waitFor(() => expect(fetched).toHaveBeenCalled());
    expect(container.querySelector('a[href="/docs/"]')).toBeTruthy();
    expect(container.querySelector('a[href="/cabinet/sign-in"]')).toBeTruthy();
    expect(container.querySelector('form[action="/cabinet/sign-out"]')).toBeNull();
    expect(screen.queryByText(/cannot tell/i)).toBeNull();
  });
});
