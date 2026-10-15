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

  it("keeps optional analytics off and the banner visible when saving fails", async () => {
    globalThis.fetch = async () => new Response(null, { status: 503 });
    const user = userEvent.setup();
    render(<ConsentBanner brand="Agentify" />);

    await user.click(screen.getByRole("button", { name: "Allow optional analytics" }));

    await screen.findByRole("status");
    expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Privacy choices" })).not.toBeNull();
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
