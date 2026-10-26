import { createServer } from "node:http";
import { type AddressInfo, createServer as createTcpServer } from "node:net";
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

  it("reports a connection that fails at once as the request's error, not the process's", async () => {
    // Connecting to the broadcast address fails inside connect() itself, as
    // an IPv6-only site does on a host with no IPv6 route: the error comes
    // before the request is ready to hear it.
    const escaped: unknown[] = [];
    const onUncaught = (error: unknown) => escaped.push(error);
    process.prependListener("uncaughtException", onUncaught);
    try {
      const artifact = await new NodePinnedTransport().request({
        url: new URL("http://ipv6-only.example/"),
        address: { address: "255.255.255.255", family: 4 },
        method: "GET",
        headers: { connection: "close" },
        timeoutMs: 2_000,
        connectTimeoutMs: 1_000,
        maxDecodedBytes: 1_024,
        signal: new AbortController().signal,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(artifact).toMatchObject({ status: 0, errorCode: "network_error" });
      expect(escaped).toEqual([]);
    } finally {
      process.removeListener("uncaughtException", onUncaught);
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
    "CERT_HAS_EXPIRED",
    "CERT_NOT_YET_VALID",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ])("classifies %s as a certificate the scanner did not accept", (code) => {
    expect(
      transportErrorCode(Object.assign(new Error("transport failed"), { code }), "https:"),
    ).toBe("tls_certificate_invalid");
  });

  // A handshake that failed or was cut short says nothing of the certificate:
  // a firewall that drops the scanner cuts it the same way.
  it.each([
    ["ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", "handshake failure"],
    ["EPROTO", "wrong version number"],
    [
      "ECONNRESET",
      "Client network socket disconnected before secure TLS connection was established",
    ],
  ])("classifies %s apart from a certificate it did not accept", (code, message) => {
    expect(transportErrorCode(Object.assign(new Error(message), { code }), "https:")).toBe(
      "tls_invalid",
    );
  });

  it("does not take a site that closes the connection during the handshake for a bad certificate", async () => {
    // The connection is closed once the scanner's greeting arrives, which is
    // how a firewall that drops the scanner cuts the handshake.
    const server = createTcpServer((socket) => socket.once("data", () => socket.end()));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const artifact = await new NodePinnedTransport().request({
        url: new URL(`https://closes-the-door.example:${port}/`),
        address: { address: "127.0.0.1", family: 4 },
        method: "GET",
        headers: { connection: "close" },
        timeoutMs: 2_000,
        connectTimeoutMs: 1_000,
        maxDecodedBytes: 1_024,
        signal: new AbortController().signal,
      });
      expect(artifact).toMatchObject({ status: 0, errorCode: "tls_invalid" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
    await expect(fetcher.fetch("https://example.com/")).resolves.toMatchObject({
      status: 0,
      errorCode: `ssrf_blocked:${reason}`,
    });
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
    await expect(fetcher.fetch("https://example.com/")).resolves.toMatchObject({
      status: 0,
      errorCode: "ssrf_blocked:private",
    });
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
    await expect(fetcher.fetch("https://example.com/")).resolves.toMatchObject({
      status: 0,
      errorCode: "ssrf_blocked:loopback",
    });
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
    await expect(fetcher.fetch("https://example.com/")).resolves.toMatchObject({
      status: 0,
      errorCode: "hostname_blocked",
    });
    expect(calls).toBe(1);
  });

  it("answers a name that does not exist with the request's own error", async () => {
    const fetcher = new SafeFetcher(
      {
        resolve: async () => {
          throw Object.assign(new Error("getaddrinfo ENOTFOUND cdn.example.com"), {
            code: "ENOTFOUND",
          });
        },
      },
      { request: async (input) => response(input) },
      new RequestBudget(),
      "scanner",
    );
    await expect(fetcher.fetch("https://cdn.example.com/sitemap.xml")).resolves.toMatchObject({
      status: 0,
      errorCode: "dns_not_found",
    });
  });

  // Only "no such name" says something of the site: a resolver that could
  // not answer says nothing of whether the name exists.
  it.each([
    ["a temporary failure", { code: "EAI_AGAIN" }],
    ["a server failure", { code: "ESERVFAIL" }],
    ["a refused query", { code: "EREFUSED" }],
    ["a resolver timeout", { code: "ETIMEOUT" }],
    ["an error with no code", {}],
  ])(
    "answers a lookup that failed with %s apart from a name that does not exist",
    async (_, failure) => {
      const fetcher = new SafeFetcher(
        {
          resolve: async () => {
            throw Object.assign(new Error("lookup failed"), failure);
          },
        },
        { request: async (input) => response(input) },
        new RequestBudget(),
        "scanner",
      );
      await expect(fetcher.fetch("https://example.com/")).resolves.toMatchObject({
        status: 0,
        errorCode: "dns_error",
      });
    },
  );

  it("stops waiting for a name that never resolves when the scan is cut short", async () => {
    const fetcher = new SafeFetcher(
      { resolve: () => new Promise(() => undefined) },
      { request: async (input) => response(input) },
      new RequestBudget(),
      "scanner",
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const settled = await Promise.race([
      fetcher.fetch("https://example.com/", { signal: controller.signal }).then(
        () => "resolved",
        (error: Error) => error.name,
      ),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1_000)),
    ]);
    expect(settled).toBe("AbortError");
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

describe("a sitemap a site serves as a gzip file", () => {
  const limit = 64 * 1024;
  const urlset = `<?xml version="1.0"?><urlset><url><loc>https://example.com/a</loc><lastmod>${new Date().toISOString()}</lastmod></url></urlset>`;
  const answers: Record<string, { headers: Record<string, string>; body: Buffer }> = {
    "/sitemap.xml.gz": {
      headers: { "content-type": "application/x-gzip" },
      body: gzipSync(Buffer.from(urlset)),
    },
    "/bomb.xml.gz": {
      headers: { "content-type": "application/x-gzip" },
      body: gzipSync(Buffer.alloc(16 * 1024 * 1024, "<")),
    },
    "/encoded.xml.gz": {
      headers: { "content-type": "application/x-gzip", "content-encoding": "gzip" },
      body: gzipSync(Buffer.from(urlset)),
    },
  };
  const read = async (path: string, unpackGzip = true) => {
    const server = createServer((request, response) => {
      const answer = answers[request.url ?? ""];
      if (!answer) response.writeHead(404).end();
      else response.writeHead(200, answer.headers).end(answer.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      return await new NodePinnedTransport().request({
        url: new URL(
          `http://unresolvable.invalid:${(server.address() as AddressInfo).port}${path}`,
        ),
        address: { address: "127.0.0.1", family: 4 },
        method: "GET",
        headers: { connection: "close", "accept-encoding": "gzip" },
        timeoutMs: 5_000,
        connectTimeoutMs: 1_000,
        maxDecodedBytes: limit,
        signal: new AbortController().signal,
        unpackGzip,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  };
  const sitemapCheck = (sitemap: FetchArtifact) =>
    evaluateChecks({
      segment: "owner",
      canonicalTargetUrl: "https://example.com/",
      robots: { ...sitemap, status: 404, body: "", decodedBytes: 0, truncated: false },
      agentProbes: {},
      sitemap: [sitemap],
      mcp: [],
      oauth: [],
    }).find(({ id }) => id === 4);

  it("reads a .xml.gz sitemap and judges what it unpacks to", async () => {
    const sitemap = await read("/sitemap.xml.gz");
    expect(sitemap).toMatchObject({ status: 200, body: urlset, truncated: false });
    expect(sitemapCheck(sitemap)).toMatchObject({ status: "pass", summaryCode: "sitemap_valid" });
  });

  it("stops unpacking a file that expands without bound at the read limit, as a cut answer", async () => {
    const bomb = await read("/bomb.xml.gz");
    expect({
      truncated: bomb.truncated,
      decodedBytes: bomb.decodedBytes,
      bodyBytes: Buffer.byteLength(bomb.body),
    }).toEqual({ truncated: true, decodedBytes: limit, bodyBytes: limit });
  });

  it("judges a readable sitemap sent gzip-encoded under a gzip media type", async () => {
    const sitemap = await read("/encoded.xml.gz");
    expect(sitemap.body).toBe(urlset);
    expect(sitemapCheck(sitemap)?.status).toBe("pass");
  });

  it("leaves a gzip body as it came for a request that does not ask to unpack it", async () => {
    const raw = await read("/sitemap.xml.gz", false);
    expect(raw.body).not.toBe(urlset);
    expect(raw.decodedBytes).toBe(answers["/sitemap.xml.gz"]?.body.length);
  });
});

describe("a body the transport cannot decode or that never decodes to anything", () => {
  const limit = 64 * 1024;
  const gzipHeader = Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0x03]);
  // A deflate block that is not the last and holds nothing: a stream of them
  // decodes to no bytes at all, however many arrive.
  const emptyBlocks = Buffer.concat(
    Array(20_000).fill(Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff])),
  );
  const endless = (headers: Record<string, string>, first: Buffer, next: Buffer) =>
    ((_request, response) => {
      response.writeHead(200, headers);
      response.write(first);
      const timer = setInterval(() => {
        if (response.destroyed) clearInterval(timer);
        else response.write(next);
      }, 5);
      response.on("close", () => clearInterval(timer));
    }) satisfies Parameters<typeof createServer>[1];
  const routes: Record<string, NonNullable<Parameters<typeof createServer>[1]>> = {
    "/corrupt.xml.gz": endless(
      { "content-type": "application/x-gzip" },
      Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(64 * 1024, 7)]),
      Buffer.alloc(64 * 1024, 7),
    ),
    "/corrupt-encoding": endless(
      { "content-type": "text/html", "content-encoding": "gzip" },
      Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(64 * 1024, 7)]),
      Buffer.alloc(64 * 1024, 7),
    ),
    "/empty-blocks.xml.gz": endless(
      { "content-type": "application/x-gzip" },
      gzipHeader,
      emptyBlocks,
    ),
    "/empty-blocks-encoding": endless(
      { "content-type": "text/html", "content-encoding": "gzip" },
      gzipHeader,
      emptyBlocks,
    ),
  };
  const read = async (path: string, unpackGzip: boolean) => {
    const closed: Promise<void>[] = [];
    const server = createServer((request, response) => {
      closed.push(new Promise((resolve) => request.socket.once("close", () => resolve())));
      routes[request.url ?? ""]?.(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const artifact = await new NodePinnedTransport().request({
        url: new URL(
          `http://unresolvable.invalid:${(server.address() as AddressInfo).port}${path}`,
        ),
        address: { address: "127.0.0.1", family: 4 },
        method: "GET",
        headers: { connection: "close", "accept-encoding": "gzip" },
        timeoutMs: 5_000,
        connectTimeoutMs: 1_000,
        maxDecodedBytes: limit,
        signal: new AbortController().signal,
        unpackGzip,
      });
      // The connection is closed, not left to the server's patience.
      await Promise.race([
        Promise.all(closed),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("connection left open")), 1_000),
        ),
      ]);
      return artifact;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  it("names a gzip sitemap that cannot be unpacked, keeps its status and closes the connection", async () => {
    const artifact = await read("/corrupt.xml.gz", true);
    expect(artifact).toMatchObject({ status: 200, errorCode: "gzip_unpacking_failed" });
    expect(artifact.durationMs).toBeLessThan(5_000);
  });

  it("closes the connection when a body cannot be decoded", async () => {
    const artifact = await read("/corrupt-encoding", false);
    expect(artifact.durationMs).toBeLessThan(5_000);
  });

  it.each([
    ["a gzip sitemap", "/empty-blocks.xml.gz", true],
    ["a gzip-encoded body", "/empty-blocks-encoding", false],
  ] as const)(
    "stops %s that sends far more than it decodes to, with a code of its own",
    async (_, path, unpackGzip) => {
      const artifact = await read(path, unpackGzip);
      expect(artifact).toMatchObject({ status: 200, errorCode: "encoded_body_too_large" });
      expect(artifact.durationMs).toBeLessThan(5_000);
    },
  );
});

describe("the address a redirect led away from", () => {
  it("is kept with the answer of the address it led to", async () => {
    const fetcher = new SafeFetcher(
      publicResolver,
      {
        request: async (input) =>
          input.url.hostname === "www.example.com"
            ? response(input, { status: 301, redirectLocation: "https://example.com/s1.xml" })
            : response(input),
      },
      new RequestBudget(),
      "scanner",
    );
    await expect(fetcher.fetch("https://www.example.com/s1.xml")).resolves.toMatchObject({
      url: "https://example.com/s1.xml",
      requestedUrl: "https://www.example.com/s1.xml",
    });
    expect((await fetcher.fetch("https://example.com/s1.xml")).requestedUrl).toBeUndefined();
  });
});
