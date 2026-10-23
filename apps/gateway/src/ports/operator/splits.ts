/**
 * The reads of the registry of payout splits the workspace makes across
 * merchants: one row per split with what settled into it, for Money. A split
 * waiting behind a merchant's pending wallet change stays inside the registry:
 * nothing here hands out its address.
 */

// biome-ignore lint/suspicious/noEmptyInterface: the figures area adds its reads here.
export interface OperatorSplits {}
