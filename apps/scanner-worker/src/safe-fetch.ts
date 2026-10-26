import { lookup as dnsLookup } from "node:dns/promises";
import http, { type IncomingHttpHeaders, type RequestOptions } from "node:http";
import https from "node:https";
import { pipeline, type Readable, Transform } from "node:stream";
import { constants, createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import {
  assertPublicAddresses,
  canonicalizeTarget,
  type FetchArtifact,
  GZIP_UNPACKING_FAILED,
  type SafeHeaderName,
  UrlPolicyError,
  validateRedirect,
} from "@agentify/scanner";

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
  /**
   * Whether a body that is itself a gzip file, as a sitemap's .xml.gz is, is
   * unpacked, with `maxDecodedBytes` bounding what it unpacks to.
   */
  unpackGzip?: boolean;
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
  /** Unpack a body that is itself a gzip file, within `bodyLimit`. */
  unpackGzip?: boolean;
  /**
   * Asked before a redirect is followed: the reason not to request the
   * address it leads to, or undefined to follow it.
   */
  admit?: (url: URL) => Promise<string | undefined>;
};

export const selectPinnedAddress = (answers: readonly ResolvedAddress[]): ResolvedAddress => {
  const selected =
    answers.find(({ family }) => family === 4) ?? answers.find(({ family }) => family === 6);
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

const headerValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value.join(", ") : value;

const allowlistedHeaders = (headers: IncomingHttpHeaders): FetchArtifact["headers"] => {
  const output: FetchArtifact["headers"] = {};
  for (const name of SAFE_HEADERS) {
    const value = headerValue(headers[name]);
    if (value) output[name] = value.slice(0, 2048);
  }
  return output;
};

// The codes OpenSSL and Node give a certificate the scanner did not accept,
// as against a handshake that failed or was cut short.
const CERTIFICATE_REJECTED =
  /^(?:CERT_|ERR_TLS_CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_(?:GET_ISSUER_CERT|VERIFY_LEAF_SIGNATURE|DECRYPT_CERT_SIGNATURE|DECODE_ISSUER_PUBLIC_KEY)|INVALID_CA|PATH_LENGTH_EXCEEDED|INVALID_PURPOSE|HOSTNAME_MISMATCH)/;

export const transportErrorCode = (error: unknown, protocol: string): string => {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (protocol === "https:" && code !== undefined && CERTIFICATE_REJECTED.test(code))
      return "tls_certificate_invalid";
    if (
      protocol === "https:" &&
      ((code !== undefined &&
        (/^(?:ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_(?:GET|VERIFY))/.test(code) ||
          code === "EPROTO")) ||
        /\b(?:certificate|tls|ssl|handshake)\b/i.test(error.message))
    )
      return "tls_invalid";
    if (code === "ETIMEDOUT" || error.name === "AbortError") return "fetch_timeout";
    if (code === "ECONNRESET") return "connection_reset";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_error";
  }
  return "network_error";
};

const ignore = (): undefined => undefined;

// A pipeline, unlike a pipe, destroys the response when its decoder fails, so
// a body that cannot be decoded closes its connection.
const decoderFor = (stream: Readable, encoding: string | undefined): Readable => {
  const normalized = encoding?.toLowerCase().trim();
  if (!normalized || normalized === "identity") return stream;
  if (normalized === "gzip" || normalized === "x-gzip")
    return pipeline(stream, createGunzip(), ignore);
  if (normalized === "deflate") return pipeline(stream, createInflate(), ignore);
  if (normalized === "br") return pipeline(stream, createBrotliDecompress(), ignore);
  throw new Error("unsupported_content_encoding");
};

/** What stops a body that sends far more bytes than it decodes to. */
class EncodedBodyTooLarge extends Error {}

/**
 * The bytes taken from the network for one body, bounded apart from what they
 * decode to: a stream of empty compressed blocks decodes to nothing however
 * much of it arrives, and stops here.
 */
const networkBound = (limit: number): Transform => {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done(bytes > limit ? new EncodedBodyTooLarge() : null, chunk);
    },
  });
};

/** What stops a gzip file from unpacking, apart from what stopped its body. */
class GzipUnpackingError extends Error {}

// The body as it arrives, unpacked first when it opens with gzip's two magic
// bytes. Unpacking is lazy, so a file that expands without bound stops where
// the reader stops: at the read limit. A file cut short still yields what it
// holds.
async function* unpackedGzip(source: AsyncIterable<Buffer | Uint8Array>): AsyncGenerator<Buffer> {
  const chunks = source[Symbol.asyncIterator]();
  let head = Buffer.alloc(0);
  while (head.length < 2) {
    const next = await chunks.next();
    if (next.done) {
      if (head.length) yield head;
      return;
    }
    head = Buffer.concat([head, Buffer.from(next.value)]);
  }
  let failedBody: unknown;
  async function* body(): AsyncGenerator<Buffer> {
    yield head;
    try {
      for (let next = await chunks.next(); !next.done; next = await chunks.next())
        yield Buffer.from(next.value);
    } catch (error) {
      failedBody = error;
      throw error;
    }
  }
  if (head[0] !== 0x1f || head[1] !== 0x8b) {
    yield* body();
    return;
  }
  const gunzip = createGunzip({ finishFlush: constants.Z_SYNC_FLUSH });
  // Whatever ends the unpacking early, the reader stopping or the body
  // failing, reaches the reader through the gunzip stream itself.
  pipeline(body(), gunzip, ignore);
  try {
    yield* gunzip;
  } catch (error) {
    throw error === failedBody ? error : new GzipUnpackingError();
  }
}

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
        // The answer comes a tick later, as a real lookup's does: answered at
        // once, a connect() that fails at once emits its error before the
        // request listens for it, and the error takes the process down.
        lookup: (_hostname, lookupOptions, callback) =>
          process.nextTick(() =>
            lookupOptions.all
              ? callback(null, [input.address])
              : callback(null, input.address.address, input.address.family),
          ),
        ...(input.url.protocol === "https:"
          ? { servername: input.url.hostname, rejectUnauthorized: true }
          : {}),
      };
      const request = (input.url.protocol === "https:" ? https : http).request(options);
      const abort = () =>
        request.destroy(Object.assign(new Error("aborted"), { name: "AbortError" }));
      input.signal.addEventListener("abort", abort, { once: true });
      timers.total = setTimeout(abort, input.timeoutMs);
      timers.connect = setTimeout(
        () => request.destroy(Object.assign(new Error("connect_timeout"), { code: "ETIMEDOUT" })),
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
          // A body sends little more than it decodes to unless it is built not
          // to decode, so twice the read limit, and a chunk's room for a small
          // one, is plenty.
          const fromNetwork = pipeline(
            response,
            networkBound(2 * input.maxDecodedBytes + 64 * 1024),
            ignore,
          );
          const decoded = decoderFor(
            fromNetwork,
            headerValue(response.headers["content-encoding"]),
          );
          const chunks: Buffer[] = [];
          let decodedBytes = 0;
          let truncated = false;
          let errorCode: string | undefined;
          try {
            for await (const chunk of input.unpackGzip ? unpackedGzip(decoded) : decoded) {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
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
            // The site answered, so its status stays with what went wrong
            // with the body it sent.
            if (!truncated) {
              if (error instanceof EncodedBodyTooLarge) errorCode = "encoded_body_too_large";
              else if (error instanceof GzipUnpackingError) errorCode = GZIP_UNPACKING_FAILED;
              else throw error;
            }
            response.destroy();
          }
          finish({
            url: input.url.toString(),
            status: response.statusCode ?? 0,
            headers,
            body: errorCode ? "" : Buffer.concat(chunks).toString("utf8"),
            decodedBytes: errorCode ? 0 : decodedBytes,
            truncated,
            ...(errorCode ? { errorCode } : {}),
            durationMs: Math.round(performance.now() - startedAt),
            ttfbMs,
            ...(location ? { redirectLocation: location } : {}),
          });
        } catch (error) {
          response.destroy();
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
      (answer): answer is ResolvedAddress => answer.family === 4 || answer.family === 6,
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
      else this.active.set(origin, Math.max(0, (this.active.get(origin) ?? 1) - 1));
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

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

// A promise the signal can cut short: a name that never resolves would
// otherwise hold the scan past its deadline.
const untilAborted = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> =>
  signal.aborted
    ? Promise.reject(abortError())
    : new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
        work.then(
          (value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });

// A request that was never made, or stopped on the way, with the reason: one
// such request is that request's failure, never the scan's.
const refused = (url: URL, errorCode: string, durationMs = 0): FetchArtifact => ({
  url: url.toString(),
  status: 0,
  headers: {},
  body: "",
  decodedBytes: 0,
  truncated: false,
  durationMs,
  ttfbMs: 0,
  errorCode,
});

export class SafeFetcher {
  constructor(
    private readonly resolver: DnsResolver,
    private readonly transport: PinnedTransport,
    private readonly budget: RequestBudget,
    private readonly defaultUserAgent: string,
  ) {}

  async fetch(input: string | URL, options: SafeFetchOptions = {}): Promise<FetchArtifact> {
    const rawInput = input.toString();
    const schemeWasMissing = typeof input === "string" && !/^[a-z][a-z\d+.-]*:/i.test(rawInput);
    let url = canonicalizeTarget(rawInput);
    // An answer from where redirects led keeps the address that was asked for.
    const requested = url.toString();
    const asked = (artifact: FetchArtifact): FetchArtifact =>
      artifact.url === requested ? artifact : { ...artifact, requestedUrl: requested };
    const method = options.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") throw new UrlPolicyError("method_blocked");
    const controller = new AbortController();
    const relayAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", relayAbort, { once: true });
    try {
      let redirects = 0;
      let usedHttpFallback = false;
      while (true) {
        if (controller.signal.aborted) throw abortError();
        this.budget.consume();
        let answers: ResolvedAddress[];
        try {
          answers = await untilAborted(this.resolver.resolve(url.hostname), controller.signal);
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          // Node gives ENOTFOUND to a name that does not exist and its own
          // code to a resolver that could not answer, which says nothing of it.
          return asked(
            refused(
              url,
              (error as NodeJS.ErrnoException).code === "ENOTFOUND" ? "dns_not_found" : "dns_error",
            ),
          );
        }
        let pinnedAddress: ResolvedAddress;
        try {
          assertPublicAddresses(answers.map((answer) => answer.address));
          pinnedAddress = selectPinnedAddress(answers);
        } catch (error) {
          return asked(refused(url, error instanceof Error ? error.message : "address_blocked"));
        }
        const release = await this.budget.acquire(url.origin, controller.signal);
        let artifact: FetchArtifact;
        try {
          artifact = await this.transport.request({
            url,
            address: pinnedAddress,
            method,
            headers: {
              "user-agent": options.userAgent ?? this.defaultUserAgent,
              accept: options.accept ?? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
              "accept-encoding": "gzip, deflate, br",
              connection: "close",
            },
            timeoutMs: Math.min(options.timeoutMs ?? 8_000, 8_000),
            connectTimeoutMs: 3_000,
            maxDecodedBytes: options.bodyLimit ?? 2 * 1024 * 1024,
            signal: controller.signal,
            ...(options.unpackGzip ? { unpackGzip: true } : {}),
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
          new Set(["network_error", "connection_reset", "dns_error", "fetch_timeout"]).has(
            artifact.errorCode,
          )
        ) {
          url = new URL(url);
          url.protocol = "http:";
          usedHttpFallback = true;
          continue;
        }
        if (artifact.status < 300 || artifact.status >= 400 || !location) return asked(artifact);
        if (redirects >= 5) return asked({ ...artifact, errorCode: "redirect_limit_exceeded" });
        redirects += 1;
        try {
          url = validateRedirect(url, location);
        } catch (error) {
          if (!(error instanceof UrlPolicyError)) throw error;
          return asked(refused(url, error.code, artifact.durationMs));
        }
        const inadmissible = await options.admit?.(url);
        if (inadmissible) return asked(refused(url, inadmissible, artifact.durationMs));
      }
    } finally {
      options.signal?.removeEventListener("abort", relayAbort);
    }
  }
}
