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

  it("passes on the site's own refusal to publish in its own words, and says a reload shows the link's state", async () => {
    siteWith({
      existing: false,
      pressed: async () =>
        json(409, {
          error: {
            code: "share_unavailable",
            message: "This scan cannot be shared.",
            retryable: false,
            request_id: "019f5b6a-4b9f-7000-8000-0000000000dd",
          },
        }),
    });
    const copy = await screen.findByRole("button", { name: /copy share link/i });
    await vi.waitFor(() => expect((copy as HTMLButtonElement).disabled).toBe(false));

    await userEvent.click(copy);

    const told = await screen.findByText(/This scan cannot be shared\./);
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

  it("offers the image again by a link after Publish image", async () => {
    siteWith({
      existing: false,
      pressed: async () =>
        json(201, { slug, public_url: `${window.location.origin}/s/${slug}`, status: "published" }),
    });
    const publish = await screen.findByRole("button", { name: "Publish image" });
    await vi.waitFor(() => expect((publish as HTMLButtonElement).disabled).toBe(false));

    await userEvent.click(publish);

    const again = await screen.findByRole("link", { name: "Download image again" });
    expect(again.getAttribute("href")).toBe(`/api/v1/shares/${slug}/image`);
    expect(again.hasAttribute("download")).toBe(true);
  });

  it("says the public link was already live when Publish image is pressed again, and makes no new one", async () => {
    const press = vi.fn(async () =>
      json(201, { slug, public_url: `${window.location.origin}/s/${slug}`, status: "published" }),
    );
    siteWith({ existing: true, pressed: press });
    const publish = await screen.findByRole("button", { name: "Publish image" });
    await vi.waitFor(() => expect((publish as HTMLButtonElement).disabled).toBe(false));

    await userEvent.click(publish);

    expect(await screen.findByText(/already live/i)).toBeTruthy();
    expect(press).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Download image again" })).toBeTruthy();
  });

  it("offers no image again once the link is revoked, nor after a new link is copied", async () => {
    let revoked = false;
    siteWith({
      existing: true,
      pressed: async () => {
        if (!revoked) {
          revoked = true;
          return new Response(null, { status: 204 });
        }
        return json(201, {
          slug,
          public_url: `${window.location.origin}/s/${slug}`,
          status: "published",
        });
      },
    });
    const publish = await screen.findByRole("button", { name: "Publish image" });
    await vi.waitFor(() => expect((publish as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(publish);
    await screen.findByRole("link", { name: "Download image again" });

    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));

    await screen.findByText("Public link revoked.");
    expect(screen.queryByRole("link", { name: "Download image again" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /copy share link/i }));
    await screen.findByText("Public link live");
    expect(screen.queryByRole("link", { name: "Download image again" })).toBeNull();
  });

  it("says the link is selected only while it is, and selects it again on the next press", async () => {
    siteWith({ existing: true, pressed: () => Promise.reject(new TypeError("unused")) });
    const copy = await screen.findByRole("button", { name: /copy share link/i });
    await vi.waitFor(() => expect((copy as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(copy);
    const box = (await screen.findByRole("textbox", {
      name: "Public link",
    })) as HTMLTextAreaElement;
    await screen.findByText(/selected/i);

    box.setSelectionRange(0, 0);
    box.blur();
    await vi.waitFor(() => expect(screen.queryByText(/selected/i)).toBeNull());

    await userEvent.click(copy);
    await screen.findByText(/selected/i);
    expect(document.activeElement).toBe(box);
    expect(box.value.slice(box.selectionStart, box.selectionEnd)).toBe(box.value);
  });
});
