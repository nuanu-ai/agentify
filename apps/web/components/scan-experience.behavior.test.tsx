// @vitest-environment jsdom

import { CHECK_DEFINITIONS } from "@agentify/scanner-contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScanExperience } from "./scan-experience";

const scanId = "019f5b6a-4b9f-7000-8000-0000000000bb";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * The status of a scan the worker ended because the site answered its home
 * page with a bot challenge: the checks that needed the home page are
 * unavailable, the rest were read, and no verdict was given.
 */
const blockedScan = {
  status: "failed",
  progress: { completed: 18, total: 18 },
  checks: CHECK_DEFINITIONS.map((check) => ({
    id: check.id,
    label_code: check.labelCode,
    status: [5, 6, 12, 13, 14, 15, 18].includes(check.id) ? "unavailable" : "pass",
    robots: null,
  })),
  updated_at: "2026-10-10T12:00:00.000Z",
  target_host: "shop.example",
  blocked: true,
};

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  cleanup();
});

describe("a scan the site turned away", () => {
  it("says the site blocked the reader and shows no score", async () => {
    sessionStorage.setItem(`agentify:scan-token:${scanId}`, "scan-token");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith("/status")
        ? json(200, blockedScan)
        : json(200, { status: "signed_out" }),
    );

    render(
      <ScanExperience
        browserObservationsEnabled={false}
        publicShareEnabled
        registrationEnabled
        remediationPromptEnabled
        scanId={scanId}
        segment="store"
      />,
    );

    await waitFor(() => expect(document.querySelector("h1[data-access-blocked]")).not.toBeNull());
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByLabelText("Email")).toBeNull();
  });
});
