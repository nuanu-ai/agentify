/**
 * What the operator's workspace's frame is drawn from, apart from the frame
 * itself, so a server module can name it without drawing anything: the
 * sections, their counts and the channel.
 */

/** The sections of the workspace, as its sidebar lists them. */
export type AdminSection =
  | "overview"
  | "merchants"
  | "orders"
  | "money"
  | "health"
  | "scanner"
  | "accounts"
  | "journal";

/** A section's count: how many wait there, red only where they wait for the operator. */
export type SectionCount = Readonly<{ count: number; needsYou: boolean }>;

export type SectionCounts = Readonly<Partial<Record<AdminSection, SectionCount>>>;

type ChannelMode = "live" | "test" | "sandbox";

/** What each channel is called wherever the workspace names it. */
export const CHANNEL_NAMES: Readonly<Record<ChannelMode, string>> = {
  live: "Live channel",
  test: "Test channel",
  sandbox: "Sandbox",
};

export interface ChannelView {
  readonly mode: ChannelMode;
  /** One of `CHANNEL_NAMES`. */
  readonly name: string;
  /** The site's host, and the chain it settles on where the drawing application knows it. */
  readonly line: string;
}
