import { describe, expect, it } from "vitest";
import { wooRequestWith } from "./woo-request.js";

describe("the WooCommerce network boundary", () => {
  it("refuses literal and DNS-resolved private targets before opening a socket", async () => {
    let opened = 0;
    const request = wooRequestWith({
      resolve: async (host) =>
        host === "mixed.example.com" ? ["153.124.160.16", "10.20.10.11"] : ["10.20.10.11"],
      open: async () => {
        opened += 1;
        return new Response("never");
      },
    });

    await expect(request("https://127.0.0.1/private")).rejects.toThrow(/public/i);
    await expect(request("https://[::ffff:127.0.0.1]/private")).rejects.toThrow(/public/i);
    await expect(request("https://private.example.com/private")).rejects.toThrow(/public/i);
    await expect(request("https://mixed.example.com/private")).rejects.toThrow(/public/i);
    expect(opened).toBe(0);
  });

  const resolvingTo = (address: string) => {
    const opened: string[] = [];
    const request = wooRequestWith({
      resolve: async () => [address],
      open: async (_target, pinned) => {
        opened.push(pinned);
        return new Response("ok", { status: 200 });
      },
    });
    return { request: () => request("https://shop.example.com/wp-json"), opened };
  };

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
    const shop = resolvingTo(address);
    await expect(shop.request()).rejects.toThrow(/public/i);
    expect(shop.opened).toEqual([]);
  });

  it.each(["2606:4700:4700::1111", "64:ff9b::808:808"])(
    "reaches a shop that resolves to the public address %s",
    async (address) => {
      const shop = resolvingTo(address);
      expect((await shop.request()).status).toBe(200);
      expect(shop.opened).toEqual([address]);
    },
  );

  it("pins a public resolution while preserving the TLS host name", async () => {
    const opened: { host: string; address: string }[] = [];
    const request = wooRequestWith({
      resolve: async () => ["153.124.160.16"],
      open: async (target, address) => {
        opened.push({ host: target.hostname, address });
        return new Response("ok", { status: 200 });
      },
    });

    expect((await request("https://woo.nuanu.ai/wp-json")).status).toBe(200);
    expect(opened).toEqual([{ host: "woo.nuanu.ai", address: "153.124.160.16" }]);
  });
});
