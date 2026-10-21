/**
 * A contract wallet's signature judged through a chain endpoint. The endpoint
 * here is a JSON-RPC server on the loopback that answers as a node would, so
 * what is checked is how its answers, and its silences, are read.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { signaturesOn } from "./signatures.js";

const SEPOLIA = "eip155:84532";
const WALLET = "0x00000000000000000000000000000000000000c1";
const DIGEST = `0x${"11".repeat(32)}`;
const SIGNATURE = `0x${"cd".repeat(97)}`;

type Answer =
  | { readonly result: string }
  | { readonly error: { code: number; message: string } }
  /** No JSON-RPC answer at all, as a proxy in front of a node that is down gives. */
  | "unavailable";

let running: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (running ? running.close(() => resolve()) : resolve()));
  running = null;
});

/** An endpoint serving `chainId` that answers every call to a contract with `call`. */
async function anEndpoint(chainId: number, call: Answer): Promise<string> {
  running = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const asked = JSON.parse(body) as { id: number; method: string };
      const answer: Answer =
        asked.method === "eth_chainId" ? { result: `0x${chainId.toString(16)}` } : call;
      if (answer === "unavailable") {
        response.statusCode = 503;
        response.end("Service Unavailable");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: asked.id, ...answer }));
    });
  });
  await new Promise<void>((resolve) => running?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(running.address() as AddressInfo).port}`;
}

const accepted = { result: `0x${"0".repeat(63)}1` };
const reverted = { error: { code: 3, message: "execution reverted" } };

describe("a contract wallet's signature on the chain", () => {
  it("is accepted where the chain accepts it", async () => {
    const reader = signaturesOn(SEPOLIA, await anEndpoint(84532, accepted));

    expect(await reader?.accepts(WALLET, DIGEST, SIGNATURE)).toBe(true);
  });

  it("is refused where the chain reverts", async () => {
    const reader = signaturesOn(SEPOLIA, await anEndpoint(84532, reverted));

    expect(await reader?.accepts(WALLET, DIGEST, SIGNATURE)).toBe(false);
  });

  it("is not judged by an endpoint serving another chain", async () => {
    const reader = signaturesOn(SEPOLIA, await anEndpoint(8453, accepted));

    await expect(reader?.accepts(WALLET, DIGEST, SIGNATURE)).rejects.toThrow(/does not answer/);
  });

  it("is not judged by an endpoint that cannot be reached", async () => {
    const url = await anEndpoint(84532, accepted);
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = null;

    await expect(signaturesOn(SEPOLIA, url)?.accepts(WALLET, DIGEST, SIGNATURE)).rejects.toThrow();
  });

  it("is not judged by an endpoint that fails the call itself", async () => {
    const reader = signaturesOn(SEPOLIA, await anEndpoint(84532, "unavailable"));

    await expect(reader?.accepts(WALLET, DIGEST, SIGNATURE)).rejects.toThrow(/did not answer/);
  });

  it("is not judged at all where no endpoint is configured", () => {
    expect(signaturesOn(SEPOLIA)).toBeUndefined();
  });
});
