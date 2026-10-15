/**
 * What a payout split is made of on each network, written in code and never
 * read from a setting: the commission wallet, the rate and the factory enter
 * every split's address, so changing one moves every merchant's money to new
 * addresses, and a change here passes review where a line in a host's file
 * would not.
 */

/** One network's payout split: who it pays, in what shares, and the contracts it uses. */
export interface PayoutSplitNetwork {
  /** The CAIP-2 chain, as `PAYMENT_NETWORK` names it. */
  readonly network: string;
  /** Agentify's wallet on this network, the second recipient of every split here. */
  readonly commissionWallet: string;
  /** Agentify's share of every payment, in parts of `totalAllocation`. */
  readonly commissionAllocation: number;
  /** What the merchant's and Agentify's shares add up to, as the split contract counts. */
  readonly totalAllocation: number;
  /** The 0xSplits v2.2 PullSplitFactory every split here is created by. */
  readonly factory: string;
  /** The PullSplit the factory clones, which enters every split's address. */
  readonly implementation: string;
  /** The 0xSplits warehouse a distribution credits and a withdrawal pays from. */
  readonly warehouse: string;
  /** Multicall3, which runs a payout's calls in one transaction. */
  readonly multicall3: string;
  /** USDC on this network: the token every payment challenge here asks for. */
  readonly usdc: string;
}

/** The payout split of each network a gateway may take payments on, by CAIP-2 chain. */
export type PayoutSplitNetworks = Readonly<Record<string, PayoutSplitNetwork>>;

/**
 * The test channel's commission wallet: the product owner's own account, the
 * same key that signs for the Safe on Base. Every split recorded names it for
 * good, so changing it is a new split for every merchant on the test channel.
 */
const BASE_SEPOLIA_COMMISSION_WALLET = "0x36d44e40d127046B69E1163EF995Fe8C7b159Ca5";

/**
 * The live channel's commission wallet: the product owner's Safe on Base,
 * whose signers and threshold change without its address changing. Every
 * split on Base names it for good, as above.
 */
const BASE_COMMISSION_SAFE = "0xf44Ac5860c13fDa0577305121f00cBa4d0B96541";

/**
 * 0xSplits v2.2 and Multicall3 are deployed at these addresses on Base and on
 * Base Sepolia alike, and so are the rate's terms: Agentify takes 1000 of
 * every 1000000, 0.1%.
 */
const ON_BOTH_BASE_CHAINS = {
  commissionAllocation: 1_000,
  totalAllocation: 1_000_000,
  factory: "0x6B9118074aB15142d7524E8c4ea8f62A3Bdb98f1",
  implementation: "0x98254AeDb6B2c30b70483064367f0BA24ca86244",
  warehouse: "0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
} as const;

/**
 * The networks a gateway can take payments on. A gateway configured for any
 * other refuses to start rather than name a split paying a wallet nobody
 * chose.
 */
export const PAYOUT_SPLIT_NETWORKS: PayoutSplitNetworks = {
  "eip155:84532": {
    network: "eip155:84532",
    commissionWallet: BASE_SEPOLIA_COMMISSION_WALLET,
    ...ON_BOTH_BASE_CHAINS,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  "eip155:8453": {
    network: "eip155:8453",
    commissionWallet: BASE_COMMISSION_SAFE,
    ...ON_BOTH_BASE_CHAINS,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
};

/**
 * The payout split of this network, or a refusal naming it: a network with no
 * commission wallet has no split a buyer could be asked to pay, and lending it
 * another network's would pay a test wallet with real money, or the reverse.
 */
export function payoutSplitNetworkOf(
  networks: PayoutSplitNetworks,
  network: string,
): PayoutSplitNetwork {
  const entry = Object.hasOwn(networks, network) ? networks[network] : undefined;
  if (entry === undefined) {
    throw new Error(
      `no payout split is written for ${JSON.stringify(network)}: the gateway's code names no commission wallet there, so no payment there could be asked for at a split anybody could pay out`,
    );
  }
  return entry;
}
