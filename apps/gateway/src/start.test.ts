import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { PaymentEdge } from "./http/x402.js";
import { paymentLayer } from "./start.js";

const closing: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(closing.splice(0).map((close) => close()));
});

/** A JSON-RPC endpoint on this machine that answers every chain id question with `chainId`. */
async function endpointOn(chainId: number): Promise<string> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const { id } = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result: `0x${chainId.toString(16)}` }));
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  closing.push(() => new Promise((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("starting the payment layer", () => {
  it("starts with an RPC that serves another chain, says so, and keeps asking", async () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://agentify:secret@localhost:5432/agentify",
      FACILITATOR_URL: "https://x402.org/facilitator",
      PAYMENT_NETWORK: "eip155:84532",
      PAYMENT_RPC_URL: await endpointOn(8453),
    });
    const said: string[] = [];
    for (const level of ["log", "warn", "error"] as const)
      vi.spyOn(console, level).mockImplementation((...words: unknown[]) => {
        said.push(words.map(String).join(" "));
      });
    const facilitator = await paymentLayer(config, new PaymentEdge(config));
    expect(facilitator.reconcile).toBeDefined();
    expect(said.join("\n")).toMatch(/8453.*eip155:84532/);
  });
});
