import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { lookup as dnsLookup } from "node:dns/promises";
import http, { type IncomingHttpHeaders, type RequestOptions } from "node:http";
import https from "node:https";
import type { Readable } from "node:stream";
import {
  assertPublicAddresses,
  canonicalizeTarget,
  validateRedirect,
  type FetchArtifact,
  type SafeHeaderName,
  UrlPolicyError,
} from "@b2a/scanner-core";

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type DnsResolver = {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
};

export type PinnedTransportRequest = {
  url: URL;
  address: ResolvedAddress;
  method: "GET" | "HEAD";
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
  connectTimeoutMs: number;
  maxDecodedBytes: number;
  signal: AbortSignal;
};

export interface PinnedTransport {
  request(input: PinnedTransportRequest): Promise<FetchArtifact>;
}

export type SafeFetchOptions = {
  method?: "GET" | "HEAD";
  accept?: string;
  userAgent?: string;
  bodyLimit?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export const selectPinnedAddress = (
  answers: readonly ResolvedAddress[],
): ResolvedAddress => {
  const selected =
    answers.find(({ family }) => family === 4) ??
    answers.find(({ family }) => family === 6);
  if (!selected) throw new Error("dns_no_answers");
  return selected;
};

const SAFE_HEADERS = new Set<SafeHeaderName>([
  "content-type",
  "vary",
  "server",
  "via",
  "x-powered-by",
  "x-cache",
  "www-authenticate",
  "link",
]);

const headerValue = (
  value: string | string[] | undefined,
): string | undefined => (Array.isArray(value) ? value.join(", ") : value);

const allowlistedHeaders = (
  headers: IncomingHttpHeaders,
): FetchArtifact["headers"] => {
  const output: FetchArtifact["headers"] = {};
  for (const name of SAFE_HEADERS) {
    const value = headerValue(headers[name]);
    if (value) output[name] = value.slice(0, 2048);
  }
  return output;
};

export const transportErrorCode = (
  error: unknown,
  protocol: string,
): string => {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      protocol === "https:" &&
      ((code !== undefined &&
        (/^(?:ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_(?:GET|VERIFY))/.test(
          code,
        ) ||
          code === "EPROTO")) ||
        /\b(?:certificate|tls|ssl|handshake)\b/i.test(error.message))
    )
      return "tls_invalid";
    if (code === "ETIMEDOUT" || error.name === "AbortError")
      return "fetch_timeout";
    if (code === "ECONNRESET") return "connection_reset";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_error";
  }
  return "network_error";
};

const decoderFor = (
  stream: Readable,
  encoding: string | undefined,
): Readable => {
  const normalized = encoding?.toLowerCase().trim();
  if (!normalized || normalized === "identity") return stream;
  if (normalized === "gzip" || normalized === "x-gzip")
    return stream.pipe(createGunzip());
  if (normalized === "deflate") return stream.pipe(createInflate());
  if (normalized === "br") return stream.pipe(createBrotliDecompress());
  throw new Error("unsupported_content_encoding");
};

export class NodePinnedTransport implements PinnedTransport {
  async request(input: PinnedTransportRequest): Promise<FetchArtifact> {
    const startedAt = performance.now();
    return await new Promise<FetchArtifact>((resolve) => {
      let settled = false;
      const timers: { total?: NodeJS.Timeout; connect?: NodeJS.Timeout } = {};
      const finish = (value: FetchArtifact) => {
        if (settled) return;
        settled = true;
        if (timers.total) clearTimeout(timers.total);
        if (timers.connect) clearTimeout(timers.connect);
        input.signal.removeEventListener("abort", abort);
        resolve(value);
      };
      const fail = (error: unknown) =>
        finish({
          url: input.url.toString(),
          status: 0,
          headers: {},
          body: "",
          decodedBytes: 0,
          truncated: false,
          durationMs: Math.round(performance.now() - startedAt),
          ttfbMs: 0,
          errorCode: transportErrorCode(error, input.url.protocol),
        });

      const options: RequestOptions & { autoSelectFamily: false } = {
        protocol: input.url.protocol,
        hostname: input.url.hostname,
        port: input.url.port || (input.url.protocol === "https:" ? 443 : 80),
        path: `${input.url.pathname}${input.url.search}`,
        method: input.method,
        headers: input.headers,
        agent: false,
        autoSelectFamily: false,
        // The address is already resolved, validated, and pinned. Node 20+ may
        // request `all: true` for family autoselection, so return a one-element
        // array in that mode; Node still cannot select an unvalidated address.
        lookup: (_hostname, lookupOptions, callback) =>
          lookupOptions.all
            ? callback(null, [input.address])
            : callback(null, input.address.address, input.address.family),
        ...(input.url.protocol === "https:"
          ? { servername: input.url.hostname, rejectUnauthorized: true }
          : {}),
      };
      const request = (input.url.protocol === "https:" ? https : http).request(
        options,
      );
      const abort = () =>
        request.destroy(
          Object.assign(new Error("aborted"), { name: "AbortError" }),
        );
      input.signal.addEventListener("abort", abort, { once: true });
      timers.total = setTimeout(abort, input.timeoutMs);
      timers.connect = setTimeout(
        () =>
          request.destroy(
            Object.assign(new Error("connect_timeout"), { code: "ETIMEDOUT" }),
          ),
        input.connectTimeoutMs,
      );

      request.once("response", async (response) => {
        if (timers.connect) clearTimeout(timers.connect);
        const ttfbMs = Math.round(performance.now() - startedAt);
        const headers = allowlistedHeaders(response.headers);
        const location = headerValue(response.headers.location);
        if (input.method === "HEAD") {
          response.resume();
          finish({
            url: input.url.toString(),
            status: response.statusCode ?? 0,
            headers,
            body: "",
            decodedBytes: 0,
            truncated: false,
            durationMs: Math.round(performance.now() - startedAt),
            ttfbMs,
            ...(location ? { redirectLocation: location } : {}),
          });
          return;
        }
        try {
          const decoded = decoderFor(
            response,
            headerValue(response.headers["content-encoding"]),
          );
          const chunks: Buffer[] = [];
          let decodedBytes = 0;
          let truncated = false;
          try {
            for await (const chunk of decoded) {
              const buffer = Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk as Uint8Array);
              const remaining = input.maxDecodedBytes - decodedBytes;
              if (buffer.length > remaining) {
                if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
                decodedBytes += Math.max(remaining, 0);
                truncated = true;
                decoded.destroy();
                response.destroy();
                break;
              }
              chunks.push(buffer);
              decodedBytes += buffer.length;
            }
          } catch (error) {
            if (!truncated) throw error;
          }
          finish({
            url: input.url.toString(),
            status: response.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
            decodedBytes,
            truncated,
            durationMs: Math.round(performance.now() - startedAt),
            ttfbMs,
            ...(location ? { redirectLocation: location } : {}),
          });
        } catch (error) {
          fail(error);
        }
      });
      request.once("error", fail);
      if (input.signal.aborted) abort();
      request.end();
    });
  }
}

export const systemDnsResolver: DnsResolver = {
  async resolve(hostname) {
    const answers = await dnsLookup(hostname, { all: true, verbatim: true });
    return answers.filter(
      (answer): answer is ResolvedAddress =>
        answer.family === 4 || answer.family === 6,
    );
  },
};

class OriginSemaphore {
  private active = new Map<string, number>();
  private waiters = new Map<string, Array<() => void>>();

  constructor(private readonly limit: number) {}

  async acquire(origin: string, signal: AbortSignal): Promise<() => void> {
    const immediatelyAvailable = (this.active.get(origin) ?? 0) < this.limit;
    if (!immediatelyAvailable) {
      await new Promise<void>((resolve, reject) => {
        const waiters = this.waiters.get(origin) ?? [];
        const onAbort = () => {
          const index = waiters.indexOf(resume);
          if (index !== -1) waiters.splice(index, 1);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        };
        const resume = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        waiters.push(resume);
        this.waiters.set(origin, waiters);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    } else {
      this.active.set(origin, (this.active.get(origin) ?? 0) + 1);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.get(origin)?.shift();
      if (waiter) waiter();
      else
        this.active.set(
          origin,
          Math.max(0, (this.active.get(origin) ?? 1) - 1),
        );
    };
  }
}

export class RequestBudget {
  private count = 0;
  private readonly semaphore: OriginSemaphore;

  constructor(
    public readonly maximum = 18,
    perOriginConcurrency = 2,
  ) {
    this.semaphore = new OriginSemaphore(perOriginConcurrency);
  }

  get used(): number {
    return this.count;
  }

  consume(): void {
    if (this.count >= this.maximum) throw new Error("request_budget_exhausted");
    this.count += 1;
  }

  acquire(origin: string, signal: AbortSignal): Promise<() => void> {
    return this.semaphore.acquire(origin, signal);
  }
}

export class SafeFetcher {
  constructor(
    private readonly resolver: DnsResolver,
    private readonly transport: PinnedTransport,
    private readonly budget: RequestBudget,
    private readonly defaultUserAgent: string,
  ) {}

  async fetch(
    input: string | URL,
    options: SafeFetchOptions = {},
  ): Promise<FetchArtifact> {
    const rawInput = input.toString();
    const schemeWasMissing =
      typeof input === "string" && !/^[a-z][a-z\d+.-]*:/i.test(rawInput);
    let url = canonicalizeTarget(rawInput);
    const method = options.method ?? "GET";
    if (method !== "GET" && method !== "HEAD")
      throw new UrlPolicyError("method_blocked");
    const controller = new AbortController();
    const relayAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", relayAbort, { once: true });
    try {
      let redirects = 0;
      let usedHttpFallback = false;
      while (true) {
        if (controller.signal.aborted)
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        this.budget.consume();
        const answers = await this.resolver.resolve(url.hostname);
        assertPublicAddresses(answers.map((answer) => answer.address));
        const pinnedAddress = selectPinnedAddress(answers);
        const release = await this.budget.acquire(
          url.origin,
          controller.signal,
        );
        let artifact: FetchArtifact;
        try {
          artifact = await this.transport.request({
            url,
            address: pinnedAddress,
            method,
            headers: {
              "user-agent": options.userAgent ?? this.defaultUserAgent,
              accept:
                options.accept ??
                "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
              "accept-encoding": "gzip, deflate, br",
              connection: "close",
            },
            timeoutMs: Math.min(options.timeoutMs ?? 8_000, 8_000),
            connectTimeoutMs: 3_000,
            maxDecodedBytes: options.bodyLimit ?? 2 * 1024 * 1024,
            signal: controller.signal,
          });
        } finally {
          release();
        }
        const location = artifact.redirectLocation;
        if (
          schemeWasMissing &&
          !usedHttpFallback &&
          redirects === 0 &&
          url.protocol === "https:" &&
          artifact.errorCode &&
          new Set([
            "network_error",
            "connection_reset",
            "dns_error",
            "fetch_timeout",
          ]).has(artifact.errorCode)
        ) {
          url = new URL(url);
          url.protocol = "http:";
          usedHttpFallback = true;
          continue;
        }
        if (artifact.status < 300 || artifact.status >= 400 || !location)
          return artifact;
        if (redirects >= 5)
          return { ...artifact, errorCode: "redirect_limit_exceeded" };
        redirects += 1;
        url = validateRedirect(url, location);
      }
    } finally {
      options.signal?.removeEventListener("abort", relayAbort);
    }
  }
}
