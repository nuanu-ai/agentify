/**
 * What a stack says about itself to a reader, by its mode, for every surface on
 * the origin: the dashboard, the documentation and the scanner draw the same
 * band. It imports nothing, so a server module, or an image built without the
 * seller's core, can take it alone.
 */

/** The attribute every surface carries, holding the mode it is rendering. */
export const SURFACE_MARKER_ATTRIBUTE = "data-agentify-surface";

/**
 * What each mode says to a reader, and nothing where there is nothing to warn
 * about. The test wording claims only what the payment is made in: a test
 * chain says the money is not real, not that anything settles, since any
 * facilitator on it is a test mode, a local model that settles nothing among
 * them; nor does it prove anything about what a merchant's worker does with
 * the order, and the merchants here run their own code. The words open with
 * the name the operator's workspace gives the mode.
 */
export const SURFACE_WORDS: Readonly<Record<"sandbox" | "test" | "live", string | null>> = {
  sandbox: "Sandbox. There is no chain here: payments are pretend and no money moves.",
  test: "Test environment. Payments use test funds, not real money.",
  live: null,
};
