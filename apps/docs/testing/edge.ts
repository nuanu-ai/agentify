/** The deployed Caddyfile over built docs, with a raw HTTP tap for request observations. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  createServer,
  request as forward,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Environment } from "./caddy-templates.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const BUILT = fileURLToPath(new URL("../dist/client", import.meta.url));
const configuredImage = /^FROM (caddy:\S+)$/m.exec(
  readFileSync(join(ROOT, "deploy/Dockerfile.web"), "utf8"),
)?.[1];
if (configuredImage === undefined)
  throw new Error("deploy/Dockerfile.web must name its pinned Caddy image");
const image: string = configuredImage;

export const CHANNELS = {
  test: {
    AGENTIFY_SURFACE_MODE: "test",
    AGENTIFY_PUBLIC_ORIGIN: "https://test.agentify.ad",
    ABUSE_EMAIL: "abuse@test.agentify.ad",
    LEGAL_OPERATOR: "Operator identity pending confirmation",
    LEGAL_IDENTITY_CONFIRMED: "false",
  },
  live: {
    AGENTIFY_SURFACE_MODE: "live",
    AGENTIFY_PUBLIC_ORIGIN: "https://agentify.ad",
    ABUSE_EMAIL: "abuse@agentify.ad",
    LEGAL_OPERATOR: "Operator identity pending confirmation",
    LEGAL_IDENTITY_CONFIRMED: "false",
  },
} as const satisfies Readonly<Record<string, Environment>>;

type Upstream = (request: IncomingMessage, response: ServerResponse) => void;
export type Edge = Readonly<{ origin: string; close: () => Promise<void> }>;
const listen = async (server: Server, host = "127.0.0.1"): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  return (server.address() as AddressInfo).port;
};
const closeServer = async (server: Server): Promise<void> => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

/** Uses Docker's local Caddy image; it starts no application or database and mounts the checkout read-only. */
export async function standEdge({
  environment,
  upstream,
  heard,
}: Readonly<{
  environment: Environment;
  upstream?: Upstream;
  heard?: (request: string) => void;
}>): Promise<Edge> {
  const application = createServer(
    upstream ?? ((_request, response) => response.writeHead(404).end()),
  );
  const upstreamPort = await listen(application, "0.0.0.0");
  let container: string | undefined;
  let tap: Server | undefined;
  const close = async () => {
    if (tap !== undefined) await closeServer(tap);
    if (container !== undefined) {
      execFileSync("docker", ["rm", "--force", container], { stdio: "pipe", timeout: 15_000 });
      container = undefined;
    }
    await closeServer(application);
  };
  try {
    const variables = {
      ...environment,
      AGENTIFY_SITE_ADDRESS: ":8080",
      AGENTIFY_FRONT_PAGE: "scanner_front_page",
      AGENTIFY_PORTAL_ROOT: "/workspace/apps/docs/dist/client",
      AGENTIFY_ASSET_ROOT: "/workspace/packages/visual/public",
      AGENTIFY_SCANNER_UPSTREAM: `host.docker.internal:${upstreamPort}`,
    };
    container = execFileSync(
      "docker",
      [
        "run",
        "--detach",
        "--rm",
        "--publish",
        "127.0.0.1::8080",
        ...(process.platform === "linux"
          ? ["--add-host", "host.docker.internal:host-gateway"]
          : []),
        "--volume",
        `${ROOT}:/workspace:ro`,
        ...Object.entries(variables).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
        image,
        "caddy",
        "run",
        "--config",
        "/workspace/deploy/Caddyfile",
        "--adapter",
        "caddyfile",
      ],
      { encoding: "utf8", timeout: 30_000 },
    ).trim();
    const address = execFileSync("docker", ["port", container, "8080/tcp"], {
      encoding: "utf8",
    }).trim();
    const origin = `http://${address}`;
    const by = Date.now() + 15_000;
    for (;;) {
      const ready = await fetch(`${origin}/docs/`).then(
        (response) => response.status === 200,
        () => false,
      );
      if (ready) break;
      if (Date.now() > by) {
        throw new Error(
          `Caddy did not serve the built documentation: ${execFileSync("docker", ["logs", container], { encoding: "utf8" })}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // This tap observes the real wire; all routing, templates, statuses and byte encodings belong to Caddy.
    tap = createServer((request, response) => {
      heard?.(`${request.method} ${request.url}`);
      const forwarded = forward(
        `${origin}${request.url ?? "/"}`,
        {
          method: request.method,
          headers: request.headers,
        },
        (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        },
      );
      forwarded.on("error", (error) => response.writeHead(502).end(String(error)));
      request.pipe(forwarded);
    });
    const port = await listen(tap);
    return { origin: `http://127.0.0.1:${port}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}
