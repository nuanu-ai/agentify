import { describe, expect, it } from "vitest";

import {
  type AdvisoryLockClient,
  type AdvisoryLockPool,
  createDestinationDeliverer,
  createPartnerRateLimitedDeliverer,
  type OutboxRow,
  PARTNER_POSTBACK_ENDPOINT,
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

  it("returns a safe retryable result when the partner lock cannot be acquired", async () => {
    const state = { delivered: false, connectionDestroyed: false };
    const client: AdvisoryLockClient = {
      async query(): Promise<never> {
        throw new Error("database connection details");
      },
      release(error) {
        state.connectionDestroyed = error instanceof Error;
      },
    };
    const pool: AdvisoryLockPool = { connect: async () => client };

    const result = await createPartnerRateLimitedDeliverer(pool, async () => {
      state.delivered = true;
      return { ok: true };
    })(row({ destination: "partner_tracker" }));

    expect(result).toEqual({
      ok: false,
      code: "partner_tracker_rate_limiter_error",
      retryable: true,
    });
    expect(state).toEqual({ delivered: false, connectionDestroyed: true });
    expect(JSON.stringify(result)).not.toContain("database connection details");
  });

  it("does not retry an accepted partner delivery when unlocking fails", async () => {
    const state = {
      queries: 0,
      delivered: false,
      connectionDestroyed: false,
    };
    const client: AdvisoryLockClient = {
      async query<T extends Record<string, unknown>>() {
        state.queries += 1;
        if (state.queries === 1) return { rows: [] as T[] };
        throw new Error("unlock failed");
      },
      release(error) {
        state.connectionDestroyed = error instanceof Error;
      },
    };
    const pool: AdvisoryLockPool = { connect: async () => client };

    const result = await createPartnerRateLimitedDeliverer(
      pool,
      async () => {
        state.delivered = true;
        return { ok: true };
      },
      { now: () => 10_000, wait: async () => undefined },
    )(row({ destination: "partner_tracker" }));

    expect(result).toEqual({ ok: true });
    expect(state.delivered).toBe(true);
    expect(state.connectionDestroyed).toBe(true);
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
