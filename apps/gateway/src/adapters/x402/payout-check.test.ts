/**
 * What a merchant's payout would bring if sent now, read through a chain
 * endpoint. The endpoint here is a JSON-RPC server on the loopback that
 * answers as a node would, so what is checked is how its answers, its
 * refusals and its silences are read, and how often it is asked.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeAbiParameters, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "../../split/networks.js";
import { payoutSplitFor } from "../../split/parameters.js";
import { merchantPayout } from "../../split/payout.js";
import { payoutCheckOn } from "./payout-check.js";

const NETWORK = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532");
const WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

const payoutOf = (merchantId: string) =>
  merchantPayout(NETWORK, [payoutSplitFor(NETWORK, merchantId, WALLET)], PAYOUT_SPLIT_NETWORKS);

const PAYOUT = payoutOf("mch_a");

type Answer =
  | { readonly result: string }
  | { readonly error: { code: number; message: string } }
  /** No JSON-RPC answer at all, as a proxy in front of a node that is down gives. */
  | "unavailable";

/** Multicall3's answer to a dry run over one wallet that held `before` and would hold `after`. */
const dryRunAnswer = (before: bigint, after: bigint): Answer => {
  const balance = (units: bigint) => ({
    success: true,
    returnData: `0x${units.toString(16).padStart(64, "0")}` as Hex,
  });
  return {
    result: encodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            { name: "success", type: "bool" },
            { name: "returnData", type: "bytes" },
          ],
        },
      ],
      [[balance(before), { success: true, returnData: "0x" }, balance(after)]],
    ),
  };
};

let running: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (running ? running.close(() => resolve()) : resolve()));
  running = null;
});

/**
 * An endpoint serving `chainId` that answers each `eth_call` with the next of
 * `calls`, the last one again once they run out, and counts them.
 */
async function anEndpoint(
  chainId: number,
  ...calls: readonly Answer[]
): Promise<{ readonly url: string; readonly asked: () => number }> {
  let asked = 0;
  running = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const read = JSON.parse(body) as { id: number; method: string };
      let answer: Answer;
      if (read.method === "eth_chainId") {
        answer = { result: `0x${chainId.toString(16)}` };
      } else {
        answer = calls[Math.min(asked, calls.length - 1)] ?? "unavailable";
        asked += 1;
      }
      if (answer === "unavailable") {
        response.statusCode = 503;
        response.end("Service Unavailable");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: read.id, ...answer }));
    });
  });
  await new Promise<void>((resolve) => running?.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(running.address() as AddressInfo).port}`;
  return { url, asked: () => asked };
}

describe("what a payout would bring, read from the chain", () => {
  it("is what the chain's run of it adds to the merchant's wallet", async () => {
    const { url } = await anEndpoint(84532, dryRunAnswer(5n, 998_003n));

    expect(await payoutCheckOn(NETWORK, url)?.wouldBring(PAYOUT)).toBe(998_998n);
  });

  it("is nothing where the chain's run of it adds nothing", async () => {
    const { url } = await anEndpoint(84532, dryRunAnswer(5n, 5n));

    expect(await payoutCheckOn(NETWORK, url)?.wouldBring(PAYOUT)).toBe(0n);
  });

  it("is no answer from an endpoint serving another chain", async () => {
    const { url } = await anEndpoint(8453, dryRunAnswer(0n, 1_000n));

    await expect(payoutCheckOn(NETWORK, url)?.wouldBring(PAYOUT)).rejects.toThrow(
      /does not answer/,
    );
  });

  it("is no answer, rather than nothing, where the chain reverts the run", async () => {
    // A payout the chain would revert, or one the node ran out of gas for,
    // pays nothing when sent, and it is still not known what waits.
    const { url } = await anEndpoint(84532, { error: { code: 3, message: "execution reverted" } });

    await expect(payoutCheckOn(NETWORK, url)?.wouldBring(PAYOUT)).rejects.toThrow();
  });

  it("is no answer from an endpoint that fails the call", async () => {
    const { url } = await anEndpoint(84532, "unavailable");

    await expect(payoutCheckOn(NETWORK, url)?.wouldBring(PAYOUT)).rejects.toThrow();
  });

  it("is not asked at all where no endpoint is configured", () => {
    expect(payoutCheckOn(NETWORK)).toBeUndefined();
  });
});

describe("how often the chain is asked about a payout", () => {
  /** A clock the test moves by hand. */
  const aClock = () => {
    let now = 1_000_000;
    return { now: () => now, pass: (ms: number) => (now += ms) };
  };

  it("is once for the same payout asked about again within five seconds", async () => {
    const endpoint = await anEndpoint(84532, dryRunAnswer(0n, 10n), dryRunAnswer(0n, 20n));
    const clock = aClock();
    const check = payoutCheckOn(NETWORK, endpoint.url, clock.now);

    await check?.wouldBring(PAYOUT);
    clock.pass(4_999);
    const again = await check?.wouldBring(PAYOUT);

    expect(endpoint.asked()).toBe(1);
    expect(again).toBe(10n);
  });

  it("is again once the answer kept is five seconds old", async () => {
    const endpoint = await anEndpoint(84532, dryRunAnswer(0n, 10n), dryRunAnswer(0n, 20n));
    const clock = aClock();
    const check = payoutCheckOn(NETWORK, endpoint.url, clock.now);

    await check?.wouldBring(PAYOUT);
    clock.pass(5_000);

    expect(await check?.wouldBring(PAYOUT)).toBe(20n);
    expect(endpoint.asked()).toBe(2);
  });

  it("is again at once after a read that failed, which is not kept", async () => {
    const endpoint = await anEndpoint(84532, "unavailable", dryRunAnswer(0n, 10n));
    const check = payoutCheckOn(NETWORK, endpoint.url, aClock().now);

    await expect(check?.wouldBring(PAYOUT)).rejects.toThrow();

    expect(await check?.wouldBring(PAYOUT)).toBe(10n);
  });

  it("is once for pages that ask about the same payout while the read is under way", async () => {
    const endpoint = await anEndpoint(84532, dryRunAnswer(0n, 10n), dryRunAnswer(0n, 20n));
    const check = payoutCheckOn(NETWORK, endpoint.url, aClock().now);

    const both = await Promise.all([check?.wouldBring(PAYOUT), check?.wouldBring(PAYOUT)]);

    expect(both).toStrictEqual([10n, 10n]);
    expect(endpoint.asked()).toBe(1);
  });

  it("is once for each payout, so one merchant's answer is never another's", async () => {
    const endpoint = await anEndpoint(84532, dryRunAnswer(0n, 10n), dryRunAnswer(0n, 20n));
    const check = payoutCheckOn(NETWORK, endpoint.url, aClock().now);

    await check?.wouldBring(PAYOUT);

    expect(await check?.wouldBring(payoutOf("mch_b"))).toBe(20n);
    expect(endpoint.asked()).toBe(2);
  });
});
