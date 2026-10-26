// @vitest-environment jsdom

/**
 * A form behind the gate while its press is on its way, sent as a whole page
 * load, which the browser carries out and tells the page almost nothing
 * about. The page stands in for the browser here: the submit is kept from
 * leaving the document, and the clock is the test's.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostForm } from "./post-form.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The settings' site form as the page draws it, under the gate's address, at /settings. */
const sitePage = () => {
  const Stub = createRoutesStub([
    {
      id: "routes/gate",
      path: "/",
      children: [
        {
          path: "settings",
          Component: () => (
            <PostForm document action="/settings/site" className="issue">
              {(pending) => (
                <>
                  <label htmlFor="seller_site">Your shop's site</label>
                  <input id="seller_site" name="seller_site" type="url" defaultValue="" />
                  <label>
                    <input type="checkbox" name="confirm" value="yes" />
                    Confirm
                  </label>
                  <button type="submit" disabled={pending}>
                    Save
                  </button>
                </>
              )}
            </PostForm>
          ),
        },
      ],
    },
  ]);
  render(
    <Stub
      initialEntries={["/settings"]}
      hydrationData={{ loaderData: { "routes/gate": { who: "owner@example.com" } } }}
    />,
  );
  const site = screen.getByLabelText<HTMLInputElement>("Your shop's site");
  return { site, form: site.closest("form") as HTMLFormElement };
};

/** Saves with the focus in the box, as Enter in it does, and lets a task pass. */
const saved = async (site: HTMLInputElement, form: HTMLFormElement) => {
  document.addEventListener("submit", (event) => event.preventDefault(), { once: true });
  fireEvent.change(site, { target: { value: "https://rooms.example.com" } });
  site.focus();
  fireEvent.submit(form);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
};

describe("a whole-page save on its way", () => {
  it("takes no more typing or choosing, keeps the focus and what was typed, and says it is busy", async () => {
    vi.useFakeTimers();
    const { site, form } = sitePage();

    await saved(site, form);

    expect(site.readOnly).toBe(true);
    expect(site.value).toBe("https://rooms.example.com");
    expect(document.activeElement).toBe(site);
    expect(screen.getByRole<HTMLInputElement>("checkbox").disabled).toBe(true);
    expect(form.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says, a few seconds on with no answer, that the change could not be confirmed, with a read of this page, and stays locked even after Escape", async () => {
    vi.useFakeTimers();
    const { site, form } = sitePage();

    await saved(site, form);
    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    const status = screen.getByRole("status");
    expect(status.textContent).toBe(
      "We could not confirm whether your change was made. Open this page again to see where it stands; this sends nothing again.",
    );
    expect(screen.getByRole("link", { name: "Open this page again" }).getAttribute("href")).toBe(
      "/settings",
    );
    expect(site.readOnly).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
  });

  it("is forgotten without a word when the browser brings the page back from its cache", async () => {
    vi.useFakeTimers();
    const { site, form } = sitePage();
    await saved(site, form);

    act(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(site.readOnly).toBe(false);
    expect(form.hasAttribute("aria-busy")).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
