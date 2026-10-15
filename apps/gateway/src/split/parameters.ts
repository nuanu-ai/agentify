/**
 * The one rule every merchant's payout split is made by: their wallet first,
 * the network's commission wallet second, the shares the network's rate gives,
 * no owner and no cut for whoever pays it out.
 */

import { getAddress } from "viem";
import {
  checkedAddress,
  payoutSplitSalt,
  type SplitParameters,
  splitAddress,
  ZERO_ADDRESS,
} from "./address.js";
import type { PayoutSplitNetwork } from "./networks.js";

/**
 * One merchant's payout split on one network, with every parameter the
 * factory needs to create it. Until the split's first payout these are
 * nowhere but here, so this is what the registry records and what a payout is
 * built from; every address is in its checksummed spelling.
 */
export interface PayoutSplit {
  /** Where buyers pay: the address the factory creates the split at. */
  readonly address: string;
  /** The CAIP-2 chain the split is on. */
  readonly network: string;
  readonly merchantId: string;
  /** The merchant's wallet, the first recipient. */
  readonly merchantWallet: string;
  /** Agentify's wallet, the second recipient. */
  readonly commissionWallet: string;
  readonly merchantAllocation: number;
  readonly commissionAllocation: number;
  readonly totalAllocation: number;
  readonly distributionIncentive: number;
  readonly owner: string;
  /** The salt handed to the factory. */
  readonly salt: string;
  /** The factory that creates the split. */
  readonly factory: string;
}

/**
 * The split a merchant's wallet is paid through on this network. The same
 * merchant and wallet always give the same split; a wallet in lower case gives
 * the same one as in its checksummed spelling. Refuses a wallet whose capitals
 * disagree with it, the zero address and the commission wallet itself.
 */
export function payoutSplitFor(
  network: PayoutSplitNetwork,
  merchantId: string,
  merchantWallet: string,
): PayoutSplit {
  const wallet = checkedAddress(merchantWallet, "the merchant's wallet");
  const commissionWallet = getAddress(network.commissionWallet);
  const salt = payoutSplitSalt(network.network, merchantId);
  const merchantAllocation = network.totalAllocation - network.commissionAllocation;
  const address = splitAddress({
    factory: network.factory,
    implementation: network.implementation,
    recipients: [wallet, commissionWallet],
    allocations: [merchantAllocation, network.commissionAllocation],
    totalAllocation: network.totalAllocation,
    distributionIncentive: 0,
    owner: ZERO_ADDRESS,
    salt,
  });
  return {
    address,
    network: network.network,
    merchantId,
    merchantWallet: wallet,
    commissionWallet,
    merchantAllocation,
    commissionAllocation: network.commissionAllocation,
    totalAllocation: network.totalAllocation,
    distributionIncentive: 0,
    owner: ZERO_ADDRESS,
    salt,
    factory: getAddress(network.factory),
  };
}

/** A recorded split's parameters in the form the factory and the split take them. */
export function splitParametersOf(split: PayoutSplit): SplitParameters {
  return {
    recipients: [split.merchantWallet, split.commissionWallet],
    allocations: [split.merchantAllocation, split.commissionAllocation],
    totalAllocation: split.totalAllocation,
    distributionIncentive: split.distributionIncentive,
    owner: split.owner,
    salt: split.salt,
  };
}
