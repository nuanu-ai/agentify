import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDestinationDeliverer,
  type OutboxRow,
  startAnalyticsOutboxConsumer,
} from "./analytics-outbox.js";

const row = (overrides: Partial<OutboxRow> = {}): OutboxRow => ({
  id: "018f3f56-2ec8-7b16-8f66-5b8f93f3251f",
  event_id: "018f3f56-2ec8-7b16-8f66-5b8f93f3252f",
  destination: "posthog",
  payload: { event: "scan_completed" },
  attempts: 1,
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

  it("sends a meta row to the graph endpoint its configuration names", async () => {
    let providerRequest: { url: string; headers?: HeadersInit } | undefined;
    const deliver = createDestinationDeliverer(
      {
        runtimeEnvironment: "test",
        posthog: {
          destinationEnvironment: "test",
          host: "https://test.posthog.invalid",
          enabled: true,
        },
        meta: {
          destinationEnvironment: "test",
          graphBaseUrl: "https://graph.meta.invalid/",
          apiVersion: "v21.0",
          datasetId: "1234567890",
          accessToken: "meta-access-token",
          enabled: true,
        },
      },
      async (input, init) => {
        providerRequest = { url: String(input), headers: init?.headers };
        return new Response(null, { status: 200 });
      },
    );

    await expect(deliver(row({ destination: "meta" }))).resolves.toEqual({
      ok: true,
    });
    expect(providerRequest?.url).toBe(
      "https://graph.meta.invalid/v21.0/1234567890/events?access_token=meta-access-token",
    );
    expect(providerRequest?.headers).toEqual({
      "content-type": "application/json",
    });
  });
});

describe("analytics outbox consumer", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps delivering after a cycle fails, and reports the failure", async () => {
    vi.useFakeTimers();
    let claims = 0;
    const delivered: string[] = [];
    const errors: unknown[] = [];
    const stop = startAnalyticsOutboxConsumer({
      repository: {
        claim: async () => {
          claims += 1;
          if (claims === 1) throw new Error("connection terminated");
          return claims === 2 ? [row()] : [];
        },
        delivered: async (id: string) => {
          delivered.push(id);
        },
      } as never,
      deliver: async () => ({ ok: true }),
      onError: (error) => errors.push(error),
    });

    await vi.advanceTimersByTimeAsync(2_000);
    stop();
    expect(errors).toHaveLength(1);
    expect(delivered).toEqual([row().id]);
  });
});
