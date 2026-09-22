import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { evaluateChecks, type FetchArtifact, type ScanArtifacts } from "@agentify/scanner";
import { describe, expect, it } from "vitest";
import {
  type DnsResolver,
  NodePinnedTransport,
  type PinnedTransport,
  type PinnedTransportRequest,
  RequestBudget,
  SafeFetcher,
  selectPinnedAddress,
  transportErrorCode,
} from "./safe-fetch.js";

const publicResolver: DnsResolver = {
  resolve: async () => [{ address: "93.184.216.34", family: 4 }],
};

const response = (
  input: PinnedTransportRequest,
  overrides: Partial<FetchArtifact> = {},
): FetchArtifact => ({
  url: input.url.toString(),
  status: 200,
  headers: { "content-type": "text/html" },
  body: "ok",
  decodedBytes: 2,
  truncated: false,
  durationMs: 1,
  ttfbMs: 1,
  ...overrides,
});

describe("safe fetch policy", () => {
  it("pins an actual Node HTTP request without auto family selection", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" }).end("pinned");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const artifact = await new NodePinnedTransport().request({
        url: new URL(`http://unresolvable.invalid:${port}/`),
        address: { address: "127.0.0.1", family: 4 },
        method: "GET",
        headers: { connection: "close" },
        timeoutMs: 2_000,
        connectTimeoutMs: 1_000,
        maxDecodedBytes: 1_024,
        signal: new AbortController().signal,
      });
      expect(artifact).toMatchObject({ status: 200, body: "pinned" });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("reports decoded payloads one byte below and above the limit without hanging", async () => {
    const limit = 1_024;
    const server = createServer((request, response) => {
      const decodedSize =
        request.url === "/below" ? limit - 1 : request.url === "/exact" ? limit : limit + 1;
      const encoded = gzipSync(Buffer.alloc(decodedSize, "a"));
      response
        .writeHead(200, {
          "content-type": "text/html",
          "content-encoding": "gzip",
        })
        .end(encoded);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const transport = new NodePinnedTransport();
    const request = (path: string) =>
      transport.request({
        url: new URL(`http://unresolvable.invalid:${port}/${path}`),
        address: { address: "127.0.0.1", family: 4 },
        method: "GET",
        headers: { connection: "close", "accept-encoding": "gzip" },
        timeoutMs: 2_000,
        connectTimeoutMs: 1_000,
        maxDecodedBytes: limit,
        signal: new AbortController().signal,
      });
    try {
      const [below, exact, above] = await Promise.all([
        request("below"),
        request("exact"),
        request("above"),
      ]);
      expect({
        status: below.status,
        errorCode: below.errorCode,
        decodedBytes: below.decodedBytes,
        bodyBytes: Buffer.byteLength(below.body),
        truncated: below.truncated,
      }).toEqual({
        status: 200,
        errorCode: undefined,
        decodedBytes: limit - 1,
        bodyBytes: limit - 1,
        truncated: false,
      });
      expect({
        decodedBytes: exact.decodedBytes,
        bodyBytes: Buffer.byteLength(exact.body),
        truncated: exact.truncated,
      }).toEqual({
        decodedBytes: limit,
        bodyBytes: limit,
        truncated: false,
      });
      expect({
        status: above.status,
        errorCode: above.errorCode,
        decodedBytes: above.decodedBytes,
        bodyBytes: Buffer.byteLength(above.body),
        truncated: above.truncated,
      }).toEqual({
        status: 200,
        errorCode: undefined,
        decodedBytes: limit,
        bodyBytes: limit,
        truncated: true,
      });

      const missingRobots: FetchArtifact = {
        ...above,
        status: 404,
        body: "",
        decodedBytes: 0,
        truncated: false,
      };
      const artifacts: ScanArtifacts = {
        segment: "owner",
        canonicalTargetUrl: above.url,
        robots: missingRobots,
        base: above,
        agentProbes: {},
        sitemap: [],
        mcp: [],
        oauth: [],
      };
      expect(evaluateChecks(artifacts).find(({ id }) => id === 14)).toMatchObject({
        status: "fail",
        evidence: { decoded_bytes: limit, truncated: true },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 3_000);

  it("falls back from scheme-less HTTPS to HTTP only after a network failure", async () => {
    const protocols: string[] = [];
    const budget = new RequestBudget();
    const fetcher = new SafeFetcher(
      publicResolver,
      {
        request: async (input) => {
          protocols.push(input.url.protocol);
          return input.url.protocol === "https:"
            ? response(input, { status: 0, errorCode: "network_error" })
            : response(input);
        },
      },
      budget,
      "scanner",
    );
    await expect(fetcher.fetch("example.com/path")).resolves.toMatchObject({
      status: 200,
      url: "http://example.com/path",
    });
    expect(protocols).toEqual(["https:", "http:"]);
    expect(budget.used).toBe(2);
  });

  it("never falls back to HTTP after a TLS certificate failure", async () => {
    const protocols: string[] = [];
    const budget = new RequestBudget();
    const fetcher = new SafeFetcher(
      publicResolver,
      {
        request: async (input) => {
          protocols.push(input.url.protocol);
          return response(input, { status: 0, errorCode: "tls_invalid" });
        },
      },
      budget,
      "scanner",
    );
    await expect(fetcher.fetch("example.com/path")).resolves.toMatchObject({
      status: 0,
      errorCode: "tls_invalid",
    });
    expect(protocols).toEqual(["https:"]);
    expect(budget.used).toBe(1);
  });

  it.each([
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
    "EPROTO",
  ])("classifies %s as TLS failure before fallback policy", (code) => {
    expect(
      transportErrorCode(Object.assign(new Error("transport failed"), { code }), "https:"),
    ).toBe("tls_invalid");
  });

  it("does not downgrade after any HTTPS redirect has succeeded", async () => {
    const urls: string[] = [];
    const fetcher = new SafeFetcher(
      publicResolver,
      {
        request: async (input) => {
          urls.push(input.url.toString());
          return urls.length === 1
            ? response(input, {
                status: 302,
                redirectLocation: "https://www.example.com/path",
              })
            : response(input, { status: 0, errorCode: "network_error" });
        },
      },
      new RequestBudget(),
      "scanner",
    );
    await expect(fetcher.fetch("example.com/path")).resolves.toMatchObject({
      status: 0,
      errorCode: "network_error",
    });
    expect(urls).toEqual(["https://example.com/path", "https://www.example.com/path"]);
  });

  it("prefers validated IPv4 when a dual-stack resolver returns IPv6 first", async () => {
    const observed: PinnedTransportRequest[] = [];
    const budget = new RequestBudget();
    const transport: PinnedTransport = {
      request: async (input) => {
        observed.push(input);
        return response(input);
      },
    };
    const fetcher = new SafeFetcher(
      {
        resolve: async () => [
          { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
          { address: "93.184.216.34", family: 4 },
        ],
      },
      transport,
      budget,
      "scanner",
    );

    await expect(fetcher.fetch("https://example.com/")).resolves.toMatchObject({
      status: 200,
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.address).toEqual({
      address: "93.184.216.34",
      family: 4,
    });
    expect(budget.used).toBe(1);
  });

  it("uses validated IPv6 when it is the only DNS answer", async () => {
    const answer = {
      address: "2606:2800:220:1:248:1893:25c8:1946",
      family: 6 as const,
    };
    expect(selectPinnedAddress([answer])).toEqual(answer);
    let observed: PinnedTransportRequest | undefined;
    const budget = new RequestBudget();
    const fetcher = new SafeFetcher(
      { resolve: async () => [answer] },
      {
        request: async (input) => {
          observed = input;
          return response(input);
        },
      },
      budget,
      "scanner",
    );

    await fetcher.fetch("https://example.com/");
    expect(observed?.address).toEqual(answer);
    expect(budget.used).toBe(1);
  });

  it.each([
    ["127.0.0.1", "loopback"],
    ["10.0.0.1", "private"],
    ["169.254.169.254", "link_local"],
    ["::1", "loopback"],
    ["fe80::1", "link_local"],
  ])("blocks resolved %s before transport", async (address, reason) => {
    let calls = 0;
    const transport: PinnedTransport = {
      request: async (input) => {
        calls += 1;
        return response(input);
      },
    };
    const fetcher = new SafeFetcher(
      {
        resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
      },
      transport,
      new RequestBudget(),
      "scanner",
    );
    await expect(fetcher.fetch("https://example.com/")).rejects.toThrow(`ssrf_blocked:${reason}`);
    expect(calls).toBe(0);
  });

  it("blocks mixed DNS answers before transport", async () => {
    let calls = 0;
    const transport: PinnedTransport = {
      request: async (input) => {
        calls += 1;
        return response(input);
      },
    };
    const fetcher = new SafeFetcher(
      {
        resolve: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ],
      },
      transport,
      new RequestBudget(),
      "scanner",
    );
    await expect(fetcher.fetch("https://example.com/")).rejects.toThrow("ssrf_blocked:private");
    expect(calls).toBe(0);
  });

  it("re-resolves and blocks DNS rebinding on redirect", async () => {
    let resolutions = 0;
    let calls = 0;
    const resolver: DnsResolver = {
      resolve: async () => {
        resolutions += 1;
        return resolutions === 1
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "127.0.0.1", family: 4 }];
      },
    };
    const transport: PinnedTransport = {
      request: async (input) => {
        calls += 1;
        return response(input, { status: 302, redirectLocation: "/second" });
      },
    };
    const fetcher = new SafeFetcher(resolver, transport, new RequestBudget(), "scanner");
    await expect(fetcher.fetch("https://example.com/")).rejects.toThrow("ssrf_blocked:loopback");
    expect(calls).toBe(1);
    expect(resolutions).toBe(2);
  });

  it("blocks private redirect host before the second connection", async () => {
    let calls = 0;
    const transport: PinnedTransport = {
      request: async (input) => {
        calls += 1;
        return response(input, {
          status: 302,
          redirectLocation: "https://metadata.internal/latest",
        });
      },
    };
    const fetcher = new SafeFetcher(publicResolver, transport, new RequestBudget(), "scanner");
    await expect(fetcher.fetch("https://example.com/")).rejects.toThrow("hostname_blocked");
    expect(calls).toBe(1);
  });

  it("enforces at most two simultaneous requests per origin", async () => {
    let active = 0;
    let maximum = 0;
    const transport: PinnedTransport = {
      request: async (input) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return response(input);
      },
    };
    const fetcher = new SafeFetcher(publicResolver, transport, new RequestBudget(18, 2), "scanner");
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => fetcher.fetch(`https://example.com/${index}`)),
    );
    expect(maximum).toBe(2);
  });

  it("enforces the 18-request scan budget", async () => {
    let calls = 0;
    const transport: PinnedTransport = {
      request: async (input) => {
        calls += 1;
        return response(input);
      },
    };
    const budget = new RequestBudget(18, 2);
    const fetcher = new SafeFetcher(publicResolver, transport, budget, "scanner");
    await Promise.all(
      Array.from({ length: 18 }, (_, index) => fetcher.fetch(`https://example.com/${index}`)),
    );
    await expect(fetcher.fetch("https://example.com/overflow")).rejects.toThrow(
      "request_budget_exhausted",
    );
    expect(calls).toBe(18);
    expect(budget.used).toBe(18);
  });

  it("never forwards cookies, auth or user referer", async () => {
    let observed: Readonly<Record<string, string>> = {};
    const transport: PinnedTransport = {
      request: async (input) => {
        observed = input.headers;
        return response(input);
      },
    };
    const fetcher = new SafeFetcher(
      publicResolver,
      transport,
      new RequestBudget(),
      "agentify-scanner/1.0",
    );
    await fetcher.fetch("https://example.com/");
    expect(observed).toEqual({
      "user-agent": "agentify-scanner/1.0",
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      "accept-encoding": "gzip, deflate, br",
      connection: "close",
    });
  });
});
