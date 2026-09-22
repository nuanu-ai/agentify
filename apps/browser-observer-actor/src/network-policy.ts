import { promises as dns } from "node:dns";
import type { IncomingHttpHeaders, RequestOptions } from "node:http";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import { assertPublicAddresses, classifyIp } from "@agentify/scanner";
import { getDomain } from "tldts";

const BLOCKED_HOST_SUFFIX = /(?:^|\.)(?:localhost|local|internal)$/i;
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "if-modified-since",
  "if-none-match",
  "pragma",
  "user-agent",
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
]);

export type RequestPolicyDecision =
  | { allowed: true; url: URL }
  | {
      allowed: false;
      code:
        | "method_blocked"
        | "protocol_blocked"
        | "credentials_blocked"
        | "host_blocked"
        | "port_blocked"
        | "navigation_cross_site"
        | "redirect_downgrade"
        | "invalid_url";
    };

export class BrowserNetworkPolicyError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "BrowserNetworkPolicyError";
  }
}

const normalizeDomain = (value: string): string =>
  value.trim().toLowerCase().replace(/\.$/, "");

export const registrableDomain = (hostname: string): string | null =>
  getDomain(normalizeDomain(hostname), { allowPrivateDomains: true }) ??
  getDomain(normalizeDomain(hostname), { allowPrivateDomains: false });

const hasAllowedPort = (url: URL): boolean =>
  !url.port ||
  (url.protocol === "https:" && url.port === "443") ||
  (url.protocol === "http:" && url.port === "80");

export const inspectRequest = (input: {
  url: string;
  method: string;
  isNavigation: boolean;
  allowedDomain: string;
  redirectedFromUrl?: string;
}): RequestPolicyDecision => {
  if (input.method !== "GET" && input.method !== "HEAD") {
    return { allowed: false, code: "method_blocked" };
  }

  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { allowed: false, code: "invalid_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, code: "protocol_blocked" };
  }
  if (url.username || url.password) {
    return { allowed: false, code: "credentials_blocked" };
  }
  if (!hasAllowedPort(url)) {
    return { allowed: false, code: "port_blocked" };
  }

  const hostname = normalizeDomain(url.hostname.replace(/^\[|\]$/g, ""));
  if (!hostname || BLOCKED_HOST_SUFFIX.test(hostname)) {
    return { allowed: false, code: "host_blocked" };
  }
  if (isIP(hostname)) {
    const classification = classifyIp(hostname);
    if (!classification.allowed) {
      return { allowed: false, code: "host_blocked" };
    }
  }

  if (input.isNavigation) {
    const domain = registrableDomain(hostname);
    if (!domain || domain !== normalizeDomain(input.allowedDomain)) {
      return { allowed: false, code: "navigation_cross_site" };
    }
    if (input.redirectedFromUrl) {
      try {
        const previous = new URL(input.redirectedFromUrl);
        if (previous.protocol === "https:" && url.protocol !== "https:") {
          return { allowed: false, code: "redirect_downgrade" };
        }
      } catch {
        return { allowed: false, code: "invalid_url" };
      }
    }
  }

  url.hash = "";
  return { allowed: true, url };
};

export const resolveSafeNavigationRedirect = (input: {
  allowedDomain: string;
  from: URL;
  location: string;
}): URL => {
  let candidate: URL;
  try {
    candidate = new URL(input.location, input.from);
  } catch {
    throw new BrowserNetworkPolicyError("invalid_redirect");
  }
  const decision = inspectRequest({
    url: candidate.toString(),
    method: "GET",
    isNavigation: true,
    allowedDomain: input.allowedDomain,
    redirectedFromUrl: input.from.toString(),
  });
  if (!decision.allowed) {
    throw new BrowserNetworkPolicyError(decision.code);
  }
  return decision.url;
};

export const validateActorTarget = (input: {
  canonicalUrl: string;
  representativeUrls: readonly string[];
  declaredDomain: string;
}): URL[] => {
  const declared = normalizeDomain(input.declaredDomain);
  if (!declared || registrableDomain(declared) !== declared) {
    throw new BrowserNetworkPolicyError("declared_domain_invalid");
  }

  const urls = [input.canonicalUrl, ...input.representativeUrls].map(
    (raw, index) => {
      const decision = inspectRequest({
        url: raw,
        method: "GET",
        isNavigation: true,
        allowedDomain: declared,
      });
      if (!decision.allowed) {
        throw new BrowserNetworkPolicyError(
          index === 0 ? "target_blocked" : "representative_blocked",
        );
      }
      if (decision.url.search || decision.url.hash) {
        throw new BrowserNetworkPolicyError("input_query_or_fragment_blocked");
      }
      return decision.url;
    },
  );

  if (new Set(urls.map((url) => url.toString())).size !== urls.length) {
    throw new BrowserNetworkPolicyError("duplicate_page");
  }
  return urls;
};

type SafeResponse = {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  decodedBytes: number;
};

type SafeRequestOptions = {
  url: URL;
  method: "GET" | "HEAD";
  headers: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
  consumeBytes: (bytes: number) => boolean;
};

const responseHeaders = (
  source: IncomingHttpHeaders,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    const lower = name.toLowerCase();
    if (DROPPED_RESPONSE_HEADERS.has(lower) || value === undefined) continue;
    result[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
};

const requestHeaders = (
  source: Record<string, string>,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    const lower = name.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.has(lower)) continue;
    result[lower] = value.slice(0, 1_000);
  }
  result["accept-encoding"] = "gzip, deflate, br";
  return result;
};

const decodedStream = (
  response: Readable,
  encoding: string | undefined,
): Readable => {
  const normalized = encoding?.trim().toLowerCase();
  if (!normalized || normalized === "identity") return response;
  if (normalized === "gzip" || normalized === "x-gzip") {
    return response.pipe(createGunzip());
  }
  if (normalized === "deflate") return response.pipe(createInflate());
  if (normalized === "br") return response.pipe(createBrotliDecompress());
  throw new BrowserNetworkPolicyError("content_encoding_blocked");
};

export const resolvePublicHost = async (
  hostname: string,
): Promise<{ address: string; family: 4 | 6 }> => {
  if (isIP(hostname)) {
    const classification = classifyIp(hostname);
    if (!classification.allowed) {
      throw new BrowserNetworkPolicyError("ssrf_blocked");
    }
    return { address: hostname, family: classification.family };
  }

  let answers: Awaited<ReturnType<typeof dns.lookup>>[];
  try {
    answers = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new BrowserNetworkPolicyError("dns_failed");
  }
  return selectPublicAddress(answers);
};

export const selectPublicAddress = (
  answers: readonly { address: string; family: number }[],
): { address: string; family: 4 | 6 } => {
  assertPublicAddresses(answers.map((answer) => answer.address));
  const first = answers[0];
  if (!first || (first.family !== 4 && first.family !== 6)) {
    throw new BrowserNetworkPolicyError("dns_no_answers");
  }
  return { address: first.address, family: first.family };
};

export const createPinnedLookup =
  (resolved: { address: string; family: 4 | 6 }): LookupFunction =>
  (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) {
      callback(null, [resolved]);
      return;
    }
    callback(null, resolved.address, resolved.family);
  };

export const safeBrowserRequest = async (
  options: SafeRequestOptions,
): Promise<SafeResponse> => {
  const resolved = await resolvePublicHost(options.url.hostname);
  const lookup = createPinnedLookup(resolved);
  const port =
    options.url.port || (options.url.protocol === "https:" ? "443" : "80");
  const requestOptions: RequestOptions = {
    protocol: options.url.protocol,
    hostname: options.url.hostname,
    port,
    method: options.method,
    path: `${options.url.pathname}${options.url.search}`,
    headers: requestHeaders(options.headers),
    lookup,
    agent: false,
    timeout: options.timeoutMs,
  };
  const transport = options.url.protocol === "https:" ? https : http;

  return await new Promise<SafeResponse>((resolve, reject) => {
    let settled = false;
    // The first outcome wins: whichever of the response, the stream and the
    // request speaks first is the one this promise answers with.
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      options.signal.removeEventListener("abort", onAbort);
      return true;
    };
    const fail = (error: Error): void => {
      if (settle()) reject(error);
    };
    const finish = (value: SafeResponse): void => {
      if (settle()) resolve(value);
    };
    const request = transport.request(requestOptions, (response) => {
      const status = response.statusCode ?? 0;
      if (options.method === "HEAD") {
        response.resume();
        finish({
          status,
          headers: responseHeaders(response.headers),
          body: Buffer.alloc(0),
          decodedBytes: 0,
        });
        return;
      }

      let stream: Readable;
      try {
        stream = decodedStream(response, response.headers["content-encoding"]);
      } catch (error) {
        response.destroy();
        fail(
          error instanceof Error
            ? error
            : new BrowserNetworkPolicyError("decode_failed"),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!options.consumeBytes(buffer.length)) {
          stream.destroy(new BrowserNetworkPolicyError("byte_budget_exceeded"));
          return;
        }
        bytes += buffer.length;
        chunks.push(buffer);
      });
      stream.once("error", (error) => fail(error));
      stream.once("end", () => {
        finish({
          status,
          headers: responseHeaders(response.headers),
          body: Buffer.concat(chunks, bytes),
          decodedBytes: bytes,
        });
      });
    });

    const onAbort = (): void => {
      request.destroy(new BrowserNetworkPolicyError("request_aborted"));
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    request.once("timeout", () => {
      request.destroy(new BrowserNetworkPolicyError("request_timeout"));
    });
    request.once("error", (error) => fail(error));
    request.end();
  });
};
