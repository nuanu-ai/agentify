/**
 * What the workspace's frame draws on every page: the channel, named so an
 * admission is never given on the wrong one, and the count each section
 * carries where something waits in it. Each area answers its own sections'
 * counts; one that fails or is slow gives no count rather than a zero, since
 * a pill that says nothing is not a claim that nothing waits.
 */

import { CHANNEL_NAMES, type ChannelView, type SectionCounts } from "@agentify/ui/workspace-view";
import type { DashboardConfig } from "../config.js";
import type { Operator } from "./access.js";

export interface AdminFrameView {
  readonly channel: ChannelView;
  readonly counts: SectionCounts;
}

const CHAINS: Readonly<Record<number, string>> = { 8453: "Base", 84532: "Base Sepolia" };

export const channelOf = (config: DashboardConfig): ChannelView => ({
  mode: config.surfaceMode,
  name: CHANNEL_NAMES[config.surfaceMode],
  line: `${new URL(config.publicBaseUrl).host} · ${
    config.walletChain === null
      ? "no chain"
      : (CHAINS[config.walletChain] ?? `chain ${config.walletChain}`)
  }`,
});

/** How long the frame waits for an area's counts: a page is answered whole. */
const COUNTS_WITHIN_MS = 2_000;

/** An area's answer for the counts of its own sections. */
export type CountsOf = (operator: Operator) => Promise<SectionCounts>;

export async function frameView(
  config: DashboardConfig,
  operator: Operator,
  areas: readonly CountsOf[],
): Promise<AdminFrameView> {
  const within = (counted: Promise<SectionCounts>): Promise<SectionCounts> =>
    Promise.race([
      counted,
      new Promise<SectionCounts>((resolve) => {
        setTimeout(() => resolve({}), COUNTS_WITHIN_MS).unref();
      }),
    ]).catch(() => {
      console.error("[dashboard] a section's count for the workspace could not be read");
      return {};
    });
  const answered = await Promise.all(areas.map((counts) => within(counts(operator))));
  return {
    channel: channelOf(config),
    counts: Object.assign({}, ...answered) as SectionCounts,
  };
}
