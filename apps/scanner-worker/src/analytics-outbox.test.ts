import { describe, expect, it } from "vitest";

import {
  PARTNER_POSTBACK_ENDPOINT,
  createDestinationDeliverer,
  type OutboxRow,
} from "./analytics-outbox.js";

const row = (overrides: Partial<OutboxRow> = {}): OutboxRow => ({
  id: "018f3f56-2ec8-7b16-8f66-5b8f93f3251f",
  event_id: "018f3f56-2ec8-7b16-8f66-5b8f93f3252f",
  destination: "posthog",
  payload: { event: "scan_completed" },
  attempts: 1,
  occurred_at: new Date("2026-07-12T00:00:00Z"),
  ...overrides,
});

describe("analytics destination delivery", () => {
  it("refuses preview-to-production delivery before any request leaves", () => {
    const provider = { received: false };
    expect(() =>
      createDestinationDeliverer(
        {
          runtimeEnvironment: "preview",
          posthog: {
            destinationEnvironment: "production",
            host: "https://app.posthog.com",
            enabled: true,
          },
        },
        async () => {
          provider.received = true;
          return new Response(null, { status: 200 });
        },
      ),
    ).toThrow("analytics_environment_mismatch");
    expect(provider.received).toBe(false);
  });

  it("returns an allowlisted error without exposing a provider body", async () => {
    const provider = { received: false };
    const deliver = createDestinationDeliverer(
      {
        runtimeEnvironment: "test",
        posthog: {
          destinationEnvironment: "test",
          host: "https://test.posthog.invalid",
          enabled: true,
        },
      },
      async () => {
        provider.received = true;
        return new Response("provider secret body", { status: 503 });
      },
    );

    const result = await deliver(row());

    expect(provider.received).toBe(true);
    expect(result).toEqual({
      ok: false,
      code: "posthog_http_503",
      retryable: true,
    });
    expect(JSON.stringify(result)).not.toContain("provider secret body");
  });

  it("sends the fixed partner payload without placing the secret in the URL", async () => {
    let providerRequest:
      | {
          url: string;
          method?: string;
          headers?: HeadersInit;
          body?: BodyInit | null;
        }
      | undefined;
    const deliver = createDestinationDeliverer(
      {
        runtimeEnvironment: "production",
        partner: {
          destinationEnvironment: "production",
          enabled: true,
          secret: "partner-secret-value",
        },
      },
      async (input, init) => {
        providerRequest = {
          url: String(input),
          method: init?.method,
          headers: init?.headers,
          body: init?.body,
        };
        return new Response(null, { status: 200 });
      },
    );

    await expect(
      deliver(
        row({
          destination: "partner_tracker",
          payload: {
            clickid: "Xk8sJ2QpR4vN7bL0aZ9wQg",
            event: "reg",
          },
        }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(providerRequest).toEqual({
      url: PARTNER_POSTBACK_ENDPOINT,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-postback-key": "partner-secret-value",
      },
      body: JSON.stringify({
        clickid: "Xk8sJ2QpR4vN7bL0aZ9wQg",
        event: "reg",
      }),
    });
    expect(providerRequest?.url).not.toContain("partner-secret-value");
  });

  it("refuses non-production or secretless partner delivery before fetch", () => {
    const provider = { received: false };
    const fetcher = async () => {
      provider.received = true;
      return new Response(null, { status: 200 });
    };
    expect(() =>
      createDestinationDeliverer(
        {
          runtimeEnvironment: "preview",
          partner: {
            destinationEnvironment: "production",
            enabled: true,
            secret: "partner-secret-value",
          },
        },
        fetcher,
      ),
    ).toThrow("analytics_environment_mismatch");
    expect(() =>
      createDestinationDeliverer(
        {
          runtimeEnvironment: "production",
          partner: {
            destinationEnvironment: "production",
            enabled: true,
            secret: "",
          },
        },
        fetcher,
      ),
    ).toThrow("partner_tracker_secret_required");
    expect(provider.received).toBe(false);
  });

  it.each([
    { status: 400, retryable: false },
    { status: 403, retryable: false },
    { status: 404, retryable: false },
    { status: 429, retryable: true },
    { status: 500, retryable: true },
    { status: 503, retryable: true },
  ])(
    "classifies partner HTTP $status with retryable=$retryable",
    async ({ status, retryable }) => {
      const deliver = createDestinationDeliverer(
        {
          runtimeEnvironment: "production",
          partner: {
            destinationEnvironment: "production",
            enabled: true,
            secret: "partner-secret-value",
          },
        },
        async () => new Response(null, { status }),
      );
      await expect(
        deliver(
          row({
            destination: "partner_tracker",
            payload: {
              clickid: "Xk8sJ2QpR4vN7bL0aZ9wQg",
              event: "reg",
            },
          }),
        ),
      ).resolves.toEqual({
        ok: false,
        code: `partner_tracker_http_${status}`,
        retryable,
      });
    },
  );
});
