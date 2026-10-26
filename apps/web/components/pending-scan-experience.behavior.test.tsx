// @vitest-environment jsdom

import type { Segment } from "@agentify/scanner-contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type PendingScanRequest, readPendingScan, savePendingScan } from "../lib/pending-scan";
import { onSite } from "../testing/on-site";
import { PendingScanExperience } from "./pending-scan-experience";

const pending = (variant: string, segment: Segment = "owner"): PendingScanRequest => ({
  url: "example.com",
  segment,
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
    render(onSite(<PendingScanExperience turnstileSiteKey={null} />));

    await screen.findByRole("heading", { name: "No scan request in this tab" });
    expect(screen.queryByRole("button", { name: "Retry scan" })).toBeNull();
  });

  it.each([
    ["challenge_required", "Confirm you are a person", false],
    ["hard_rate_limit", "Too many scans for now", false],
    ["temporarily_busy", "The scanner is busy", true],
    ["unclassified_failure", "The scan could not start", true],
  ] as const)(
    "turns %s into a distinct state headed %s with the promised retry access",
    async (code, heading, retryable) => {
      savePendingScan(window.sessionStorage, pending(code));
      installNetwork(response(errorEnvelope(code, retryable), 429));

      render(onSite(<PendingScanExperience turnstileSiteKey={null} />));

      await screen.findByRole("heading", { name: heading });
      const retry = screen.queryByRole("button", { name: "Retry scan" });
      expect(Boolean(retry)).toBe(retryable);
      expect(readPendingScan(window.sessionStorage)).not.toBeNull();
    },
  );

  it("does not say no scan was started when the scanner is busy, since the scan may already exist", async () => {
    // The scanner answers busy also to a repeat whose scan was created by an
    // earlier press whose answer was lost.
    savePendingScan(window.sessionStorage, pending("busy-replay"));
    installNetwork(response(errorEnvelope("temporarily_busy", true), 503));

    render(onSite(<PendingScanExperience turnstileSiteKey={null} />));

    await screen.findByRole("heading", { name: "The scanner is busy" });
    expect(screen.getByRole("status").textContent).not.toMatch(/no scan was started/i);
    expect(screen.getByRole("button", { name: "Retry scan" })).toBeTruthy();
  });

  it("passes on the scanner's own words for why it is busy, a pause among them", async () => {
    savePendingScan(window.sessionStorage, pending("paused"));
    installNetwork(
      response(
        {
          error: {
            code: "temporarily_busy",
            message: "New scans are temporarily paused. Existing private reports remain available.",
            retryable: true,
            retry_after_seconds: 60,
            request_id: "request-behavior-test",
          },
        },
        503,
      ),
    );

    render(onSite(<PendingScanExperience turnstileSiteKey={null} />));

    await screen.findByRole("heading", { name: "The scanner is busy" });
    expect(screen.getByRole("status").textContent).toContain("New scans are temporarily paused.");
  });

  it("offers another address and no retry when the refusal says retrying cannot help", async () => {
    // An address the scanner refuses is refused again on every retry: the
    // only way on is a different address.
    savePendingScan(window.sessionStorage, pending("refused", "store"));
    installNetwork(response(errorEnvelope("invalid_url", false), 400));

    render(onSite(<PendingScanExperience turnstileSiteKey={null} />));

    await screen.findByText("public-invalid_url");
    expect(screen.queryByRole("button", { name: "Retry scan" })).toBeNull();
    expect(screen.getByRole("link", { name: "Enter another website" }).getAttribute("href")).toBe(
      "/store",
    );
  });

  it.each([
    ["the address names the local form", "/scan/pending?segment=local", "/local"],
    ["the address names no form", "/scan/pending", "/"],
    ["the address names a form the site does not have", "/scan/pending?segment=elsewhere", "/"],
  ])("without a request in the tab, offers the form %s", async (_when, at, form) => {
    installNetwork(response(errorEnvelope("unused", false), 500));

    render(onSite(<PendingScanExperience turnstileSiteKey={null} />, { at }));

    await screen.findByRole("heading", { name: "No scan request in this tab" });
    expect(screen.getByRole("link", { name: "Enter another website" }).getAttribute("href")).toBe(
      form,
    );
  });

  it("says it cannot tell whether the scan started, not that the scanner is busy, when no answer came back", async () => {
    // Nothing was heard back, so nothing is known about how busy it is, and
    // the scan may have started before the answer was lost.
    savePendingScan(window.sessionStorage, pending("unreachable"));
    globalThis.fetch = async (input) => {
      if (String(input) === "/api/v1/attribution") return new Response(null, { status: 201 });
      throw new TypeError("the network is down");
    };

    render(onSite(<PendingScanExperience turnstileSiteKey={null} />));

    await screen.findByRole("heading", { name: "The scanner did not answer" });
    expect(screen.getByRole("status").textContent).toMatch(/cannot tell whether/i);
    expect(screen.getByRole("button", { name: "Retry scan" })).toBeTruthy();
    expect(readPendingScan(window.sessionStorage)).not.toBeNull();
  });

  it("says it cannot tell whether the scan started, and keeps the retry, when the answer is not a refusal of ours", async () => {
    // A proxy's error page says nothing about whether the address is good,
    // nor whether the scanner took the scan before the page came back.
    savePendingScan(window.sessionStorage, pending("proxy"));
    installNetwork(new Response("<html>Bad gateway</html>", { status: 502 }));

    render(onSite(<PendingScanExperience turnstileSiteKey={null} />));

    expect(await screen.findByRole("button", { name: "Retry scan" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "The scan could not start" })).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/cannot tell whether/i);
  });

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

    render(onSite(<PendingScanExperience turnstileSiteKey={null} />));

    await waitFor(() => expect(readPendingScan(window.sessionStorage)).toBeNull());
  });
});
