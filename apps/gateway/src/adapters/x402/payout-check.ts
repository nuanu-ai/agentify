import {
  BaseError,
  createPublicClient,
  ExecutionRevertedError,
  type Hex,
  http,
  RpcRequestError,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { type PayoutCheck, PayoutCheckFailure } from "../../ports/payout-check.js";
import type { PayoutSplitNetwork } from "../../split/networks.js";
import { broughtBy, type PayoutTransaction, payoutDryRun } from "../../split/payout.js";

/**
 * How long an answer about one payout is kept, and how long a read the page
 * gave up on keeps every page about that payout from waiting for the chain.
 * Long enough that a settings page drawn again after a press, or by a second
 * tab, does not ask again; short enough that a reload a little later reads
 * the chain afresh.
 */
const KEPT_FOR_MS = 5_000;

/** Whether the chain ran the call and reverted it, which is its own verdict and not a silence. */
const reverted = (thrown: unknown): boolean =>
  thrown instanceof BaseError &&
  thrown.walk(
    (cause) =>
      cause instanceof ExecutionRevertedError ||
      (cause instanceof RpcRequestError && cause.code === 3),
  ) !== null;

/**
 * Payouts on `network`, read through `rpcUrl`, the endpoint payment recovery
 * reads, or none where no endpoint is configured. Each answer is kept for
 * five seconds by the payout's data, which names its splits and wallets, and
 * one read is shared by everybody who asks about that payout while it is
 * under way; a read that fails is not kept. A read that does not answer
 * within the time a page has for it is given up on, and for the next five
 * seconds every page about that payout is told so at once, unless the read
 * answers meanwhile.
 */
export function payoutCheckOn(
  network: PayoutSplitNetwork,
  rpcUrl?: string,
  now: () => number = Date.now,
): PayoutCheck | undefined {
  if (!rpcUrl) return undefined;
  const chain = network.network === "eip155:8453" ? base : baseSepolia;
  const host = new URL(rpcUrl).host;
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 10_000, retryCount: 0 }),
  });

  const read = async (payout: PayoutTransaction): Promise<bigint> => {
    const run = payoutDryRun(network, payout);
    const serves = await client.getChainId().catch((thrown: unknown) => {
      throw new PayoutCheckFailure(
        "UNANSWERED",
        `the chain endpoint at ${host} did not say which chain it serves`,
        { cause: thrown },
      );
    });
    if (serves !== chain.id) {
      throw new PayoutCheckFailure(
        "WRONG_CHAIN",
        `the chain endpoint at ${host} serves chain ${serves}, not ${network.network}`,
      );
    }
    const { data } = await client
      .call({ to: run.to as Hex, data: run.data, blockTag: "latest" })
      .catch((thrown: unknown) => {
        throw reverted(thrown)
          ? new PayoutCheckFailure(
              "REVERTED",
              `the chain at ${host} reverted the dry run of a payout`,
              { cause: thrown },
            )
          : new PayoutCheckFailure(
              "UNANSWERED",
              `the chain endpoint at ${host} did not answer the dry run of a payout`,
              { cause: thrown },
            );
      });
    if (data === undefined) {
      throw new PayoutCheckFailure(
        "EMPTY_ANSWER",
        `the chain endpoint at ${host} answered the dry run of a payout with nothing`,
      );
    }
    try {
      return broughtBy(run, data);
    } catch (thrown) {
      throw new PayoutCheckFailure(
        "NOT_THE_DRY_RUN",
        `the chain endpoint at ${host} answered the dry run of a payout with something else`,
        { cause: thrown },
      );
    }
  };

  const tooSlow = (withinMs: number) =>
    new PayoutCheckFailure(
      "TOO_SLOW",
      `the chain endpoint at ${host} did not answer within the ${withinMs} ms a page had for it`,
    );

  const kept = new Map<string, { readonly at: number; readonly answer: Promise<bigint> }>();
  /** Until when the pages about each payout are told at once that the chain is too slow. */
  const slow = new Map<string, number>();
  return {
    wouldBring(payout, withinMs) {
      const at = now();
      for (const [data, held] of kept) {
        if (at - held.at >= KEPT_FOR_MS) kept.delete(data);
      }
      for (const [data, until] of slow) {
        if (until <= at) slow.delete(data);
      }
      if (slow.has(payout.data)) return Promise.reject(tooSlow(withinMs));
      let held = kept.get(payout.data);
      if (held === undefined) {
        if (withinMs <= 0) return Promise.reject(tooSlow(withinMs));
        const answer = read(payout);
        held = { at, answer };
        kept.set(payout.data, held);
        answer.then(
          () => slow.delete(payout.data),
          () => {
            if (kept.get(payout.data)?.answer === answer) kept.delete(payout.data);
          },
        );
      }
      const { answer } = held;
      return new Promise<bigint>((resolve, reject) => {
        const cut = setTimeout(
          () => {
            slow.set(payout.data, now() + KEPT_FOR_MS);
            reject(tooSlow(withinMs));
          },
          Math.max(0, withinMs),
        );
        answer.then(
          (brought) => {
            clearTimeout(cut);
            resolve(brought);
          },
          (thrown: unknown) => {
            clearTimeout(cut);
            reject(thrown);
          },
        );
      });
    },
  };
}
