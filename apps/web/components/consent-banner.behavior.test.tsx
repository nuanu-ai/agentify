// @vitest-environment jsdom

import { CONSENT_STORAGE_KEY, readCurrentConsent } from "@agentify/analytics/browser";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsentBanner } from "./consent-banner";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

describe("consent persistence", () => {
  beforeEach(() => {
    Object.assign(globalThis, { React });
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("keeps optional analytics off and the banner visible when saving fails", async () => {
    globalThis.fetch = async () => new Response(null, { status: 503 });
    const user = userEvent.setup();
    render(<ConsentBanner />);

    await user.click(screen.getByRole("button", { name: "Allow optional analytics" }));

    await screen.findByRole("status");
    expect(window.localStorage.getItem(CONSENT_STORAGE_KEY)).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Privacy choices" })).not.toBeNull();
  });

  it("stores only the optional categories the visitor selected", async () => {
    globalThis.fetch = async () => new Response(null, { status: 201 });
    const user = userEvent.setup();
    render(<ConsentBanner />);

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
