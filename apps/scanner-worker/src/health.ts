import { createServer, type Server } from "node:http";

export type WorkerHealth = {
  live: boolean;
  ready: boolean;
  queueConnected: boolean;
  databaseConnected: boolean;
  configuredConcurrency: number;
  lastHeartbeatAt: string | null;
};

export function startHealthServer(port: number, health: WorkerHealth): Server {
  const server = createServer((request, response) => {
    const isReady = request.url === "/health/ready";
    const isLive = request.url === "/health/live";

    if (!isReady && !isLive) {
      response.writeHead(404, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const healthy = isReady ? health.ready : health.live;
    response.writeHead(healthy ? 200 : 503, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(
      JSON.stringify({
        status: healthy ? "ok" : "unavailable",
        service: "scanner-worker",
        checks: isReady
          ? {
              queue: health.queueConnected,
              database: health.databaseConnected,
              configured_concurrency: health.configuredConcurrency,
              last_heartbeat_at: health.lastHeartbeatAt,
            }
          : undefined,
      }),
    );
  });

  server.listen(port, "0.0.0.0");
  return server;
}
