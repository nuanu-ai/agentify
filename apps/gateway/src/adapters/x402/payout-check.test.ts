/**
 * What a merchant's payout would bring if sent now, read through a chain
 * endpoint. The endpoint here is a JSON-RPC server on the loopback that
 * answers as a node would, and only the dry run of the payout asked about at
 * the latest block, so what is checked is the question sent, how its answers,
 * refusals and silences are read, and how often it is asked.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeAbiParameters, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { PayoutCheckFailure } from "../../ports/payout-check.js";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "../../split/networks.js";
import { payoutSplitFor } from "../../split/parameters.js";
import { merchantPayout, payoutDryRun } from "../../split/payout.js";
import { payoutCheckOn } from "./payout-check.js";

const NETWORK = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532");
const WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

/** As long as a page waits for the chain in these tests, unless one says otherwise. */
const PATIENT = 5_000;

const payoutOf = (merchantId: string) =>
  merchantPayout(NETWORK, [payoutSplitFor(NETWORK, merchantId, WALLET)], PAYOUT_SPLIT_NETWORKS);

const PAYOUT = payoutOf("mch_a");

type Answer =
  | { readonly result: string }
  | { readonly error: { code: number; message: string } }
  /** No JSON-RPC answer at all, as a proxy in front of a node that is down gives. */
  | "unavailable"
  /** No answer for as long as the request is held open, as a node that hangs gives. */
  | "silent";

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
  running?.closeAllConnections();
  await new Promise<void>((resolve) => (running ? running.close(() => resolve()) : resolve()));
  running = null;
});

/**
 * An endpoint serving `chainId` that answers each `eth_call` with the next of
 * `calls`, the last one again once they run out, and counts them. A call that
 * is not the dry run of a payout asked about, to Multicall3 at the latest
 * block, is refused, as a node refuses a call it cannot run.
 */
async function anEndpoint(
  chainId: number,
  ...calls: readonly Answer[]
): Promise<{ readonly url: string; readonly asked: () => number }> {
  let asked = 0;
  const dryRuns = new Set(
    [PAYOUT, payoutOf("mch_b")].map((payout) => payoutDryRun(NETWORK, payout).data),
  );
  running = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const read = JSON.parse(body) as {
        id: number;
        method: string;
        params?: readonly [{ to?: string; data?: string }, string?];
      };
      let answer: Answer;
      if (read.method === "eth_chainId") {
        answer = { result: `0x${chainId.toString(16)}` };
      } else {
        const [call, block] = read.params ?? [{}];
        const theDryRun =
          call.to?.toLowerCase() === NETWORK.multicall3.toLowerCase() &&
          dryRuns.has((call.data ?? "") as Hex) &&
          block === "latest";
        answer = theDryRun
          ? (calls[Math.min(asked, calls.length - 1)] ?? "unavailable")
          : { error: { code: -32602, message: "not the dry run this endpoint answers" } };
        asked += 1;
      }
      if (answer === "silent") return;
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

/** Why the read failed, as the operator's log names it. */
const failureOf = async (reading: Promise<unknown> | undefined): Promise<string> => {
  try {
    await reading;
  } catch (thrown) {
    return thrown instanceof PayoutCheckFailure ? thrown.code : `not a payout check's: ${thrown}`;
  }
  throw new Error("the read answered");
};

describe("what a payout would bring, read from the chain", () => {
  it("is what the chain's run of it adds to the merchant's wallet", async () => {
    const { url } = await anEndpoint(84532, dryRunAnswer(5n, 999_003n));

    expect(await payoutCheckOn(NETWORK, url)?.wouldBring(PAYOUT, PATIENT)).toBe(998_998n);
  });

  it("is nothing where the chain's run of it adds nothing", async () => {
    const { url } = await anEndpoint(84532, dryRunAnswer(5n, 5n));

    expect(await payoutCheckOn(NETWORK, url)?.wouldBring(PAYOUT, PATIENT)).toBe(0n);
  });

  it("is no answer from an endpoint serving another chain, said as such", async () => {
    const { url } = await anEndpoint(8453, dryRunAnswer(0n, 1_000n));

    expect(await failureOf(payoutCheckOn(NETWORK, url)?.wouldBring(PAYOUT, PATIENT))).toBe(
      "WRONG_CHAIN",
    );
  });

  it("is no answer, rather than nothing, where the chain reverts the run, said as a revert", async () => {
    // A payout the chain would revert, or one the node ran out of gas for,
    // pays nothing when sent, and it is still not known what waits.
    const { url } = await anEndpoint(84532, { error: { code: 3, message: "execution reverted" } });

    expect(await failureOf(payoutCheckOn(NETWORK, url)?.wouldBring(PAYOUT, PATIENT))).toBe(
      "REVERTED",
    );
  });

  it("is no answer where the chain answers the run with nothing, said as such", async () => {
    const { url } = await anEndpoint(84532, { result: "0x" });

    expect(await failureOf(payoutCheckOn(NETWORK, url)?.wouldBring(PAYOUT, PATIENT))).toBe(
      "EMPTY_ANSWER",
    );
  });

  it("is no answer from an endpoint that fails the call, said as unanswered", async () => {
    const { url } = await anEndpoint(84532, "unavailable");

    expect(await failureOf(payoutCheckOn(NETWORK, url)?.wouldBring(PAYOUT, PATIENT))).toBe(
      "UNANSWERED",
    );
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

    await check?.wouldBring(PAYOUT, PATIENT);
    clock.pass(4_999);
    const again = await check?.wouldBring(PAYOUT, PATIENT);

    expect(endpoint.asked()).toBe(1);
    expect(again).toBe(10n);
  });

  it("is again once the answer kept is five seconds old", async () => {
    const endpoint = await anEndpoint(84532, dryRunAnswer(0n, 10n), dryRunAnswer(0n, 20n));
    const clock = aClock();
    const check = payoutCheckOn(NETWORK, endpoint.url, clock.now);

    await check?.wouldBring(PAYOUT, PATIENT);
    clock.pass(5_000);

    expect(await check?.wouldBring(PAYOUT, PATIENT)).toBe(20n);
    expect(endpoint.asked()).toBe(2);
  });

  it("is again at once after a read that failed, which is not kept", async () => {
    const endpoint = await anEndpoint(84532, "unavailable", dryRunAnswer(0n, 10n));
    const check = payoutCheckOn(NETWORK, endpoint.url, aClock().now);

    await expect(check?.wouldBring(PAYOUT, PATIENT)).rejects.toThrow();

    expect(await check?.wouldBring(PAYOUT, PATIENT)).toBe(10n);
  });

  it("is once for pages that ask about the same payout while the read is under way", async () => {
    const endpoint = await anEndpoint(84532, dryRunAnswer(0n, 10n), dryRunAnswer(0n, 20n));
    const check = payoutCheckOn(NETWORK, endpoint.url, aClock().now);

    const both = await Promise.all([
      check?.wouldBring(PAYOUT, PATIENT),
      check?.wouldBring(PAYOUT, PATIENT),
    ]);

    expect(both).toStrictEqual([10n, 10n]);
    expect(endpoint.asked()).toBe(1);
  });

  it("is once for each payout, so one merchant's answer is never another's", async () => {
    const endpoint = await anEndpoint(84532, dryRunAnswer(0n, 10n), dryRunAnswer(0n, 20n));
    const check = payoutCheckOn(NETWORK, endpoint.url, aClock().now);

    await check?.wouldBring(PAYOUT, PATIENT);

    expect(await check?.wouldBring(payoutOf("mch_b"), PATIENT)).toBe(20n);
    expect(endpoint.asked()).toBe(2);
  });
});

describe("a chain that does not answer in time", () => {
  /** A clock the test moves by hand. */
  const aClock = () => {
    let now = 1_000_000;
    return { now: () => now, pass: (ms: number) => (now += ms) };
  };

  it("is given up on once the page's time for it has passed, said as too slow", async () => {
    const { url } = await anEndpoint(84532, "silent");

    expect(await failureOf(payoutCheckOn(NETWORK, url, aClock().now)?.wouldBring(PAYOUT, 50))).toBe(
      "TOO_SLOW",
    );
  });

  it("is not waited for again for five seconds: the next page about that payout is told at once", async () => {
    // Otherwise every Settings page drawn while the endpoint hangs would
    // spend the chain's whole share of its deadline on it.
    const endpoint = await anEndpoint(84532, "silent");
    const clock = aClock();
    const check = payoutCheckOn(NETWORK, endpoint.url, clock.now);
    await failureOf(check?.wouldBring(PAYOUT, 50));
    clock.pass(4_999);

    const began = performance.now();
    const failure = await failureOf(check?.wouldBring(PAYOUT, 5_000));

    expect(failure).toBe("TOO_SLOW");
    expect(performance.now() - began).toBeLessThan(1_000);
    expect(endpoint.asked()).toBe(1);
  });

  it("is asked again once those five seconds have passed", async () => {
    const endpoint = await anEndpoint(84532, "silent", dryRunAnswer(0n, 10n));
    const clock = aClock();
    const check = payoutCheckOn(NETWORK, endpoint.url, clock.now);
    await failureOf(check?.wouldBring(PAYOUT, 50));
    clock.pass(5_000);

    expect(await check?.wouldBring(PAYOUT, PATIENT)).toBe(10n);
    expect(endpoint.asked()).toBe(2);
  });

  it("is not waited for at all where the page has no time left for it", async () => {
    const endpoint = await anEndpoint(84532, dryRunAnswer(0n, 10n));

    expect(await failureOf(payoutCheckOn(NETWORK, endpoint.url)?.wouldBring(PAYOUT, 0))).toBe(
      "TOO_SLOW",
    );
    expect(endpoint.asked()).toBe(0);
  });
});
