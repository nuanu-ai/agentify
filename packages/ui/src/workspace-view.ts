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

/** What each channel is called wherever the workspace names it, as the band over a test page names it. */
export const CHANNEL_NAMES: Readonly<Record<ChannelMode, string>> = {
  live: "Production",
  test: "Test environment",
  sandbox: "Sandbox",
};

/**
 * A channel named in running text: "in production", "in the test
 * environment", "in the sandbox". A page names its own channel once, in its
 * band, and its sentences then say "here"; a message, which has no band, and a
 * sentence about another channel than the page's, name it with this.
 */
export const inChannel = (mode: ChannelMode): string =>
  mode === "live" ? "in production" : `in the ${CHANNEL_NAMES[mode].toLowerCase()}`;

export interface ChannelView {
  readonly mode: ChannelMode;
  /** One of `CHANNEL_NAMES`. */
  readonly name: string;
}
