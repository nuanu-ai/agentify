import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCabinetReportIdentityClient } from "./cabinet-report-identity";

const secret = "s".repeat(32);
const state = "A".repeat(43);

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("listen_failed");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  vi.useRealTimers();
});

describe("cabinet report identity client", () => {
  it("sends one authenticated strict request and parses its operation response", async () => {
    const received: Array<{
      url?: string;
      authorization?: string;
      body: string;
    }> = [];
    const running = await listen((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        received.push({
          url: request.url,
          authorization: request.headers.authorization,
          body,
        });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "accepted", token_hash: "B".repeat(43) }));
      });
    });
    servers.push(running.server);

    const client = createCabinetReportIdentityClient({
      baseUrl: running.url,
      secret,
    });
    await expect(
      client.sendReportLink({
        email: "owner@example.com",
        intentKind: "recovery",
        state,
      }),
    ).resolves.toEqual({ status: "accepted", token_hash: "B".repeat(43) });
    expect(received).toEqual([
      {
        url: "/internal/report-identity",
        authorization: `Bearer ${secret}`,
        body: JSON.stringify({
          operation: "send",
          email: "owner@example.com",
          intent_kind: "recovery",
          state,
        }),
      },
    ]);
  });

  it.each([
    ["non-200", 503, undefined],
    ["response-schema drift", 200, { status: "accepted", token_hash: "hex" }],
  ])("fails closed on %s", async (_name, status, payload) => {
    const running = await listen((_request, response) => {
      response.statusCode = status;
      if (payload !== undefined) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(payload));
      } else {
        response.end();
      }
    });
    servers.push(running.server);
    const client = createCabinetReportIdentityClient({
      baseUrl: running.url,
      secret,
    });
    await expect(
      client.sendReportLink({
        email: "owner@example.com",
        intentKind: "registration",
        state,
      }),
    ).rejects.toThrow("cabinet_identity_unavailable");
  });

  it("aborts at its fixed boundary and does not log sensitive values", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null | undefined;
    const fetchImpl = (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        requestSignal = init?.signal;
        requestSignal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    const client = createCabinetReportIdentityClient({
      baseUrl: "http://cabinet.internal:3002",
      secret,
      fetchImpl,
    });
    const result = client.consumeReportLink({
      token: "T".repeat(32),
      email: "sensitive@example.com",
      intentKind: "recovery",
      state,
    });
    const rejection = expect(result).rejects.toThrow("cabinet_identity_unavailable");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(requestSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("fails closed on connection refusal", async () => {
    const client = createCabinetReportIdentityClient({
      baseUrl: "http://127.0.0.1:1",
      secret,
    });
    await expect(
      client.deleteUnattachedPerson({
        operationId: "018f5e6f-7a5d-7c0b-8f58-a6b2fe16ca01",
        email: "owner@example.com",
      }),
    ).rejects.toThrow("cabinet_identity_unavailable");
  });
});
