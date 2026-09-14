import { describe, expect, it, vi } from "vitest";
import {
  AnalyticsOutboxRepository,
  PARTNER_POSTBACK_ENDPOINT,
  createDestinationDeliverer,
  createPartnerRateLimitedDeliverer,
  runOutboxCycle,
  type AdvisoryLockClient,
  type AdvisoryLockPool,
  type OutboxRow,
  type SqlPool,
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

const poolWithRows = (rows: OutboxRow[]) => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  let claimed = false;
  const pool: SqlPool = {
    async query<T extends Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ) {
      calls.push({ text, ...(values ? { values } : {}) });
      if (/with claim/i.test(text) && !claimed) {
        claimed = true;
        return { rows: rows as unknown as T[] };
      }
      return { rows: [] };
    },
  };
  return { pool, calls };
};

describe("analytics outbox consumer", () => {
  it("atomically claims with skip locked and marks successful rows delivered", async () => {
    const target = poolWithRows([row()]);
    const count = await runOutboxCycle({
      repository: new AnalyticsOutboxRepository(target.pool),
      deliver: async () => ({ ok: true }),
    });
    expect(count).toBe(1);
    expect(target.calls[0]?.text).toMatch(/for update skip locked/i);
    expect(
      target.calls.some((call) => /status = 'delivered'/.test(call.text)),
    ).toBe(true);
  });

  it("schedules bounded retry without persisting response bodies", async () => {
    const target = poolWithRows([row({ attempts: 3 })]);
    await runOutboxCycle({
      repository: new AnalyticsOutboxRepository(target.pool),
      deliver: async () => ({
        ok: false,
        code: "posthog_http_503",
        retryable: true,
      }),
      now: () => new Date("2026-07-12T00:00:00Z"),
    });
    const retry = target.calls.find((call) =>
      /update delivery_outbox set status = 'pending'/.test(call.text),
    );
    expect(retry?.values).toEqual([
      row().id,
      "posthog_http_503",
      new Date("2026-07-12T00:00:04Z"),
    ]);
    expect(JSON.stringify(target.calls)).not.toContain("response_body");
  });

  it("dead-letters the terminal retry", async () => {
    const target = poolWithRows([row({ destination: "meta", attempts: 17 })]);
    await runOutboxCycle({
      repository: new AnalyticsOutboxRepository(target.pool),
      deliver: async () => ({
        ok: false,
        code: "meta_http_400",
        retryable: true,
      }),
    });
    expect(
      target.calls.some((call) => /status = 'dead_letter'/.test(call.text)),
    ).toBe(true);
  });

  it("refuses preview-to-production delivery before fetch", () => {
    const fetcher = vi.fn();
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
        fetcher,
      ),
    ).toThrow("analytics_environment_mismatch");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends exact stored payload and returns only allowlisted error codes", async () => {
    const fetcher = vi.fn(
      async () => new Response("provider secret body", { status: 503 }),
    );
    const deliver = createDestinationDeliverer(
      {
        runtimeEnvironment: "test",
        posthog: {
          destinationEnvironment: "test",
          host: "https://test.posthog.invalid",
          enabled: true,
        },
      },
      fetcher,
    );
    await expect(deliver(row())).resolves.toEqual({
      ok: false,
      code: "posthog_http_503",
      retryable: true,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("sends the fixed partner payload without placing the secret in the URL", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));
    const deliver = createDestinationDeliverer(
      {
        runtimeEnvironment: "production",
        partner: {
          destinationEnvironment: "production",
          enabled: true,
          secret: "partner-secret-value",
        },
      },
      fetcher,
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
    expect(fetcher).toHaveBeenCalledWith(
      PARTNER_POSTBACK_ENDPOINT,
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "x-postback-key": "partner-secret-value",
        },
        body: JSON.stringify({
          clickid: "Xk8sJ2QpR4vN7bL0aZ9wQg",
          event: "reg",
        }),
      }),
    );
    expect(PARTNER_POSTBACK_ENDPOINT).not.toContain("partner-secret-value");
  });

  it("refuses non-production or secretless partner delivery before fetch", () => {
    const fetcher = vi.fn();
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
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("holds a database advisory lock through the global partner interval", async () => {
    const order: string[] = [];
    const release = vi.fn();
    let currentTime = 10_000;
    const client: AdvisoryLockClient = {
      async query<T extends Record<string, unknown>>(
        text: string,
      ): Promise<{ rows: T[] }> {
        if (/pg_advisory_lock/.test(text)) {
          order.push("lock");
          return { rows: [] };
        }
        order.push("unlock");
        return { rows: [{ unlocked: true }] as unknown as T[] };
      },
      release,
    };
    const pool: AdvisoryLockPool = {
      async connect() {
        order.push("connect");
        return client;
      },
    };
    const wait = vi.fn(async (milliseconds: number) => {
      order.push(`wait:${milliseconds}`);
    });
    const deliver = vi.fn(async () => {
      order.push("deliver");
      currentTime += 200;
      return { ok: true as const };
    });

    await expect(
      createPartnerRateLimitedDeliverer(pool, deliver, {
        now: () => currentTime,
        wait,
      })(
        row({
          destination: "partner_tracker",
          payload: {
            clickid: "Xk8sJ2QpR4vN7bL0aZ9wQg",
            event: "reg",
          },
        }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(order).toEqual(["connect", "lock", "deliver", "wait:900", "unlock"]);
    expect(wait).toHaveBeenCalledWith(900);
    expect(release).toHaveBeenCalledWith();
  });

  it("returns a retryable safe error when the global partner lock fails", async () => {
    const release = vi.fn();
    const client: AdvisoryLockClient = {
      async query<T extends Record<string, unknown>>(): Promise<{ rows: T[] }> {
        throw new Error("database connection details");
      },
      release,
    };
    const pool: AdvisoryLockPool = {
      async connect() {
        return client;
      },
    };
    const deliver = vi.fn(async () => ({ ok: true as const }));

    await expect(
      createPartnerRateLimitedDeliverer(
        pool,
        deliver,
      )(row({ destination: "partner_tracker" })),
    ).resolves.toEqual({
      ok: false,
      code: "partner_tracker_rate_limiter_error",
      retryable: true,
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(expect.any(Error));
    expect(JSON.stringify(release.mock.calls)).not.toContain(
      "database connection details",
    );
  });

  it("does not retry an accepted postback when advisory unlock fails", async () => {
    const release = vi.fn();
    let queryCount = 0;
    const client: AdvisoryLockClient = {
      async query<T extends Record<string, unknown>>(): Promise<{ rows: T[] }> {
        queryCount += 1;
        if (queryCount === 1) return { rows: [] };
        throw new Error("unlock_failed");
      },
      release,
    };
    const pool: AdvisoryLockPool = {
      async connect() {
        return client;
      },
    };

    await expect(
      createPartnerRateLimitedDeliverer(pool, async () => ({ ok: true }), {
        now: () => 10_000,
        wait: async () => undefined,
      })(row({ destination: "partner_tracker" })),
    ).resolves.toEqual({ ok: true });
    expect(release).toHaveBeenCalledWith(expect.any(Error));
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

  it("marks a successful partner delivery and scrubs the raw click ID", async () => {
    const target = poolWithRows([
      row({
        destination: "partner_tracker",
        payload: {
          clickid: "Xk8sJ2QpR4vN7bL0aZ9wQg",
          event: "reg",
        },
      }),
    ]);
    await runOutboxCycle({
      repository: new AnalyticsOutboxRepository(target.pool, [
        "partner_tracker",
      ]),
      deliver: async () => ({ ok: true }),
      claimLimit: 1,
      now: () => new Date("2026-07-12T00:01:00Z"),
    });
    const terminal = target.calls.find((call) =>
      /status = 'delivered'/.test(call.text),
    );
    expect(terminal?.text).toContain("delivered_at = now()");
    expect(terminal?.text).toContain("jsonb_build_object('event', 'reg')");
  });

  it("dead-letters permanent partner responses and scrubs the click ID", async () => {
    const target = poolWithRows([
      row({
        destination: "partner_tracker",
        payload: {
          clickid: "Xk8sJ2QpR4vN7bL0aZ9wQg",
          event: "reg",
        },
      }),
    ]);
    await runOutboxCycle({
      repository: new AnalyticsOutboxRepository(target.pool, [
        "partner_tracker",
      ]),
      deliver: createDestinationDeliverer(
        {
          runtimeEnvironment: "production",
          partner: {
            destinationEnvironment: "production",
            enabled: true,
            secret: "partner-secret-value",
          },
        },
        async () => new Response(null, { status: 404 }),
      ),
      now: () => new Date("2026-07-12T00:01:00Z"),
      claimLimit: 1,
    });
    expect(target.calls[0]?.values?.[0]).toBe(1);
    const terminal = target.calls.find((call) =>
      /status = 'dead_letter'/.test(call.text),
    );
    expect(terminal?.values).toEqual([row().id, "partner_tracker_http_404"]);
    expect(terminal?.text).toContain("jsonb_build_object('event', 'reg')");
  });

  it("uses the partner retry schedule and stops at the 24-hour cutoff", async () => {
    const retryTarget = poolWithRows([
      row({
        destination: "partner_tracker",
        payload: {
          clickid: "Xk8sJ2QpR4vN7bL0aZ9wQg",
          event: "reg",
        },
      }),
    ]);
    await runOutboxCycle({
      repository: new AnalyticsOutboxRepository(retryTarget.pool, [
        "partner_tracker",
      ]),
      deliver: async () => ({
        ok: false,
        code: "partner_tracker_http_503",
        retryable: true,
      }),
      now: () => new Date("2026-07-12T00:00:00Z"),
      claimLimit: 1,
    });
    expect(
      retryTarget.calls.find((call) => /status = 'pending'/.test(call.text))
        ?.values,
    ).toEqual([
      row().id,
      "partner_tracker_http_503",
      new Date("2026-07-12T00:01:00Z"),
    ]);

    const expiredTarget = poolWithRows([
      row({
        destination: "partner_tracker",
        payload: {
          clickid: "Xk8sJ2QpR4vN7bL0aZ9wQg",
          event: "reg",
        },
      }),
    ]);
    const deliver = vi.fn(async () => ({ ok: true as const }));
    await runOutboxCycle({
      repository: new AnalyticsOutboxRepository(expiredTarget.pool, [
        "partner_tracker",
      ]),
      deliver,
      now: () => new Date("2026-07-13T00:00:00Z"),
      claimLimit: 1,
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(
      expiredTarget.calls.find((call) =>
        /status = 'dead_letter'/.test(call.text),
      )?.values,
    ).toEqual([row().id, "partner_tracker_retry_window_exhausted"]);
  });
});
