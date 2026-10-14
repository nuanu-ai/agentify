/**
 * The payout split table for tests that run a live gateway, which the code's
 * own table cannot do while it names no commission wallet on Base. It is the
 * code's table with a Base entry no deployment ever uses: the commission
 * wallet is the distributor of the Base Sepolia experiment, an address that
 * exists here only as a fixture, and Base's USDC is the asset the gateway's
 * payment library names for Base.
 */

import {
  PAYOUT_SPLIT_NETWORKS,
  type PayoutSplitNetworks,
  payoutSplitNetworkOf,
} from "../split/networks.js";

const BASE_SEPOLIA = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532");

export const SPLIT_NETWORKS_WITH_A_FIXTURE_BASE: PayoutSplitNetworks = {
  ...PAYOUT_SPLIT_NETWORKS,
  "eip155:8453": {
    ...BASE_SEPOLIA,
    network: "eip155:8453",
    commissionWallet: "0xF029d915c69C1902bB09A86c801c8226825F265c",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
};
