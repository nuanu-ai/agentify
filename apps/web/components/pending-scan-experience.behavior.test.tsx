// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type PendingScanRequest, readPendingScan, savePendingScan } from "../lib/pending-scan";
import { PendingScanExperience } from "./pending-scan-experience";

const pending = (variant: string): PendingScanRequest => ({
  url: "example.com",
  segment: "owner",
  variant,
  idempotencyKey: `018f3f56-2ec8-7b16-8f66-${variant.padEnd(12, "0").slice(0, 12)}`,
  landingPath: "/owner",
  landingSearch: "",
});

const errorEnvelope = (code: string, retryable: boolean) => ({
  error: {
    code,
    message: `public-${code}`,
    retryable,
    request_id: "request-behavior-test",
  },
});

function response(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installNetwork(scanResponse: Response) {
  globalThis.fetch = async (input) =>
    String(input) === "/api/v1/attribution"
      ? new Response(null, { status: 201 })
      : scanResponse.clone();
}

describe("pending scan acceptance", () => {
  beforeEach(() => {
    Object.assign(globalThis, { React });
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
  });

  it("shows an unretryable missing state when no private request exists", async () => {
    installNetwork(response(errorEnvelope("unused", false), 500));
    render(<PendingScanExperience turnstileSiteKey={null} />);

    await screen.findByText("missing");
    expect(screen.queryByRole("button", { name: "Retry scan" })).toBeNull();
  });

  it.each([
    ["challenge_required", "challenge", false],
    ["hard_rate_limit", "hard limit", false],
    ["temporarily_busy", "busy", true],
    ["unclassified_failure", "error", true],
  ] as const)(
    "turns %s into a distinct %s state with the promised retry access",
    async (code, state, retryable) => {
      savePendingScan(window.sessionStorage, pending(code));
      installNetwork(response(errorEnvelope(code, retryable), 429));

      render(<PendingScanExperience turnstileSiteKey={null} />);

      await screen.findByText(state);
      const retry = screen.queryByRole("button", { name: "Retry scan" });
      expect(Boolean(retry)).toBe(retryable);
      expect(readPendingScan(window.sessionStorage)).not.toBeNull();
    },
  );

  it("removes the pending request once the server accepts it", async () => {
    window.history.replaceState({}, "", "/scan/018f3f56-2ec8-7b16-8f66-5b8f93f3251f?segment=owner");
    savePendingScan(window.sessionStorage, pending("accepted"));
    installNetwork(
      response(
        {
          scan_id: "018f3f56-2ec8-7b16-8f66-5b8f93f3251f",
          access_token: "a".repeat(32),
          status: "accepted",
          status_url: "/api/v1/scans/018f3f56-2ec8-7b16-8f66-5b8f93f3251f",
          estimated_seconds: 30,
        },
        202,
      ),
    );

    render(<PendingScanExperience turnstileSiteKey={null} />);

    await waitFor(() => expect(readPendingScan(window.sessionStorage)).toBeNull());
  });
});
