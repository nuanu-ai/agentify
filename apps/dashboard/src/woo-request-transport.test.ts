import { EventEmitter } from "node:events";
import type { ClientRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { wooRequest } from "./woo-request.js";

const dns = vi.hoisted(() => ({
  lookup: vi.fn<() => Promise<{ address: string; family: number }[]>>(),
}));
vi.mock("node:dns/promises", () => dns);
vi.mock("node:https", () => ({ request: vi.fn() }));

beforeEach(() => {
  dns.lookup.mockReset().mockResolvedValue([{ address: "153.124.160.16", family: 4 }]);
  vi.mocked(httpsRequest)
    .mockReset()
    .mockImplementation(() => {
      throw new Error("an unexpected socket was opened");
    });
});

const resolvesTo = (...addresses: string[]) => {
  dns.lookup.mockResolvedValue(
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
  );
};

// Fake only DNS and native I/O; the production path assembles the connection,
// identity and Web Response. These options do not establish a TLS handshake.
const replyFromShop = async (
  status: number,
  body = "",
  url = "https://woo.nuanu.ai/wp-json",
  init?: RequestInit,
) => {
  const opened = Promise.withResolvers<RequestOptions>();
  const outgoing = Object.assign(new EventEmitter(), {
    setTimeout: () => outgoing,
    write: () => true,
    end: () => {},
  });
  vi.mocked(httpsRequest).mockImplementation((options) => {
    opened.resolve(options as RequestOptions);
    return outgoing as unknown as ClientRequest;
  });
  const answer = wooRequest(url, init);
  const sent = await opened.promise;

  return {
    answer,
    sent,
    finish() {
      const incoming = Object.assign(new EventEmitter(), {
        statusCode: status,
        headers: { "content-type": "text/plain", "x-shop-response": "preserved" },
      });
      outgoing.emit("response", incoming);
      if (body !== "") incoming.emit("data", Buffer.from(body));
      incoming.emit("end");
    },
  };
};

describe("the WooCommerce network boundary", () => {
  it("refuses literal and DNS-resolved private targets before opening a socket", async () => {
    await expect(wooRequest("https://127.0.0.1/private")).rejects.toThrow(/public/i);
    await expect(wooRequest("https://[::ffff:127.0.0.1]/private")).rejects.toThrow(/public/i);
    resolvesTo("10.20.10.11");
    await expect(wooRequest("https://private.example.com/private")).rejects.toThrow(/public/i);
    resolvesTo("153.124.160.16", "10.20.10.11");
    await expect(wooRequest("https://mixed.example.com/private")).rejects.toThrow(/public/i);
  });

  it.each([
    ["64:ff9b::a00:1", "NAT64 address of a private IPv4 host"],
    ["64:ff9b::a9fe:a9fe", "NAT64 address of the metadata host"],
    ["2002:a00:1::1", "6to4 address of a private IPv4 host"],
    ["2002:a9fe:a9fe::1", "6to4 address of the metadata host"],
    ["::7f00:1", "IPv4-compatible loopback"],
    ["64:ff9b:1::a00:1", "local-use NAT64 address"],
    ["fec0::1", "site-local address"],
    ["100::1", "discard-only address"],
    ["2001::1", "Teredo address"],
    ["2001:20::1", "ORCHIDv2 identifier"],
    ["3fff::1", "documentation address"],
  ])("opens no socket to a shop that resolves to %s (%s)", async (address) => {
    resolvesTo(address);
    await expect(wooRequest("https://shop.example.com/wp-json")).rejects.toThrow(/public/i);
  });

  it.each(["2606:4700:4700::1111", "64:ff9b::808:808"])(
    "reaches a shop that resolves to the public address %s",
    async (address) => {
      resolvesTo(address);
      const reply = await replyFromShop(200);
      reply.finish();
      expect((await reply.answer).status).toBe(200);
      expect(reply.sent.hostname).toBe(address);
    },
  );

  it("refuses a plain-http shop address before opening a socket", async () => {
    await expect(wooRequest("http://shop.example.com/wp-json")).rejects.toThrow(/https/i);
  });

  it.each<[string, RequestInit | undefined]>([
    ["a catalogue read", undefined],
    [
      "an order creation",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ],
  ])("identifies Agentify to the shop in %s", async (_name, init) => {
    const reply = await replyFromShop(200, "", undefined, init);
    reply.finish();
    expect((await reply.answer).status).toBe(200);
    expect(reply.sent.headers).toMatchObject({ "user-agent": "Agentify/1 (+https://agentify.ad)" });
  });

  it("keeps Agentify's identity over a caller's User-Agent and keeps the caller's other headers", async () => {
    const reply = await replyFromShop(200, "", undefined, {
      headers: new Headers({
        "User-Agent": "Mozilla/5.0",
        authorization: "Basic a2V5OnNlY3JldA==",
      }),
    });
    reply.finish();
    expect((await reply.answer).status).toBe(200);
    expect(reply.sent.headers).toMatchObject({
      "user-agent": "Agentify/1 (+https://agentify.ad)",
      authorization: "Basic a2V5OnNlY3JldA==",
    });
  });

  it("connects to the public DNS address with the original TLS server name and HTTP Host", async () => {
    const reply = await replyFromShop(200, "", "https://woo.nuanu.ai:8443/wp-json?per_page=10", {
      headers: { host: "a-caller-cannot-replace-the-shop.example" },
    });
    reply.finish();
    expect((await reply.answer).status).toBe(200);
    expect(reply.sent).toMatchObject({
      protocol: "https:",
      hostname: "153.124.160.16",
      port: 8443,
      path: "/wp-json?per_page=10",
      servername: "woo.nuanu.ai",
      rejectUnauthorized: true,
      headers: { host: "woo.nuanu.ai:8443" },
    });
  });
});

describe("responses from the WooCommerce HTTPS transport", () => {
  it.each([204, 205, 304])("returns HTTP %s with its headers and no body", async (status) => {
    const reply = await replyFromShop(status);
    reply.finish();
    const response = await reply.answer;

    expect(response.status).toBe(status);
    expect(response.headers.get("x-shop-response")).toBe("preserved");
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("preserves the body and headers of an ordinary response", async () => {
    const reply = await replyFromShop(200, '{"products":[]}');
    reply.finish();
    const response = await reply.answer;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe('{"products":[]}');
  });

  it("rejects the request when the shop's status cannot become a Response", async () => {
    const reply = await replyFromShop(600);
    const rejected = reply.answer.catch((error: unknown) => error);
    reply.finish();
    expect(await rejected).toBeInstanceOf(RangeError);
  });
});
