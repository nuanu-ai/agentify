import { createPublicClient, type Hex, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { PayoutCheck } from "../../ports/payout-check.js";
import type { PayoutSplitNetwork } from "../../split/networks.js";
import { broughtBy, payoutDryRun } from "../../split/payout.js";

/**
 * How long an answer about one payout is kept. Long enough that a settings
 * page drawn again after a press, or by a second tab, does not ask the chain
 * again; short enough that a merchant who reloads after a payout went out
 * sees what is left, since a Base block takes two seconds.
 */
const KEPT_FOR_MS = 5_000;

/**
 * Payouts on `network`, read through `rpcUrl`, the endpoint payment recovery
 * reads, or none where no endpoint is configured. Each answer is kept for
 * five seconds by the payout's data, which names its splits and wallets, and
 * one read is shared by everybody who asks about that payout while it is
 * under way; a read that fails is not kept.
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

  const read = async (payout: Parameters<PayoutCheck["wouldBring"]>[0]): Promise<bigint> => {
    const run = payoutDryRun(network, payout);
    const serves = await client.getChainId();
    if (serves !== chain.id) {
      throw new Error(`the chain endpoint at ${host} does not answer for ${network.network}`);
    }
    const { data } = await client.call({ to: run.to as Hex, data: run.data });
    if (data === undefined) {
      throw new Error(
        `the chain endpoint at ${host} answered the dry run of a payout with nothing`,
      );
    }
    return broughtBy(run, data);
  };

  const kept = new Map<string, { readonly at: number; readonly answer: Promise<bigint> }>();
  return {
    wouldBring(payout) {
      const at = now();
      for (const [data, held] of kept) {
        if (at - held.at >= KEPT_FOR_MS) kept.delete(data);
      }
      const held = kept.get(payout.data);
      if (held !== undefined) return held.answer;
      const answer = read(payout);
      kept.set(payout.data, { at, answer });
      answer.catch(() => {
        if (kept.get(payout.data)?.answer === answer) kept.delete(payout.data);
      });
      return answer;
    },
  };
}
