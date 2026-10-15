/**
 * The pre-release check of the commission wallets: for Base and Base Sepolia,
 * and any other network the code's payout split table names, it reads from a
 * public RPC that the chain is the one named, what the commission wallet is,
 * and that the factory, the implementation, the warehouse, Multicall3 and USDC
 * the table names hold code. It reads and sends nothing else, holds no key and
 * never runs from `pnpm test`.
 *
 *   pnpm commission-wallet
 *   COMMISSION_SAFE_OWNERS=0x…,0x… pnpm commission-wallet
 *
 * On Base, where the money is real, the commission wallet must be a Safe. On
 * Base Sepolia a plain wallet passes and is said to be one. A commission
 * wallet that holds code, on either, passes only as a Safe: `getThreshold()`
 * answers, and `getOwners()` answers exactly the owners named for its network,
 * in any order; COMMISSION_SAFE_OWNERS names Base's, separated by commas. A
 * network the table has no entry for fails without a read: nothing there can
 * be sold.
 *
 * Each commission wallet's address must also hold no code on every other chain
 * the check reads: Base, Base Sepolia, Ethereum and Ethereum Sepolia. An
 * address with no code on its own chain may be somebody's contract on another,
 * as a token is, and nobody holds a key to it; and a Safe's address on another
 * chain would be another contract. That chain's RPC must answer that chain's
 * id first, so a read of the wrong chain is not taken for an empty one.
 *
 * Each check prints one line, PASS or FAIL, with what was read. The command
 * exits 1 when any check fails, which holds the release, and 0 when all pass.
 * BASE_RPC_URL, BASE_SEPOLIA_RPC_URL, ETHEREUM_RPC_URL and
 * ETHEREUM_SEPOLIA_RPC_URL replace the public RPCs (https://mainnet.base.org,
 * https://sepolia.base.org, https://ethereum-rpc.publicnode.com,
 * https://ethereum-sepolia-rpc.publicnode.com).
 */

import { isTestnetChain } from "@agentify/core";
import {
  PAYOUT_SPLIT_NETWORKS,
  type PayoutSplitNetwork,
  type PayoutSplitNetworks,
} from "@agentify/gateway";
import {
  createPublicClient,
  custom,
  getAddress,
  http,
  isAddress,
  type PublicClient,
  parseAbi,
} from "viem";

/** The networks a release sells on, each checked whether the table names it or not. */
const RELEASE_NETWORKS = ["eip155:8453", "eip155:84532"] as const;

/** Chains read only for whether a commission wallet's address is a contract there. */
const ALSO_READ = ["eip155:1", "eip155:11155111"] as const;

const PUBLIC_RPCS: Readonly<Record<string, string | undefined>> = {
  "eip155:8453": process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
  "eip155:84532": process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
  "eip155:1": process.env.ETHEREUM_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
  "eip155:11155111":
    process.env.ETHEREUM_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
};

const SAFE = parseAbi([
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
]);

/** One check on one network, and what it read. */
export interface Verdict {
  readonly network: string;
  readonly check: string;
  readonly passed: boolean;
  readonly saw: string;
}

type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly why: string };

/** What the RPC answered, or the first line of why it did not. */
const read = async <T>(asking: () => Promise<T>): Promise<Read<T>> => {
  try {
    return { ok: true, value: await asking() };
  } catch (thrown) {
    const words = thrown instanceof Error ? thrown.message : String(thrown);
    return { ok: false, why: words.split("\n")[0] ?? "" };
  }
};

/**
 * The owners a COMMISSION_SAFE_OWNERS value names, checksummed, or null where
 * it is not set. Refuses anything in it that is not an address.
 */
export function ownersFrom(written: string | undefined): readonly string[] | null {
  if (written === undefined) {
    return null;
  }
  return written.split(",").map((owner) => {
    const trimmed = owner.trim();
    if (!isAddress(trimmed)) {
      throw new Error(
        `COMMISSION_SAFE_OWNERS names ${JSON.stringify(trimmed)}, which is not an address; it is the Safe's owners, separated by commas`,
      );
    }
    return getAddress(trimmed);
  });
}

/** The chain id a CAIP-2 network names. */
const chainIdIn = (network: string): number => Number(network.split(":")[1]);

async function verdictsOn(
  network: string,
  entry: PayoutSplitNetwork | undefined,
  owners: readonly string[] | undefined,
  chains: {
    readonly read: readonly string[];
    readonly clientOf: (network: string) => PublicClient;
    readonly idOf: (network: string) => Promise<Read<number>>;
  },
): Promise<readonly Verdict[]> {
  const client = chains.clientOf(network);
  const verdicts: Verdict[] = [];
  const verdict = (check: string, passed: boolean, saw: string): void => {
    verdicts.push({ network, check, passed, saw });
  };

  if (entry === undefined) {
    verdict(
      "the code table",
      false,
      "it names no payout split here, so no commission wallet: nothing on this network can be sold",
    );
    return verdicts;
  }

  const expected = chainIdIn(network);
  const chain = await chains.idOf(network);
  if (!chain.ok || chain.value !== expected) {
    verdict(
      "chain id",
      false,
      chain.ok
        ? `the RPC answers chain ${chain.value}, where ${network} is ${expected}, so nothing more is read from it`
        : `the RPC did not answer: ${chain.why}`,
    );
    return verdicts;
  }
  verdict("chain id", true, `${chain.value}`);

  const live = !isTestnetChain(network);
  const wallet = getAddress(entry.commissionWallet);
  const code = await read(() => client.getCode({ address: wallet }));
  if (!code.ok) {
    verdict("commission wallet", false, `${wallet}: the RPC did not answer: ${code.why}`);
  } else if (code.value === undefined) {
    verdict(
      "commission wallet",
      !live,
      live
        ? `${wallet} holds no code: a plain wallet, and here the commission wallet must be a Safe, since one lost key would lose every commission`
        : `${wallet} holds no code: a plain wallet`,
    );
  } else {
    verdict(
      "commission wallet",
      true,
      `${wallet} holds ${(code.value.length - 2) / 2} bytes of code`,
    );
    const threshold = await read(() =>
      client.readContract({ address: wallet, abi: SAFE, functionName: "getThreshold" }),
    );
    const owned = await read(() =>
      client.readContract({ address: wallet, abi: SAFE, functionName: "getOwners" }),
    );
    verdict(
      "Safe threshold",
      threshold.ok,
      threshold.ok
        ? `${threshold.value} signatures move the commission`
        : `getThreshold() did not answer, so this is no Safe: ${threshold.why}`,
    );
    if (!owned.ok) {
      verdict(
        "Safe owners",
        false,
        `getOwners() did not answer, so who can move the commission is not known: ${owned.why}`,
      );
    } else {
      const have: readonly string[] = owned.value.map((owner) => getAddress(owner));
      if (owners === undefined) {
        verdict(
          "Safe owners",
          false,
          `${have.join(", ")}; no owners are named for ${network} to hold them to`,
        );
      } else {
        const named: readonly string[] = owners.map((owner) => getAddress(owner));
        const strangers = [
          ...named.filter((owner) => !have.includes(owner)),
          ...have.filter((owner) => !named.includes(owner)),
        ];
        verdict(
          "Safe owners",
          strangers.length === 0,
          strangers.length === 0
            ? have.join(", ")
            : `${have.join(", ")}; named or owning, and not both: ${strangers.join(", ")}`,
        );
      }
    }
  }

  for (const other of chains.read.filter((chain) => chain !== network)) {
    const check = `commission wallet on ${other}`;
    const id = await chains.idOf(other);
    if (!id.ok || id.value !== chainIdIn(other)) {
      verdict(
        check,
        false,
        id.ok
          ? `the RPC for ${other} answers chain ${id.value}, so what ${wallet} is there is not known`
          : `the RPC for ${other} did not answer: ${id.why}`,
      );
      continue;
    }
    const there = await read(() => chains.clientOf(other).getCode({ address: wallet }));
    verdict(
      check,
      there.ok && there.value === undefined,
      !there.ok
        ? `the RPC for ${other} did not answer: ${there.why}`
        : there.value === undefined
          ? `${wallet} holds no code on ${other}`
          : `${wallet} holds ${(there.value.length - 2) / 2} bytes of code on ${other}: a contract there, not an account`,
    );
  }

  for (const [check, address] of [
    ["factory", entry.factory],
    ["implementation", entry.implementation],
    ["warehouse", entry.warehouse],
    ["Multicall3", entry.multicall3],
    ["USDC", entry.usdc],
  ] as const) {
    const held = await read(() => client.getCode({ address: getAddress(address) }));
    verdict(
      check,
      held.ok && held.value !== undefined,
      !held.ok
        ? `${address}: the RPC did not answer: ${held.why}`
        : held.value === undefined
          ? `${address} holds no code`
          : `${address} holds ${(held.value.length - 2) / 2} bytes of code`,
    );
  }
  return verdicts;
}

/**
 * Every check on every network named, in order. `chainsRead` are the chains on
 * which every commission wallet's address must hold no code but its own
 * network; `owners` are, by network, the owners a commission wallet holding
 * code there must have.
 */
export async function commissionWalletVerdicts(options: {
  readonly networks: readonly string[];
  readonly chainsRead: readonly string[];
  readonly table: PayoutSplitNetworks;
  readonly clientOf: (network: string) => PublicClient;
  readonly owners: Readonly<Record<string, readonly string[]>>;
}): Promise<readonly Verdict[]> {
  const ids = new Map<string, Promise<Read<number>>>();
  const chains = {
    read: options.chainsRead,
    clientOf: options.clientOf,
    idOf: (network: string): Promise<Read<number>> => {
      const asked = ids.get(network) ?? read(() => options.clientOf(network).getChainId());
      ids.set(network, asked);
      return asked;
    },
  };
  const verdicts: Verdict[] = [];
  for (const network of options.networks) {
    const entry = Object.hasOwn(options.table, network) ? options.table[network] : undefined;
    const owners = Object.hasOwn(options.owners, network) ? options.owners[network] : undefined;
    verdicts.push(...(await verdictsOn(network, entry, owners, chains)));
  }
  return verdicts;
}

/** A client of the network's public RPC, or one that answers nothing where none is known. */
const publicClientOf = (network: string): PublicClient => {
  const url = PUBLIC_RPCS[network];
  return createPublicClient({
    transport:
      url === undefined
        ? custom({
            request: async () => {
              throw new Error(`no RPC is known for ${network}`);
            },
          })
        : http(url),
  });
};

async function main(): Promise<number> {
  let owners: readonly string[] | null;
  try {
    owners = ownersFrom(process.env.COMMISSION_SAFE_OWNERS);
  } catch (thrown) {
    console.error(
      `[commission-wallet] ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
    return 2;
  }
  const networks = [...new Set([...RELEASE_NETWORKS, ...Object.keys(PAYOUT_SPLIT_NETWORKS)])];
  const verdicts = await commissionWalletVerdicts({
    networks,
    chainsRead: [...new Set([...networks, ...ALSO_READ])],
    table: PAYOUT_SPLIT_NETWORKS,
    clientOf: publicClientOf,
    owners: owners === null ? {} : { "eip155:8453": owners },
  });
  for (const verdict of verdicts) {
    console.log(
      `[commission-wallet] ${verdict.passed ? "PASS" : "FAIL"} ${verdict.network} ${verdict.check}: ${verdict.saw}`,
    );
  }
  if (owners === null && verdicts.some((verdict) => verdict.check === "Safe owners")) {
    console.log(
      "[commission-wallet] COMMISSION_SAFE_OWNERS names the owners Base's commission Safe must have",
    );
  }
  const failed = verdicts.filter((verdict) => !verdict.passed).length;
  console.log(
    failed === 0
      ? `[commission-wallet] all ${verdicts.length} checks passed`
      : `[commission-wallet] ${failed} of ${verdicts.length} checks failed: the release waits`,
  );
  return failed === 0 ? 0 : 1;
}

// Only where somebody typed the command: the smoke and the tests import the
// check above, and a run on import would read the chain from inside them.
if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (thrown: unknown) => {
      console.error(
        `[commission-wallet] the check did not finish: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
      );
      process.exitCode = 1;
    },
  );
}
