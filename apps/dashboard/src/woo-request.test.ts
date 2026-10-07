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
