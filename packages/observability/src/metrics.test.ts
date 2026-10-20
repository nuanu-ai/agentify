import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { metricsServer, Telemetry } from "./metrics.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listening(server: ReturnType<typeof createServer>): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no test listener");
  return `http://127.0.0.1:${address.port}`;
}

describe("service telemetry", () => {
  it("counts completed HTTP answers once and keeps expected 402 separate from server failures", async () => {
    const metrics = new Telemetry();
    const origin = await listening(
      createServer((request, response) => {
        metrics.observeHttp("gateway", request, response, () => "/x402/buy/:item_id");
        response.writeHead(Number(request.headers["test-status"]));
        response.end("answer");
      }),
    );
    for (const status of [200, 402, 503]) {
      await (
        await fetch(`${origin}/secret-product?token=private-token`, {
          headers: { "test-status": String(status), authorization: "private-key" },
        })
      ).text();
    }
    const exported = await metrics.metrics();
    for (const status of ["2xx", "4xx", "5xx"]) {
      expect(exported).toContain(
        `agentify_http_requests_total{component="gateway",route="/x402/buy/:item_id",method="GET",status_class="${status}",traffic="client"} 1`,
      );
    }
    expect(exported).toContain('agentify_http_requests_in_flight{component="gateway"} 0');
    expect(exported).toContain('agentify_http_request_duration_seconds_bucket{le="+Inf"');
    expect(exported).not.toMatch(/secret-product|private-token|private-key/);
  });

  it("separates public probes from the client latency population", async () => {
    const metrics = new Telemetry();
    const origin = await listening(
      createServer((request, response) => {
        metrics.observeHttp("scanner", request, response, () => "page_landing");
        response.end("page");
      }),
    );
    for (const agent of [
      "Agentify-Observability-Probe/1.0",
      "real-client",
      "Agentify-Observability-Probe/1.0-private-suffix",
    ]) {
      await (await fetch(origin, { headers: { "user-agent": agent } })).text();
    }
    const exported = await metrics.metrics();
    expect(exported).toContain('status_class="2xx",traffic="probe"} 1');
    expect(exported).toContain('status_class="2xx",traffic="client"} 2');
    expect(exported).not.toMatch(/real-client|private-suffix|Agentify-Observability/);
  });

  it("records an abandoned request and releases its in-flight count", async () => {
    const metrics = new Telemetry();
    let received!: () => void;
    const accepted = new Promise<void>((resolve) => {
      received = resolve;
    });
    const origin = await listening(
      createServer((request, response) => {
        metrics.observeHttp("gateway", request, response, () => "/v0/workers/poll");
        response.once("close", () => received());
        response.writeHead(200);
        response.flushHeaders();
      }),
    );
    const controller = new AbortController();
    const answer = await fetch(origin, { signal: controller.signal });
    expect(await metrics.metrics()).toContain(
      'agentify_http_requests_in_flight{component="gateway"} 1',
    );
    controller.abort();
    await answer.text().catch(() => undefined);
    await accepted;
    const exported = await metrics.metrics();
    expect(exported).toContain('status_class="aborted",traffic="client"} 1');
    expect(exported).toContain('agentify_http_requests_in_flight{component="gateway"} 0');
  });

  it("keeps the original method when request handling rewrites it", async () => {
    const metrics = new Telemetry();
    const origin = await listening(
      createServer((request, response) => {
        metrics.observeHttp("scanner", request, response, () => "other");
        request.method = "GET";
        response.writeHead(404).end();
      }),
    );
    await fetch(origin, { method: "POST" });
    expect(await metrics.metrics()).toContain(
      'route="other",method="POST",status_class="4xx",traffic="client"} 1',
    );
  });

  it("omits unavailable snapshot values instead of retaining a healthy zero", async () => {
    let failed = false;
    let now = 1_000;
    const metrics = new Telemetry({ now: () => now });
    metrics.snapshot(
      "commerce",
      [{ name: "agentify_open_orders", help: "Open orders" }],
      async () => {
        if (failed) throw new Error("postgres://user:secret@private-db");
        return [{ name: "agentify_open_orders", value: 0 }];
      },
    );
    const healthy = await metrics.metrics();
    expect(healthy).toContain("agentify_open_orders 0");
    expect(healthy).toContain('agentify_snapshot_success{scope="commerce"} 1');
    failed = true;
    now = 2_000;
    const unavailable = await metrics.metrics();
    expect(unavailable).not.toMatch(/^agentify_open_orders /m);
    expect(unavailable).toContain('agentify_snapshot_success{scope="commerce"} 0');
    expect(unavailable).toContain('agentify_snapshot_timestamp_seconds{scope="commerce"} 1');
    expect(unavailable).not.toMatch(/secret|private-db/);
  });

  it("coalesces simultaneous scrapes and rejects non-finite snapshots", async () => {
    const metrics = new Telemetry();
    let unblock!: () => void;
    let reads = 0;
    const block = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    metrics.snapshot("scanner", [{ name: "agentify_queue_size", help: "Queue size" }], async () => {
      reads += 1;
      await block;
      return [{ name: "agentify_queue_size", value: Number.NaN }];
    });
    const a = metrics.metrics();
    const b = metrics.metrics();
    unblock();
    const [first, second] = await Promise.all([a, b]);
    expect(reads).toBe(1);
    expect(first).toBe(second);
    expect(first).toContain('agentify_snapshot_success{scope="scanner"} 0');
    expect(first).not.toMatch(/^agentify_queue_size /m);
  });

  it("serves only the private metrics resource and reports an unknown local revision", async () => {
    const metrics = new Telemetry({ revision: "not-a-source-sha" });
    const origin = await listening(metricsServer(metrics));
    const answer = await fetch(`${origin}/metrics`);
    expect(answer.headers.get("content-type")).toContain("text/plain");
    expect(await answer.text()).toContain('agentify_build_info{revision="unknown"} 1');
    expect((await fetch(`${origin}/anything?secret=hidden`)).status).toBe(404);
    expect((await fetch(`${origin}/metrics`, { method: "POST" })).status).toBe(405);
  });
});
