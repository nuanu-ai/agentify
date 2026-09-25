import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCabinetReportIdentityClient } from "./cabinet-report-identity";

const secret = "s".repeat(32);
const scanId = "019b41a0-7c51-7d63-84bd-a5a20faef497";
const requestId = "019b41a0-7c51-7d63-84bd-a5a20faef498";

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
        response.end(JSON.stringify({ status: "accepted" }));
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
        scanId,
        request: requestId,
      }),
    ).resolves.toEqual({ status: "accepted" });
    expect(received).toEqual([
      {
        url: "/internal/report-identity",
        authorization: `Bearer ${secret}`,
        body: JSON.stringify({
          operation: "send",
          email: "owner@example.com",
          destination: { report: scanId },
          request: requestId,
        }),
      },
    ]);
  });

  it("asks whose session a cookie header is and reads the cabinet's answer", async () => {
    const bodies: string[] = [];
    const renewed = "__Host-agentify.session_token=v.s; Max-Age=2592000; Path=/; Secure";
    const running = await listen((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        bodies.push(body);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            status: "signed_in",
            email: "owner@example.com",
            request: requestId,
            set_cookie: [renewed],
          }),
        );
      });
    });
    servers.push(running.server);
    const client = createCabinetReportIdentityClient({ baseUrl: running.url, secret });

    await expect(
      client.readSession({ cookie: "a=1; __Host-agentify.session_token=v.s", renew: true }),
    ).resolves.toEqual({
      status: "signed_in",
      email: "owner@example.com",
      request: requestId,
      set_cookie: [renewed],
    });
    expect(JSON.parse(bodies[0] ?? "{}")).toEqual({
      operation: "session",
      cookie: "a=1; __Host-agentify.session_token=v.s",
      renew: true,
    });
  });

  it.each([
    ["non-200", 503, undefined],
    ["response-schema drift", 200, { status: "accepted", token_hash: "hex" }],
    ["an unknown answer", 200, { status: "maybe" }],
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
      client.sendReportLink({ email: "owner@example.com", scanId, request: requestId }),
    ).rejects.toThrow("cabinet_identity_unavailable");
    await expect(client.readSession({ cookie: "a=1", renew: false })).rejects.toThrow(
      "cabinet_identity_unavailable",
    );
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
    const result = client.sendReportLink({
      email: "sensitive@example.com",
      scanId,
      request: requestId,
    });
    const rejection = expect(result).rejects.toThrow("cabinet_identity_unavailable");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(requestSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("gives up on a session question sooner, because a page is waiting on it", async () => {
    // Every scanner page that shows who is visiting asks this, and a cabinet
    // that hangs must turn into "we cannot tell who is visiting" in seconds,
    // not into a page that never draws (ADR-0026 §2).
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
    const result = client.readSession({ cookie: "sensitive-cookie-value", renew: false });
    const rejection = expect(result).rejects.toThrow("cabinet_identity_unavailable");
    await vi.advanceTimersByTimeAsync(2_999);
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
