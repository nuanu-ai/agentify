/**
 * The dashboard's doors closing at shutdown, within a bound.
 *
 * The gateway shares the dashboard's process (ADR-0030) and stops only once the
 * dashboard's doors have closed, so a door that never closes keeps every
 * parked purchase and every merchant's parked poll from being let go until the
 * process is killed. A browser that keeps a connection busy must not be able
 * to hold it open, and a page already being answered still gets its answer.
 */

import { once } from "node:events";
import { Agent, createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { closedWithin } from "./closing.js";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

const serving = async (answerAfterMs = 0): Promise<{ server: Server; port: number }> => {
  const server = createServer((_request, response) => {
    setTimeout(() => response.end("ok"), answerAfterMs);
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: (server.address() as AddressInfo).port };
};

const get = (port: number, agent: Agent): Promise<number> =>
  new Promise((resolve, reject) => {
    const asked = request({ host: "127.0.0.1", port, path: "/", agent }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    asked.on("error", reject);
    asked.end();
  });

describe("the dashboard's doors closing at shutdown", () => {
  it("settle within their grace while a browser keeps reusing its connection", async () => {
    // The connection is busy when the door closes, and the browser asks again
    // on it as soon as each answer arrives: Node goes on answering there, so a
    // close that only waits would wait for as long as the browser keeps asking.
    const { server, port } = await serving(100);
    const browser = new Agent({ keepAlive: true, maxSockets: 1 });
    let asking = true;
    const keepsAsking = (async () => {
      while (asking) {
        try {
          await get(port, browser);
        } catch {
          return;
        }
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 150));

    const started = Date.now();
    await closedWithin(server, 300);
    const took = Date.now() - started;
    asking = false;
    await keepsAsking;
    browser.destroy();

    expect(took).toBeLessThan(2_000);
  });

  it("let a page already being answered finish inside the grace", async () => {
    const { server, port } = await serving(200);
    const browser = new Agent({ keepAlive: true });
    const answered = get(port, browser);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const closing = closedWithin(server, 2_000);

    expect(await answered).toBe(200);
    await closing;
    browser.destroy();
  });
});
