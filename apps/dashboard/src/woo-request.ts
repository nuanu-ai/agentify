/** A DNS-pinned HTTPS request to a merchant-controlled WooCommerce origin. */

import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { classifyIp } from "@agentify/scanner/ip";

export type WooRequest = (url: string | URL, init?: RequestInit) => Promise<Response>;

interface RequestParts {
  readonly resolve: (host: string) => Promise<readonly string[]>;
  readonly open: (target: URL, address: string, init: RequestInit) => Promise<Response>;
}

const publicOnly = (addresses: readonly string[]): void => {
  if (addresses.length === 0 || addresses.some((address) => !classifyIp(address).allowed)) {
    throw new Error("WooCommerce shop addresses must resolve only to public internet addresses.");
  }
};

/** Injectable only so the security boundary has a zero-socket negative control. */
export const wooRequestWith =
  (parts: RequestParts): WooRequest =>
  async (url, init = {}) => {
    const target = new URL(url);
    if (target.protocol !== "https:") {
      throw new Error("WooCommerce shop requests require https.");
    }
    const host = target.hostname.replace(/^\[(.*)\]$/, "$1");
    const addresses = isIP(host) === 0 ? await parts.resolve(host) : [host];
    publicOnly(addresses);
    const address = addresses[0];
    if (address === undefined) {
      throw new Error("The WooCommerce shop address did not resolve.");
    }
    return await parts.open(target, address, init);
  };

const resolvePublic = async (host: string): Promise<readonly string[]> =>
  (await lookup(host, { all: true, verbatim: true })).map((one) => one.address);

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

const openPinned = async (target: URL, address: string, init: RequestInit): Promise<Response> =>
  await new Promise<Response>((resolve, reject) => {
    const headers = new Headers(init.headers);
    headers.set("host", target.host);
    const request = httpsRequest({
      protocol: "https:",
      hostname: address,
      port: target.port === "" ? 443 : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      servername: target.hostname,
      rejectUnauthorized: true,
    });
    const abort = (): void => {
      request.destroy(new Error("woo_request_aborted"));
    };
    if (init.signal?.aborted) {
      abort();
    } else {
      init.signal?.addEventListener("abort", abort, { once: true });
    }
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error("woo_request_timeout")));
    request.once("error", reject);
    request.once("response", (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("woo_response_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        init.signal?.removeEventListener("abort", abort);
        try {
          const received = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            for (const one of Array.isArray(value) ? value : [value]) {
              if (one !== undefined) received.append(name, one);
            }
          }
          const status = response.statusCode ?? 502;
          const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
          resolve(new Response(body, { status, headers: received }));
        } catch (error) {
          reject(error);
        }
      });
    });
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body !== "string" && !(init.body instanceof Uint8Array)) {
        request.destroy(new Error("woo_request_body_not_supported"));
        return;
      }
      request.write(init.body);
    }
    request.end();
  });

export const wooRequest: WooRequest = wooRequestWith({ resolve: resolvePublic, open: openPinned });
