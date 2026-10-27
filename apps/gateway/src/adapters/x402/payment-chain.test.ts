/**
 * A contract wallet's signature, and whether an authorization was used,
 * judged through a chain endpoint. The endpoint
 * here is a JSON-RPC server on the loopback that answers as a node would, so
 * what is checked is how its answers, and its silences, are read.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { paymentChainOn } from "./payment-chain.js";

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

type RpcQuestion = {
  id: number;
  method: string;
  params?: [{ to?: string; data?: string }, string];
};

/** A loopback node with independent contract answers for the requested wire data. */
async function anEndpoint(
  chainId: number,
  call: Answer | ((question: RpcQuestion) => Answer),
): Promise<string> {
  running = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const asked = JSON.parse(body) as RpcQuestion;
      const answer: Answer =
        asked.method === "eth_chainId"
          ? { result: `0x${chainId.toString(16)}` }
          : typeof call === "function"
            ? call(asked)
            : call;
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
    // ERC-6492 constructor arguments: signer, digest, bytes offset, length and signature.
    const argumentsOnWire =
      "0".repeat(24) +
      WALLET.slice(2) +
      DIGEST.slice(2) +
      "0".repeat(62) +
      "60" +
      "0".repeat(62) +
      "61" +
      SIGNATURE.slice(2) +
      "0".repeat(62);
    const reader = paymentChainOn(
      SEPOLIA,
      await anEndpoint(84532, (asked) => {
        const [transaction, block] = asked.params ?? [];
        return asked.method === "eth_call" &&
          block === "latest" &&
          transaction?.to === undefined &&
          transaction?.data?.endsWith(argumentsOnWire)
          ? accepted
          : { error: { code: -32602, message: "wrong signature query" } };
      }),
    );

    expect(await reader?.accepts(WALLET, DIGEST, SIGNATURE)).toBe(true);
  });

  it("is refused where the chain reverts", async () => {
    const reader = paymentChainOn(SEPOLIA, await anEndpoint(84532, reverted));

    expect(await reader?.accepts(WALLET, DIGEST, SIGNATURE)).toBe(false);
  });

  it("is not judged by an endpoint serving another chain", async () => {
    const reader = paymentChainOn(SEPOLIA, await anEndpoint(8453, accepted));

    await expect(reader?.accepts(WALLET, DIGEST, SIGNATURE)).rejects.toThrow(/does not answer/);
  });

  it("is not judged by an endpoint that cannot be reached", async () => {
    const url = await anEndpoint(84532, accepted);
    await new Promise<void>((resolve) => running?.close(() => resolve()));
    running = null;

    await expect(
      paymentChainOn(SEPOLIA, url)?.accepts(WALLET, DIGEST, SIGNATURE),
    ).rejects.toThrow();
  });

  it("is not judged by an endpoint that fails the call itself", async () => {
    const reader = paymentChainOn(SEPOLIA, await anEndpoint(84532, "unavailable"));

    await expect(reader?.accepts(WALLET, DIGEST, SIGNATURE)).rejects.toThrow(/did not answer/);
  });

  it("is not judged at all where no endpoint is configured", () => {
    expect(paymentChainOn(SEPOLIA)).toBeUndefined();
  });

  it("is not judged by an endpoint that refuses with an error of its own, such as a rate limit", async () => {
    const reader = paymentChainOn(
      SEPOLIA,
      await anEndpoint(84532, { error: { code: 429, message: "too many requests" } }),
    );

    await expect(reader?.accepts(WALLET, DIGEST, SIGNATURE)).rejects.toThrow(/did not answer/);
  });
});

describe("whether an authorization was used, on the chain", () => {
  const USDC_ON_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const NONCE = `0x${"22".repeat(32)}`;

  it.each([
    ["used", `0x${"0".repeat(63)}1`, true],
    ["unused", `0x${"0".repeat(64)}`, false],
  ])("is read as the token answers: %s", async (_what, result, used) => {
    // EIP-3009 authorizationState(address,bytes32), independently encoded on the wire.
    const data = `0xe94a0102${"0".repeat(24)}${WALLET.slice(2)}${NONCE.slice(2)}`;
    const reader = paymentChainOn(
      SEPOLIA,
      await anEndpoint(84532, (asked) => {
        const [transaction, block] = asked.params ?? [];
        return asked.method === "eth_call" &&
          block === "latest" &&
          transaction?.to?.toLowerCase() === USDC_ON_BASE_SEPOLIA.toLowerCase() &&
          transaction.data === data
          ? { result }
          : { error: { code: -32602, message: "wrong authorization query" } };
      }),
    );

    expect(await reader?.used(USDC_ON_BASE_SEPOLIA, WALLET, NONCE)).toBe(used);
  });

  it("is not read from an endpoint that does not answer it", async () => {
    const reader = paymentChainOn(SEPOLIA, await anEndpoint(84532, "unavailable"));

    await expect(reader?.used(USDC_ON_BASE_SEPOLIA, WALLET, NONCE)).rejects.toThrow();
  });
});
