import {
  assertDestinationIsolation,
  type ConsentEnvironment,
  retryDelayMs,
  shouldDeadLetter,
} from "@agentify/analytics";
import type { DeliveryDestination } from "@agentify/scanner-contracts";

export type OutboxRow = {
  id: string;
  event_id: string;
  destination: DeliveryDestination;
  payload: unknown;
  attempts: number;
};

export interface SqlPool {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export class AnalyticsOutboxRepository {
  constructor(
    private readonly pool: SqlPool,
    private readonly destinations: DeliveryDestination[] = ["posthog", "meta"],
  ) {}

  async claim(): Promise<OutboxRow[]> {
    if (!this.destinations.length) return [];
    const result = await this.pool.query<OutboxRow>(
      `with claim as (
         select d.id from delivery_outbox d
         where d.status in ('pending', 'processing')
           and d.next_attempt_at <= now()
           and d.destination = any($1::delivery_destination[])
         order by d.next_attempt_at, d.id
         for update skip locked
         limit 20
       )
       update delivery_outbox d
       set status = 'processing', attempts = d.attempts + 1, next_attempt_at = now() + interval '2 minutes'
       from claim
       where d.id = claim.id
       returning d.id, d.event_id, d.destination, d.payload, d.attempts`,
      [this.destinations],
    );
    return result.rows;
  }

  async delivered(id: string): Promise<void> {
    await this.pool.query(
      `update delivery_outbox
       set status = 'delivered', last_error_code = null, delivered_at = now()
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
      "update delivery_outbox set status = 'dead_letter', last_error_code = $2 where id = $1 and status = 'processing'",
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
};

export type DeliveryResult = { ok: true } | { ok: false; code: string; retryable: boolean };
export type FetchLike = typeof fetch;

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

  return async (row: OutboxRow): Promise<DeliveryResult> => {
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
}): Promise<number> => {
  const rows = await input.repository.claim();
  await Promise.all(
    rows.map(async (row) => {
      const now = (input.now ?? (() => new Date()))();
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
        await input.repository.retry(
          row.id,
          result.code,
          new Date(now.getTime() + retryDelayMs(row.attempts)),
        );
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
  emitMetric?: (metric: OutboxMetric) => void;
  onError?: (error: unknown) => void;
}): (() => void) => {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runOutboxCycle(input)
      .catch((error: unknown) => input.onError?.(error))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(tick, 1_000);
  timer.unref();
  tick();
  return () => clearInterval(timer);
};
