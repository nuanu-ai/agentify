// @vitest-environment jsdom

import {
  CONSENT_POLICY_VERSION,
  CONSENT_STORAGE_KEY,
  createConsentSnapshot,
  readCurrentConsent,
} from "@agentify/analytics/browser";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConsentBanner } from "./banner.js";
import { PrivacyChoicesButton } from "./privacy-choices.js";

/** A choice as the banner keeps it, made under `policyVersion`. */
const keptUnder = (policyVersion: string): string =>
  JSON.stringify(
    createConsentSnapshot({
      policy: {
        policyVersion,
        requireOptInForAdsMeasurement: true,
        requireOptInForProductAnalytics: true,
      },
      decisions: { product_analytics: true, ads_measurement: true },
      source: "banner",
    }),
  );

describe("consent persistence", () => {
  beforeEach(() => {
    Object.assign(globalThis, { React });
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("asks again a visitor whose choice was made under an earlier policy, and no one who chose under this one", async () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, keptUnder("consent-v0.9.0"));
    render(<ConsentBanner brand="Agentify" />);
    expect(screen.queryByRole("complementary", { name: "Privacy choices" })).not.toBeNull();
    cleanup();

    window.localStorage.setItem(CONSENT_STORAGE_KEY, keptUnder(CONSENT_POLICY_VERSION));
    render(<ConsentBanner brand="Agentify" />);
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Privacy choices" })).toBeNull(),
    );
  });

  it("goes when the visitor chooses in another tab, and comes back when that choice is gone", async () => {
    render(<ConsentBanner brand="Agentify" />);
    const banner = () => screen.queryByRole("complementary", { name: "Privacy choices" });
    expect(banner()).not.toBeNull();

    window.localStorage.setItem(CONSENT_STORAGE_KEY, keptUnder(CONSENT_POLICY_VERSION));
    window.dispatchEvent(new StorageEvent("storage", { key: CONSENT_STORAGE_KEY }));
    await waitFor(() => expect(banner()).toBeNull());

    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    await waitFor(() => expect(banner()).not.toBeNull());
  });

  it("keeps optional analytics off and the banner visible when saving fails", async () => {
    globalThis.fetch = async () => new Response(null, { status: 503 });
    const user = userEvent.setup();
    render(<ConsentBanner brand="Agentify" />);

    await user.click(screen.getByRole("button", { name: "Allow optional analytics" }));

    await screen.findByRole("status");
    expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Privacy choices" })).not.toBeNull();
  });

  it("says it cannot tell whether the choice was saved when the answer was lost", async () => {
    // The site may have recorded the choice, an allowing one included, before
    // the answer was lost, so "nothing was enabled" may not be true there.
    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    const user = userEvent.setup();
    render(<ConsentBanner brand="Agentify" />);

    await user.click(screen.getByRole("button", { name: "Allow optional analytics" }));

    expect((await screen.findByRole("status")).textContent).toMatch(/cannot tell whether/i);
    expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Allow optional analytics" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("says the choice was not saved when the site refuses it in its own words", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "consent_unavailable",
            message: "Consent preferences could not be saved.",
            retryable: true,
            retry_after_seconds: 5,
            request_id: "019f5b6a-4b9f-7000-8000-0000000000f1",
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    const user = userEvent.setup();
    render(<ConsentBanner brand="Agentify" />);

    await user.click(screen.getByRole("button", { name: "Allow optional analytics" }));

    const told = await screen.findByRole("status");
    expect(told.textContent).not.toMatch(/cannot tell/i);
    expect(told.textContent).toMatch(/could not save/i);
  });

  it("stores only the optional categories the visitor selected", async () => {
    globalThis.fetch = async () => new Response(null, { status: 201 });
    const user = userEvent.setup();
    render(<ConsentBanner brand="Agentify" />);

    await user.click(screen.getByRole("button", { name: "Preferences" }));
    await user.click(screen.getByRole("checkbox", { name: /product analytics/i }));
    await user.click(screen.getByRole("button", { name: "Save choices" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(readCurrentConsent(window.localStorage)?.categories).toEqual({
      essential_processing: true,
      product_analytics: true,
      ads_measurement: false,
      marketing_email: false,
      dataset_reuse: false,
      card_signal: false,
    });
  });
});

describe("the preferences, from the keyboard", () => {
  beforeEach(() => {
    Object.assign(globalThis, { React });
    window.localStorage.clear();
    globalThis.fetch = async () => new Response(null, { status: 201 });
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("keep Tab and Shift+Tab inside the dialog while it is open", async () => {
    const user = userEvent.setup();
    render(<ConsentBanner brand="Agentify" />);
    await user.click(screen.getByRole("button", { name: "Preferences" }));
    const dialog = screen.getByRole("dialog", { name: "Privacy choices" });

    for (let press = 0; press < 6; press += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement), `Tab ${press + 1}`).toBe(true);
    }
    screen.getByRole("checkbox", { name: /product analytics/i }).focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("hand the focus to the page's content once a choice took the banner away", async () => {
    const user = userEvent.setup();
    render(
      <>
        <main>The page</main>
        <ConsentBanner brand="Agentify" />
      </>,
    );
    screen.getByRole("button", { name: "Essential only" }).focus();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("main")));
  });

  it("hand the focus back to the page's Privacy choices once a choice made there is saved", async () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, keptUnder(CONSENT_POLICY_VERSION));
    const user = userEvent.setup();
    render(
      <>
        <main>The page</main>
        <PrivacyChoicesButton />
        <ConsentBanner brand="Agentify" />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Privacy choices" }));
    await user.click(screen.getByRole("button", { name: "Save choices" }));

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Privacy choices" })),
    );
  });
});
