import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";

export type MetricSample = {
  name: string;
  value: number;
  labels?: Record<string, string>;
};
export type SnapshotMetric = { name: string; help: string; labelNames?: string[] };

export class SnapshotUnavailable extends Error {
  constructor(readonly reason: "row_limit" | "invalid_data") {
    super(reason);
  }
}

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const HTTP_LABELS = ["component", "route", "method", "status_class", "traffic"];

export class Telemetry {
  readonly registry = new Registry();
  readonly #now: () => number;
  readonly #requests = new Counter({
    name: "agentify_http_requests_total",
    help: "HTTP requests completed or abandoned",
    labelNames: HTTP_LABELS,
    registers: [this.registry],
  });
  readonly #duration = new Histogram({
    name: "agentify_http_request_duration_seconds",
    help: "Time until an HTTP answer finishes or is abandoned",
    labelNames: HTTP_LABELS,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [this.registry],
  });
  readonly #inFlight = new Gauge({
    name: "agentify_http_requests_in_flight",
    help: "HTTP requests not yet completed",
    labelNames: ["component"],
    registers: [this.registry],
  });
  readonly #success = new Gauge({
    name: "agentify_snapshot_success",
    help: "Whether the latest operational snapshot was complete",
    labelNames: ["scope"],
    registers: [this.registry],
  });
  readonly #timestamp = new Gauge({
    name: "agentify_snapshot_timestamp_seconds",
    help: "Last successful operational snapshot timestamp",
    labelNames: ["scope"],
    registers: [this.registry],
  });
  readonly #error = new Gauge({
    name: "agentify_snapshot_error",
    help: "Reason the latest snapshot is unavailable",
    labelNames: ["scope", "reason"],
    registers: [this.registry],
  });
  readonly #snapshots = new Map<string, () => Promise<void>>();
  #exporting: Promise<string> | undefined;

  constructor({
    now = Date.now,
    revision = process.env.AGENTIFY_SOURCE_REVISION,
  }: {
    now?: () => number;
    revision?: string;
  } = {}) {
    this.#now = now;
    new Gauge({
      name: "agentify_build_info",
      help: "Source revision baked into this image",
      labelNames: ["revision"],
      registers: [this.registry],
    }).set(
      {
        revision: revision !== undefined && /^[0-9a-f]{40}$/.test(revision) ? revision : "unknown",
      },
      1,
    );
    new Gauge({
      name: "agentify_process_start_time_seconds",
      help: "Process start timestamp",
      registers: [this.registry],
    }).set((Date.now() - process.uptime() * 1_000) / 1_000);
  }

  observeHttp(
    component: string,
    request: IncomingMessage,
    response: ServerResponse,
    route: () => string,
  ): void {
    const method =
      request.method !== undefined && METHODS.has(request.method) ? request.method : "OTHER";
    // This fixed probe tag separates sample populations; it grants no authority.
    const traffic =
      request.headers["user-agent"] === "Agentify-Observability-Probe/1.0" ? "probe" : "client";
    const started = performance.now();
    this.#inFlight.inc({ component });
    let finished = false;
    const end = (aborted: boolean) => {
      if (finished) return;
      finished = true;
      const status = aborted ? "aborted" : `${Math.floor(response.statusCode / 100)}xx`;
      let matched = "unmatched";
      try {
        matched = route();
      } catch {
        /* Telemetry cannot break an answer. */
      }
      const labels = { component, route: matched, method, status_class: status, traffic };
      this.#inFlight.dec({ component });
      this.#requests.inc(labels);
      this.#duration.observe(labels, (performance.now() - started) / 1_000);
    };
    response.once("finish", () => end(false));
    response.once("close", () => end(!response.writableFinished));
  }

  snapshot(
    scope: string,
    definitions: SnapshotMetric[],
    read: () => Promise<MetricSample[]>,
  ): () => void {
    const gauges = new Map(
      definitions.map((definition) => [
        definition.name,
        new Gauge({ ...definition, registers: [] }),
      ]),
    );
    const clear = () => {
      for (const [name, gauge] of gauges) {
        this.registry.removeSingleMetric(name);
        gauge.reset();
      }
    };
    this.#success.set({ scope }, 0);
    this.#timestamp.set({ scope }, 0);
    this.#snapshots.set(scope, async () => {
      try {
        const samples = await read();
        clear();
        for (const sample of samples) {
          const gauge = gauges.get(sample.name);
          if (!gauge || !Number.isFinite(sample.value))
            throw new SnapshotUnavailable("invalid_data");
          gauge.set(sample.labels ?? {}, sample.value);
        }
        for (const definition of definitions) {
          if (
            !definition.labelNames?.length &&
            !samples.some((sample) => sample.name === definition.name)
          ) {
            throw new SnapshotUnavailable("invalid_data");
          }
        }
        for (const gauge of gauges.values()) this.registry.registerMetric(gauge);
        for (const reason of ["row_limit", "invalid_data", "read_failed"])
          this.#error.remove(scope, reason);
        this.#timestamp.set({ scope }, this.#now() / 1_000);
        this.#success.set({ scope }, 1);
      } catch (error) {
        clear();
        this.#success.set({ scope }, 0);
        for (const reason of ["row_limit", "invalid_data", "read_failed"])
          this.#error.remove(scope, reason);
        this.#error.set(
          { scope, reason: error instanceof SnapshotUnavailable ? error.reason : "read_failed" },
          1,
        );
      }
    });
    return () => {
      this.#snapshots.delete(scope);
      clear();
      this.#success.set({ scope }, 0);
    };
  }

  metrics(): Promise<string> {
    // Coalesce the whole export, including serialization, so overlapping
    // scrapes cannot replace a snapshot while it is being rendered.
    this.#exporting ??= Promise.all([...this.#snapshots.values()].map((read) => read()))
      .then(() => this.registry.metrics())
      .finally(() => {
        this.#exporting = undefined;
      });
    return this.#exporting;
  }
}

export const telemetry = new Telemetry();

export function metricsServer(metrics: Telemetry = telemetry): ReturnType<typeof createServer> {
  return createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    if (request.url !== "/metrics") {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" }).end();
      return;
    }
    void metrics.metrics().then(
      (body) => {
        response.writeHead(200, { "content-type": metrics.registry.contentType }).end(body);
      },
      () => {
        response.writeHead(500).end("metrics_unavailable");
      },
    );
  });
}

/** Deployment Compose enables this private listener; a laptop opens no extra port. */
export function listenForMetrics(): ReturnType<typeof createServer> | null {
  const named = process.env.AGENTIFY_METRICS_PORT;
  if (named === undefined) return null;
  const port = /^\d+$/.test(named) ? Number(named) : 0;
  if (port < 1 || port > 65_535) {
    console.error("[app] invalid metrics port; telemetry listener is unavailable");
    return null;
  }
  const server = metricsServer();
  server.on("error", () => console.error("[app] telemetry listener is unavailable"));
  // Inside a container this must accept Docker's forwarding. The host bind
  // in Compose is loopback only; no public router forwards to this port.
  server.listen(port, "0.0.0.0");
  return server;
}
