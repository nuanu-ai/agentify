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
 * On Base, where the money is real, the commission wallet must be a Safe:
 * code that answers `getThreshold()` with at least one and no more than its
 * owners, and `getOwners()` with exactly the addresses COMMISSION_SAFE_OWNERS
 * names, in any order. On Base Sepolia a plain wallet passes and is said to be
 * one; a contract there is held to the same Safe reads, its owners printed
 * and not compared. A network the table has no entry for fails without a
 * read: nothing there can be sold.
 *
 * Each check prints one line, PASS or FAIL, with what was read. The command
 * exits 1 when any check fails, which holds the release, and 0 when all pass.
 * BASE_RPC_URL and BASE_SEPOLIA_RPC_URL replace the public RPCs
 * (https://mainnet.base.org, https://sepolia.base.org).
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

const PUBLIC_RPCS: Readonly<Record<string, string | undefined>> = {
  "eip155:8453": process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
  "eip155:84532": process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
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

const read = async <T>(asking: () => Promise<T>): Promise<Read<T>> => {
  try {
    return { ok: true, value: await asking() };
  } catch (thrown) {
    const words =
      typeof thrown === "object" && thrown !== null && "shortMessage" in thrown
        ? String(thrown.shortMessage)
        : thrown instanceof Error
          ? thrown.message
          : String(thrown);
    return { ok: false, why: words.split("\n")[0] ?? words };
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

async function verdictsOn(
  network: string,
  entry: PayoutSplitNetwork | undefined,
  client: PublicClient,
  owners: readonly string[] | null,
): Promise<readonly Verdict[]> {
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

  const expected = Number(/^eip155:(\d+)$/.exec(network)?.[1] ?? Number.NaN);
  const chain = await read(() => client.getChainId());
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
    const count = owned.ok ? BigInt(owned.value.length) : null;
    verdict(
      "Safe threshold",
      threshold.ok && threshold.value >= 1n && (count === null || threshold.value <= count),
      threshold.ok
        ? `${threshold.value} of ${count ?? "unreadable"} owners`
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
      const listed = have.join(", ");
      if (!live) {
        verdict("Safe owners", true, listed);
      } else if (owners === null) {
        verdict(
          "Safe owners",
          false,
          `${listed}; name the owners the Safe must have in COMMISSION_SAFE_OWNERS, and they are compared`,
        );
      } else {
        const named: readonly string[] = owners.map((owner) => getAddress(owner));
        const missing = named.filter((owner) => !have.includes(owner));
        const unnamed = have.filter((owner) => !named.includes(owner));
        verdict(
          "Safe owners",
          missing.length === 0 && unnamed.length === 0,
          missing.length === 0 && unnamed.length === 0
            ? listed
            : `${listed}; named and not an owner: ${missing.join(", ") || "none"}; an owner and not named: ${unnamed.join(", ") || "none"}`,
        );
      }
    }
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
 * Every check on every network named, in order. `owners` are the owners the
 * commission Safe on a live chain must have; on a test chain a Safe's owners
 * are printed and not compared.
 */
export async function commissionWalletVerdicts(options: {
  readonly networks: readonly string[];
  readonly table: PayoutSplitNetworks;
  readonly clientOf: (network: string) => PublicClient;
  readonly owners: readonly string[] | null;
}): Promise<readonly Verdict[]> {
  const verdicts: Verdict[] = [];
  for (const network of options.networks) {
    const entry = Object.hasOwn(options.table, network) ? options.table[network] : undefined;
    verdicts.push(...(await verdictsOn(network, entry, options.clientOf(network), options.owners)));
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
    table: PAYOUT_SPLIT_NETWORKS,
    clientOf: publicClientOf,
    owners,
  });
  for (const verdict of verdicts) {
    console.log(
      `[commission-wallet] ${verdict.passed ? "PASS" : "FAIL"} ${verdict.network} ${verdict.check}: ${verdict.saw}`,
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
