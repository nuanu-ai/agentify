// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PublicShareActions } from "./public-share-actions";

const scanId = "019f5b6a-4b9f-7000-8000-0000000000cc";
const slug = "abcdefghijklmnopqrstuvwxyz_1234567890";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const preview = (existing: boolean) => ({
  host: "example.com",
  score: 46,
  level: "readable",
  rubric_version: "gtm-v1.0.0",
  generated_at: "2026-07-13T12:00:00.000Z",
  existing_share: existing
    ? { slug, public_url: `${window.location.origin}/s/${slug}`, status: "published" }
    : null,
});

/** The preview the buttons wait for, and `pressed` for the press that publishes or revokes. */
function siteWith({ existing, pressed }: { existing: boolean; pressed: () => Promise<Response> }) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    String(input).endsWith("/share-preview") ? json(200, preview(existing)) : await pressed(),
  );
  render(
    <PublicShareActions
      enabled
      preview={{ hostLabel: "example.com", level: "readable", score: 46 }}
      scanId={scanId}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("publishing and revoking a scan's public link", () => {
  it("says it cannot tell whether the link was made when the answer was lost, and how to find out", async () => {
    // The link may be live and readable by anyone; "it could not be
    // prepared" would tell the person it is not.
    siteWith({ existing: false, pressed: () => Promise.reject(new TypeError("Failed to fetch")) });
    const copy = await screen.findByRole("button", { name: /copy share link/i });
    await vi.waitFor(() => expect((copy as HTMLButtonElement).disabled).toBe(false));

    await userEvent.click(copy);

    const told = await screen.findByText(/cannot tell whether/i);
    expect(told.textContent).toMatch(/reload/i);
    expect((copy as HTMLButtonElement).disabled).toBe(false);
  });

  it("says it cannot tell whether the link was revoked when the answer was lost", async () => {
    siteWith({ existing: true, pressed: () => Promise.reject(new TypeError("Failed to fetch")) });

    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    const told = await screen.findByText(/cannot tell whether/i);
    expect(told.textContent).toMatch(/reload/i);
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
  });

  it("passes on the site's own refusal to publish in its own words, and says a reload shows the link", async () => {
    // A press again after a lost publish meets "a link already exists", which
    // carries no link; the page cannot show it, so it says where to see it.
    siteWith({
      existing: false,
      pressed: async () =>
        json(409, {
          error: {
            code: "share_already_published",
            message: "A public link already exists.",
            retryable: false,
            request_id: "019f5b6a-4b9f-7000-8000-0000000000dd",
          },
        }),
    });
    const copy = await screen.findByRole("button", { name: /copy share link/i });
    await vi.waitFor(() => expect((copy as HTMLButtonElement).disabled).toBe(false));

    await userEvent.click(copy);

    const told = await screen.findByText(/A public link already exists\./);
    expect(told.textContent).toMatch(/reload/i);
    expect(screen.queryByText(/cannot tell/i)).toBeNull();
  });

  it("says a reload shows the link's state when a revoke is refused as not found", async () => {
    // A press again after a lost revoke meets "not found" while the page still
    // shows the link as live.
    siteWith({
      existing: true,
      pressed: async () =>
        json(404, {
          error: {
            code: "share_not_found",
            message: "The public link was not found.",
            retryable: false,
            request_id: "019f5b6a-4b9f-7000-8000-0000000000de",
          },
        }),
    });

    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    const told = await screen.findByText(/The public link was not found\./);
    expect(told.textContent).toMatch(/reload/i);
  });
});
