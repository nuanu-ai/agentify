/**
 * Where a payout split lives, computed without asking any chain. The factory
 * deploys each split with CREATE2, so its address follows from the factory,
 * the code it clones, the split's parameters and a salt, and a buyer can pay
 * it before anybody creates it there.
 */

import {
  type Address,
  concat,
  encodeAbiParameters,
  getAddress,
  getContractAddress,
  type Hex,
  isAddress,
  keccak256,
} from "viem";

/** A split's parameters as `createSplitDeterministic` takes them. */
export interface SplitParameters {
  readonly recipients: readonly string[];
  /** Each recipient's share, in parts of `totalAllocation`, in the recipients' order. */
  readonly allocations: readonly number[];
  readonly totalAllocation: number;
  /** What whoever distributes the split is paid of each distribution, in millionths. */
  readonly distributionIncentive: number;
  /** Who could change the split; a payout split has nobody, the zero address. */
  readonly owner: string;
  /** The salt the factory is handed, before it mixes the parameters into it. */
  readonly salt: string;
}

/** The factory that creates a split, and the implementation it clones. */
export interface SplitDeployment {
  readonly factory: string;
  readonly implementation: string;
}

/** A split's parameters, checked and in the form the ABI encoder takes. */
export interface CheckedSplit {
  readonly recipients: readonly Address[];
  readonly allocations: readonly bigint[];
  readonly totalAllocation: bigint;
  readonly distributionIncentive: number;
  readonly owner: Address;
  readonly salt: Hex;
}

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** How the factory takes a split, `SplitV2Lib.Split`. */
export const SPLIT_TUPLE = {
  type: "tuple",
  components: [
    { name: "recipients", type: "address[]" },
    { name: "allocations", type: "uint256[]" },
    { name: "totalAllocation", type: "uint256" },
    { name: "distributionIncentive", type: "uint16" },
  ],
} as const;

/**
 * An address in its checksummed spelling, or a refusal. Lower case and the
 * exact checksummed spelling are taken; capitals that disagree with the
 * address are refused, as `isAddress` does by default, because they mean a
 * character is wrong and a wrong address is somebody else's.
 */
export function checkedAddress(address: string, what: string): Address {
  if (!isAddress(address)) {
    throw new Error(
      `${what}, ${JSON.stringify(address)}, is not an address: an address is 0x and forty hexadecimal characters, in lower case or in its exact checksummed spelling`,
    );
  }
  return getAddress(address);
}

/**
 * Whether two strings spell one address. A checksum's capitals are no part of
 * the address, so a wallet stored in lower case and its split's row, which
 * names it checksummed, are one wallet.
 */
export function isSameAddress(one: string, other: string): boolean {
  return one.toLowerCase() === other.toLowerCase();
}

/**
 * The split's parameters, or a refusal naming why no payout could ever empty
 * the split they make. The factory itself checks only that the allocations
 * match the recipients and add up to the total; the rest are what a payout
 * split must be for the shares to reach the merchant and Agentify and nobody
 * else.
 */
export function checkedSplit(split: SplitParameters): CheckedSplit {
  const refuse = (why: string): never => {
    throw new Error(`No address is given for these split parameters: ${why}`);
  };
  const { recipients, allocations, totalAllocation, distributionIncentive } = split;

  if (recipients.length !== allocations.length) {
    refuse(
      `they name ${recipients.length} recipients and allocations for ${allocations.length}, and the factory creates a split only where each recipient has one`,
    );
  }
  if (recipients.length !== 2) {
    refuse(
      `a payout split has two recipients, the merchant's wallet and then the commission wallet, and these name ${recipients.length}`,
    );
  }
  const checked = recipients.map((recipient) => checkedAddress(recipient, "a recipient"));
  if (checked.includes(ZERO_ADDRESS)) {
    refuse(
      "a recipient is the zero address, and USDC sends nothing there, so its share would never leave",
    );
  }
  if (new Set(checked).size !== checked.length) {
    refuse(
      "they name one wallet twice, which would take both shares; the merchant's wallet and the commission wallet are two wallets",
    );
  }
  for (const allocation of allocations) {
    if (!Number.isSafeInteger(allocation) || allocation < 0) {
      refuse(`an allocation is ${allocation}, and an allocation is a whole number of parts`);
    }
  }
  if (totalAllocation === 0) {
    refuse(
      "the total allocation is zero: the factory creates such a split, and then every distribution divides by it and fails",
    );
  }
  const sum = allocations.reduce((total, allocation) => total + allocation, 0);
  if (sum !== totalAllocation) {
    refuse(
      `the allocations add up to ${sum}, not to the total allocation of ${totalAllocation}, so the factory refuses to create the split and whatever is paid to its address stays there`,
    );
  }
  if (distributionIncentive !== 0) {
    refuse(
      `the distribution incentive is ${distributionIncentive}: it pays whoever distributes the split a cut of every payout, and a payout split pays nobody but its two recipients`,
    );
  }
  const owner = checkedAddress(split.owner, "the owner");
  if (owner !== ZERO_ADDRESS) {
    refuse(
      `the owner is ${owner}: an owner can change the recipients and make the split call anything, so a payout split has none, the zero address`,
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(split.salt)) {
    refuse(`the salt ${JSON.stringify(split.salt)} is not thirty-two bytes written in hexadecimal`);
  }

  return {
    recipients: checked,
    allocations: allocations.map(BigInt),
    totalAllocation: BigInt(totalAllocation),
    distributionIncentive,
    owner,
    salt: split.salt as Hex,
  };
}

/**
 * The code the factory deploys a split with: Splits' minimal proxy of the
 * implementation, 98 bytes, then the 15 zero bytes of the memory slot after
 * it, which the factory's CREATE2 hashes with them. Leaving them out gives an
 * address no split can ever have.
 */
export function cloneInitCode(implementation: string): Hex {
  const body = checkedAddress(implementation, "the implementation").slice(2).toLowerCase();
  return `0x60593d8160093d39f336602c57343d527f9e4ac34f21c619cefc926c8bd93b54bf5a39c7ab2127a895af1cc0691d7e3dff593da1005b3d3d3d3d363d3d37363d73${body}5af43d3d93803e605757fd5bf3${"00".repeat(15)}`;
}

/**
 * The address the factory creates this split at, in its checksummed spelling,
 * or a refusal for parameters that would make a split nothing could pay out.
 * The factory salts CREATE2 with the hash of the split's parameters and owner
 * followed by the given salt, so any change to them is another address.
 */
export function splitAddress(split: SplitParameters & SplitDeployment): Address {
  const checked = checkedSplit(split);
  const factory = checkedAddress(split.factory, "the factory");
  const encoded = encodeAbiParameters(
    [SPLIT_TUPLE, { type: "address" }],
    [
      {
        recipients: checked.recipients,
        allocations: checked.allocations,
        totalAllocation: checked.totalAllocation,
        distributionIncentive: checked.distributionIncentive,
      },
      checked.owner,
    ],
  );
  return getContractAddress({
    opcode: "CREATE2",
    from: factory,
    salt: keccak256(concat([encoded, checked.salt])),
    bytecodeHash: keccak256(cloneInitCode(split.implementation)),
  });
}

/** What every payout split's salt begins with, so no other use of the hash collides with it. */
const SALT_LABEL = "agentify.payout-split";

/**
 * The salt of a merchant's payout split on a network:
 * `keccak256(abi.encode(string "agentify.payout-split", uint256 chainId, string merchantId))`.
 * The chain id keeps the test chain's splits off the live chain, where the
 * factory sits at the same address; the merchant's identifier keeps two
 * merchants with one wallet apart. Nothing else enters it, so a merchant who
 * returns to a wallet returns to the split they had there.
 */
export function payoutSplitSalt(network: string, merchantId: string): Hex {
  const chain = /^eip155:([1-9][0-9]*)$/.exec(network);
  if (chain?.[1] === undefined) {
    throw new Error(
      `${JSON.stringify(network)} is not an EVM chain written as eip155 and its chain id in decimal, which is what a payout split's salt is made from`,
    );
  }
  if (merchantId === "") {
    throw new Error(
      "a payout split's salt is made from the merchant's identifier, and none was given",
    );
  }
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "string" }],
      [SALT_LABEL, BigInt(chain[1]), merchantId],
    ),
  );
}
