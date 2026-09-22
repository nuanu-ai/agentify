import {
  assertDestinationIsolation,
  type ConsentEnvironment,
  retryDelayMs,
  shouldDeadLetter,
} from "@agentify/analytics";
import { type DeliveryDestination, partnerClickIdSchema } from "@agentify/scanner-contracts";
import { z } from "zod";

export const PARTNER_POSTBACK_ENDPOINT = "https://aisamuraihub.com/postback" as const;
const PARTNER_RETRY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const PARTNER_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
] as const;
// The n-th partner retry waits the n-th delay, and every attempt past the end
// of the list waits the last one until the retry window closes.
const partnerRetryDelayMs = (attempts: number): number => {
  const delay = PARTNER_RETRY_DELAYS_MS[Math.min(attempts - 1, PARTNER_RETRY_DELAYS_MS.length - 1)];
  if (delay === undefined)
    throw new Error(`partner delivery attempt ${attempts} has no retry delay`);
  return delay;
};
const PARTNER_GLOBAL_MIN_INTERVAL_MS = 1_100;
const PARTNER_RATE_LIMIT_ADVISORY_KEYS = [1_094_730_062, 1_414_092_377] as const;
const partnerPayloadSchema = z
  .object({
    clickid: partnerClickIdSchema,
    event: z.literal("reg"),
  })
  .strict();

export type OutboxRow = {
  id: string;
  event_id: string;
  destination: DeliveryDestination;
  payload: unknown;
  attempts: number;
  occurred_at: Date;
};

export interface SqlPool {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface AdvisoryLockClient extends SqlPool {
  release(error?: Error): void;
}

export interface AdvisoryLockPool {
  connect(): Promise<AdvisoryLockClient>;
}

export class AnalyticsOutboxRepository {
  constructor(
    private readonly pool: SqlPool,
    private readonly destinations: DeliveryDestination[] = ["posthog", "meta"],
  ) {}

  async claim(limit = 20): Promise<OutboxRow[]> {
    if (!this.destinations.length) return [];
    const result = await this.pool.query<OutboxRow>(
      `with claim as (
         select d.id from delivery_outbox d
         where d.status in ('pending', 'processing')
           and d.next_attempt_at <= now()
           and d.destination = any($2::delivery_destination[])
         order by d.next_attempt_at, d.id
         for update skip locked
         limit $1
       )
       update delivery_outbox d
       set status = 'processing', attempts = d.attempts + 1, next_attempt_at = now() + interval '2 minutes'
       from claim, analytics_events e
       where d.id = claim.id and e.event_id = d.event_id
       returning d.id, d.event_id, d.destination, d.payload, d.attempts, e.occurred_at`,
      [limit, this.destinations],
    );
    return result.rows;
  }

  async delivered(id: string): Promise<void> {
    await this.pool.query(
      `update delivery_outbox
       set status = 'delivered',
           last_error_code = null,
           delivered_at = now(),
           payload = case
             when destination = 'partner_tracker'
               then jsonb_build_object('event', 'reg')
             else payload
           end
       where id = $1 and status = 'processing'`,
      [id],
    );
  }

  async retry(id: string, code: string, nextAttemptAt: Date): Promise<void> {
    await this.pool.query(
      "update delivery_outbox set status = 'pending', last_error_code = $2, next_attempt_at = $3 where id = $1 and status = 'processing'",
      [id, code, nextAttemptAt],
    );
  }

  async deadLetter(id: string, code: string): Promise<void> {
    await this.pool.query(
      `update delivery_outbox
       set status = 'dead_letter',
           last_error_code = $2,
           payload = case
             when destination = 'partner_tracker'
               then jsonb_build_object('event', 'reg')
             else payload
           end
       where id = $1 and status = 'processing'`,
      [id, code],
    );
  }
}

export type DestinationConfig = {
  runtimeEnvironment: ConsentEnvironment;
  posthog?: {
    destinationEnvironment: ConsentEnvironment;
    host: string;
    enabled: boolean;
  };
  meta?: {
    destinationEnvironment: ConsentEnvironment;
    graphBaseUrl: string;
    apiVersion: string;
    datasetId: string;
    accessToken: string;
    enabled: boolean;
  };
  partner?: {
    destinationEnvironment: ConsentEnvironment;
    secret: string;
    enabled: boolean;
  };
};

export type DeliveryResult = { ok: true } | { ok: false; code: string; retryable: boolean };
export type FetchLike = typeof fetch;

const waitFor = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export const createPartnerRateLimitedDeliverer = (
  pool: AdvisoryLockPool,
  deliver: (row: OutboxRow) => Promise<DeliveryResult>,
  options: {
    now?: () => number;
    wait?: (milliseconds: number) => Promise<void>;
  } = {},
) => {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;

  return async (row: OutboxRow): Promise<DeliveryResult> => {
    let client: AdvisoryLockClient | undefined;
    let lockHeld = false;
    let destroyConnection = false;
    let deliveryFinished = false;
    let result: DeliveryResult = {
      ok: false,
      code: "partner_tracker_rate_limiter_error",
      retryable: true,
    };

    try {
      client = await pool.connect();
      await client.query("select pg_advisory_lock($1::integer, $2::integer)", [
        ...PARTNER_RATE_LIMIT_ADVISORY_KEYS,
      ]);
      lockHeld = true;
      const requestStartedAt = now();
      try {
        result = await deliver(row);
      } catch {
        result = {
          ok: false,
          code: "partner_tracker_delivery_error",
          retryable: true,
        };
      }
      deliveryFinished = true;
      const remainingInterval = PARTNER_GLOBAL_MIN_INTERVAL_MS - (now() - requestStartedAt);
      if (remainingInterval > 0) await wait(remainingInterval);
    } catch {
      destroyConnection = client !== undefined;
      if (!deliveryFinished)
        result = {
          ok: false,
          code: "partner_tracker_rate_limiter_error",
          retryable: true,
        };
    } finally {
      if (client && lockHeld) {
        try {
          const unlocked = await client.query<{ unlocked: boolean }>(
            "select pg_advisory_unlock($1::integer, $2::integer) as unlocked",
            [...PARTNER_RATE_LIMIT_ADVISORY_KEYS],
          );
          if (unlocked.rows[0]?.unlocked !== true) destroyConnection = true;
        } catch {
          destroyConnection = true;
          if (!deliveryFinished)
            result = {
              ok: false,
              code: "partner_tracker_rate_limiter_error",
              retryable: true,
            };
        }
      }
      if (client) {
        if (destroyConnection) client.release(new Error("partner_tracker_rate_limiter_error"));
        else client.release();
      }
    }

    return result;
  };
};

const safeStatusCode = (destination: DeliveryDestination, status: number): string =>
  `${destination}_http_${Math.max(0, Math.min(999, Math.trunc(status)))}`;

export const createDestinationDeliverer = (
  config: DestinationConfig,
  fetcher: FetchLike = fetch,
) => {
  if (config.posthog?.enabled) {
    assertDestinationIsolation(config.runtimeEnvironment, config.posthog.destinationEnvironment);
    const host = new URL(config.posthog.host);
    if (host.protocol !== "https:" && config.runtimeEnvironment !== "local") {
      throw new Error("posthog_https_required");
    }
  }
  if (config.meta?.enabled) {
    assertDestinationIsolation(config.runtimeEnvironment, config.meta.destinationEnvironment);
    if (new URL(config.meta.graphBaseUrl).protocol !== "https:")
      throw new Error("meta_https_required");
  }
  if (config.partner?.enabled) {
    assertDestinationIsolation(config.runtimeEnvironment, config.partner.destinationEnvironment);
    if (config.partner.secret.length < 16) throw new Error("partner_tracker_secret_required");
  }

  return async (row: OutboxRow): Promise<DeliveryResult> => {
    if (row.destination === "partner_tracker") {
      if (!config.partner?.enabled)
        return {
          ok: false,
          code: "partner_tracker_disabled",
          retryable: false,
        };
      const payload = partnerPayloadSchema.safeParse(row.payload);
      if (!payload.success)
        return {
          ok: false,
          code: "partner_tracker_payload_invalid",
          retryable: false,
        };
      try {
        const response = await fetcher(PARTNER_POSTBACK_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-postback-key": config.partner.secret,
          },
          body: JSON.stringify(payload.data),
          redirect: "manual",
          signal: AbortSignal.timeout(5_000),
        });
        if (response.status === 200) return { ok: true };
        return {
          ok: false,
          code: safeStatusCode(row.destination, response.status),
          retryable: response.status === 429 || response.status >= 500,
        };
      } catch (error) {
        return {
          ok: false,
          code:
            error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
              ? "partner_tracker_timeout"
              : "partner_tracker_network_error",
          retryable: true,
        };
      }
    }
    const destination = row.destination === "posthog" ? config.posthog : config.meta;
    if (!destination?.enabled)
      return {
        ok: false,
        code: `${row.destination}_disabled`,
        retryable: false,
      };
    try {
      // The row says where it is going, and the configuration for that
      // destination is what the guard above has just found enabled.
      let url: URL;
      if (row.destination === "posthog") {
        const posthog = config.posthog;
        if (!posthog)
          throw new Error(
            "a posthog row was delivered without a posthog destination in the configuration",
          );
        url = new URL("/capture/", posthog.host);
      } else {
        const meta = config.meta;
        if (!meta)
          throw new Error(
            "a meta row was delivered without a meta destination in the configuration",
          );
        url = new URL(
          `${encodeURIComponent(meta.apiVersion)}/${encodeURIComponent(meta.datasetId)}/events`,
          `${meta.graphBaseUrl.replace(/\/$/, "")}/`,
        );
        url.searchParams.set("access_token", meta.accessToken);
      }
      const response = await fetcher(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(row.payload),
        signal: AbortSignal.timeout(8_000),
      });
      return response.ok
        ? { ok: true }
        : {
            ok: false,
            code: safeStatusCode(row.destination, response.status),
            retryable: true,
          };
    } catch (error) {
      return {
        ok: false,
        code:
          error instanceof Error && error.name === "TimeoutError"
            ? `${row.destination}_timeout`
            : `${row.destination}_network_error`,
        retryable: true,
      };
    }
  };
};

export type OutboxMetric =
  | { name: "analytics_delivered"; destination: DeliveryDestination; value: 1 }
  | {
      name: "analytics_retry";
      destination: DeliveryDestination;
      value: 1;
      code: string;
    }
  | {
      name: "analytics_dead_letter";
      destination: DeliveryDestination;
      value: 1;
      code: string;
    };

export const runOutboxCycle = async (input: {
  repository: AnalyticsOutboxRepository;
  deliver: (row: OutboxRow) => Promise<DeliveryResult>;
  emitMetric?: (metric: OutboxMetric) => void;
  now?: () => Date;
  claimLimit?: number;
}): Promise<number> => {
  const rows = await input.repository.claim(input.claimLimit);
  await Promise.all(
    rows.map(async (row) => {
      const now = (input.now ?? (() => new Date()))();
      const occurredAt = new Date(row.occurred_at);
      const partnerExpired =
        row.destination === "partner_tracker" &&
        now.getTime() - occurredAt.getTime() >= PARTNER_RETRY_WINDOW_MS;
      if (partnerExpired) {
        await input.repository.deadLetter(row.id, "partner_tracker_retry_window_exhausted");
        input.emitMetric?.({
          name: "analytics_dead_letter",
          destination: row.destination,
          value: 1,
          code: "partner_tracker_retry_window_exhausted",
        });
        return;
      }
      const result = await input.deliver(row);
      if (result.ok) {
        await input.repository.delivered(row.id);
        input.emitMetric?.({
          name: "analytics_delivered",
          destination: row.destination,
          value: 1,
        });
      } else if (!result.retryable || shouldDeadLetter(row.attempts)) {
        await input.repository.deadLetter(row.id, result.code);
        input.emitMetric?.({
          name: "analytics_dead_letter",
          destination: row.destination,
          value: 1,
          code: result.code,
        });
      } else {
        const retryAt =
          row.destination === "partner_tracker"
            ? new Date(
                Math.min(
                  now.getTime() + partnerRetryDelayMs(row.attempts),
                  occurredAt.getTime() + PARTNER_RETRY_WINDOW_MS,
                ),
              )
            : new Date(now.getTime() + retryDelayMs(row.attempts));
        await input.repository.retry(row.id, result.code, retryAt);
        input.emitMetric?.({
          name: "analytics_retry",
          destination: row.destination,
          value: 1,
          code: result.code,
        });
      }
    }),
  );
  return rows.length;
};

export const startAnalyticsOutboxConsumer = (input: {
  repository: AnalyticsOutboxRepository;
  deliver: (row: OutboxRow) => Promise<DeliveryResult>;
  intervalMs?: number;
  claimLimit?: number;
  emitMetric?: (metric: OutboxMetric) => void;
}): (() => void) => {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runOutboxCycle(input).finally(() => {
      running = false;
    });
  };
  const timer = setInterval(tick, input.intervalMs ?? 1_000);
  timer.unref();
  tick();
  return () => clearInterval(timer);
};
