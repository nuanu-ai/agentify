import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { type Address, createPublicClient, decodeEventLog, type Hex, http, parseAbi } from "viem";
import { base, baseSepolia } from "viem/chains";
import type {
  PaymentRecoveryContext,
  PaymentRecoveryOutcome,
  PaymentRecoveryRequest,
} from "../../ports/facilitator.js";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "../../split/networks.js";

export type RecoveryAuthorization = Omit<PaymentRecoveryContext, "fromBlock">;
export interface ChainBlock {
  number: bigint;
  hash: string;
  timestamp: bigint;
}
export interface ChainLog {
  address: string;
  topics: readonly string[];
  data: string;
  logIndex: number;
  transactionHash: string;
  blockNumber: bigint;
  blockHash: string;
  removed?: boolean;
}
export interface ChainReceipt {
  transactionHash: string;
  blockNumber: bigint;
  blockHash: string;
  status: "success" | "reverted";
  logs: readonly ChainLog[];
}
/** Only reads: this adapter has no transaction submission capability. */
export interface ChainReader {
  networkId(): Promise<number>;
  block(number?: bigint): Promise<ChainBlock>;
  authorizationState(context: RecoveryAuthorization, number: bigint): Promise<boolean>;
  authorizationLogs(
    context: RecoveryAuthorization,
    from: bigint,
    to: bigint,
  ): Promise<readonly ChainLog[]>;
  receipt(transaction: string): Promise<ChainReceipt>;
}

const ABI = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const SCAN_BLOCKS = 1000n;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const address = (value: unknown): value is string =>
  typeof value === "string" && /^0x[\da-f]{40}$/i.test(value);
const integer = (value: unknown): value is string =>
  typeof value === "string" && /^\d+$/.test(value);
const uint256 = (value: unknown): value is string => integer(value) && BigInt(value) < 1n << 256n;
const nonce = (value: unknown): value is string =>
  typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Refuses payment shapes whose original outcome this gateway cannot prove. */
export function authorizationOf(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): RecoveryAuthorization {
  const signed = record(payload.payload);
  const auth = record(signed?.authorization);
  const network = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, requirements.network);
  if (
    payload.x402Version !== 2 ||
    payload.accepted?.scheme !== "exact" ||
    requirements.scheme !== "exact" ||
    (payload.accepted.extra?.assetTransferMethod !== undefined &&
      payload.accepted.extra.assetTransferMethod !== "eip3009") ||
    (requirements.extra?.assetTransferMethod !== undefined &&
      requirements.extra.assetTransferMethod !== "eip3009") ||
    !same(requirements.asset, network.usdc) ||
    signed?.permit2Authorization !== undefined ||
    typeof signed?.signature !== "string" ||
    !/^0x(?:[\da-f]{2})*$/i.test(signed.signature) ||
    !auth ||
    !address(auth.from) ||
    !address(auth.to) ||
    !uint256(auth.value) ||
    !uint256(auth.validAfter) ||
    !uint256(auth.validBefore) ||
    !nonce(auth.nonce) ||
    !same(auth.to, requirements.payTo) ||
    auth.value !== requirements.amount ||
    BigInt(auth.validBefore) <= BigInt(auth.validAfter)
  ) {
    throw new Error(
      "This gateway accepts x402 v2 exact USDC EIP-3009 payments on Base or Base Sepolia with the exact signed amount and recipient; Permit2 and other payment methods are not supported.",
    );
  }
  return {
    kind: "evm-exact-eip3009",
    network: requirements.network,
    asset: network.usdc,
    payer: auth.from,
    payTo: requirements.payTo,
    amount: auth.value,
    validAfter: auth.validAfter,
    validBefore: auth.validBefore,
    nonce: auth.nonce,
  };
}

export class Eip3009Recovery {
  constructor(private readonly readerFor: (network: string) => ChainReader) {}

  async reconcile(request: PaymentRecoveryRequest): Promise<PaymentRecoveryOutcome> {
    try {
      const { context } = request;
      if (
        !uint256(context.fromBlock) ||
        (request.nextBlock !== undefined && !uint256(request.nextBlock))
      )
        throw new Error("Invalid recovery cursor.");
      const reader = await this.reader(context);
      const finalized = await reader.block();
      const used = await reader.authorizationState(context, finalized.number);
      if (!used && finalized.timestamp >= BigInt(context.validBefore)) {
        return {
          settled: false,
          reason: "The original payment authorization expired unused on the finalized chain.",
        };
      }
      if (request.transaction && nonce(request.transaction)) {
        try {
          const proof = await this.proof(reader, context, finalized, request.transaction);
          if (proof) return proof;
        } catch {
          // A missing hint must not prevent finding the original nonce's transaction.
        }
      }
      if (!used)
        return {
          settled: "unknown",
          reason: "The original authorization remains usable or is awaiting finality.",
        };
      let from = BigInt(request.nextBlock ?? context.fromBlock);
      if (from < BigInt(context.fromBlock)) from = BigInt(context.fromBlock);
      if (from > finalized.number)
        return {
          settled: "unknown",
          reason: "Waiting for finalized evidence of the original authorization.",
        };
      let to = from + SCAN_BLOCKS - 1n;
      if (to > finalized.number) to = finalized.number;
      // Historical state is an optimization; providers without archive reads still progress.
      if (finalized.number - from >= SCAN_BLOCKS) {
        try {
          let low = from;
          let high = finalized.number;
          while (low < high) {
            const middle = (low + high) / 2n;
            if (await reader.authorizationState(context, middle)) high = middle;
            else low = middle + 1n;
          }
          const proof = await this.scan(reader, context, finalized, low, low);
          if (proof) return proof;
        } catch {
          // Retry this optimization on later polls; this range's log cursor is unchanged.
        }
      }
      const proof = await this.scan(reader, context, finalized, from, to);
      return (
        proof ?? {
          settled: "unknown",
          reason: "No verified original transfer or cancellation was found in the completed range.",
          nextBlock: (to + 1n).toString(),
        }
      );
    } catch {
      return {
        settled: "unknown",
        reason: "The original payment outcome could not be verified on chain.",
      };
    }
  }

  private async reader(context: RecoveryAuthorization): Promise<ChainReader> {
    const network = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, context.network);
    if (
      context.kind !== "evm-exact-eip3009" ||
      !same(context.asset, network.usdc) ||
      !address(context.payer) ||
      !address(context.payTo) ||
      !nonce(context.nonce) ||
      !uint256(context.amount) ||
      !uint256(context.validAfter) ||
      !uint256(context.validBefore) ||
      BigInt(context.validBefore) <= BigInt(context.validAfter)
    ) {
      throw new Error("The saved authorization is not a supported payment profile.");
    }
    const reader = this.readerFor(context.network);
    if ((await reader.networkId()) !== Number(context.network.split(":")[1]))
      throw new Error("Wrong RPC chain.");
    return reader;
  }

  private async scan(
    reader: ChainReader,
    context: PaymentRecoveryContext,
    finalized: ChainBlock,
    from: bigint,
    to: bigint,
  ): Promise<PaymentRecoveryOutcome | null> {
    const logs = await reader.authorizationLogs(context, from, to);
    let unproven = false;
    for (const log of logs) {
      if (
        log.removed ||
        log.blockNumber < from ||
        log.blockNumber > to ||
        !this.authorizationEvent(log, context)
      )
        continue;
      const proof = await this.proof(reader, context, finalized, log.transactionHash);
      if (proof) return proof;
      unproven = true;
    }
    return unproven
      ? {
          settled: "unknown",
          reason:
            "The original authorization was found, but its complete finalized receipt could not be verified.",
        }
      : null;
  }

  private authorizationEvent(
    log: ChainLog,
    context: RecoveryAuthorization,
  ): "AuthorizationUsed" | "AuthorizationCanceled" | null {
    if (!same(log.address, context.asset)) return null;
    try {
      const decoded = decodeEventLog({
        abi: ABI,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (
        decoded.eventName !== "AuthorizationUsed" &&
        decoded.eventName !== "AuthorizationCanceled"
      )
        return null;
      return same(decoded.args.authorizer, context.payer) && same(decoded.args.nonce, context.nonce)
        ? decoded.eventName
        : null;
    } catch {
      return null;
    }
  }

  private async proof(
    reader: ChainReader,
    context: PaymentRecoveryContext,
    finalized: ChainBlock,
    transaction: string,
  ): Promise<PaymentRecoveryOutcome | null> {
    const receipt = await reader.receipt(transaction);
    if (
      receipt.status !== "success" ||
      !same(receipt.transactionHash, transaction) ||
      receipt.blockNumber > finalized.number ||
      receipt.blockNumber < BigInt(context.fromBlock)
    )
      return null;
    const block = await reader.block(receipt.blockNumber);
    if (!same(block.hash, receipt.blockHash)) return null;
    const authorizations = receipt.logs.filter(
      (log) =>
        !log.removed &&
        same(log.transactionHash, transaction) &&
        same(log.blockHash, block.hash) &&
        log.blockNumber === block.number &&
        this.authorizationEvent(log, context),
    );
    const [authorization] = authorizations;
    if (authorizations.length !== 1 || !authorization) return null;
    if (this.authorizationEvent(authorization, context) === "AuthorizationCanceled") {
      return {
        settled: false,
        reason: "The original payment authorization was canceled on the finalized chain.",
      };
    }
    if (
      block.timestamp <= BigInt(context.validAfter) ||
      block.timestamp >= BigInt(context.validBefore)
    )
      return null;
    const next = receipt.logs[receipt.logs.indexOf(authorization) + 1];
    if (
      !next ||
      next.logIndex !== authorization.logIndex + 1 ||
      next.removed ||
      !same(next.address, context.asset) ||
      !same(next.transactionHash, transaction) ||
      !same(next.blockHash, block.hash) ||
      next.blockNumber !== block.number
    )
      return null;
    try {
      const decoded = decodeEventLog({
        abi: ABI,
        data: next.data as Hex,
        topics: next.topics as [Hex, ...Hex[]],
      });
      if (
        decoded.eventName !== "Transfer" ||
        !same(decoded.args.from, context.payer) ||
        !same(decoded.args.to, context.payTo) ||
        decoded.args.value !== BigInt(context.amount)
      )
        return null;
    } catch {
      return null;
    }
    return { settled: true, transaction, executedAt: Number(block.timestamp) * 1000 };
  }
}

export function recoveryOn(network: string, rpcUrl?: string): Eip3009Recovery | undefined {
  if (!rpcUrl) return undefined;
  return new Eip3009Recovery((savedNetwork) => {
    if (savedNetwork !== network)
      throw new Error("The configured recovery RPC serves a different chain.");
    return defaultReader(savedNetwork, rpcUrl);
  });
}

function defaultReader(network: string, rpcUrl: string): ChainReader {
  const chain = network === "eip155:8453" ? base : baseSepolia;
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 10_000, retryCount: 0 }),
  });
  const stateArgs = (context: RecoveryAuthorization) =>
    [context.payer as Address, context.nonce as Hex] as const;
  return {
    networkId: () => client.getChainId(),
    block: async (number) => {
      const block = await client.getBlock(
        number === undefined ? { blockTag: "finalized" } : { blockNumber: number },
      );
      return { number: block.number, hash: block.hash, timestamp: block.timestamp };
    },
    authorizationState: (context, blockNumber) =>
      client.readContract({
        address: context.asset as Address,
        abi: ABI,
        functionName: "authorizationState",
        args: stateArgs(context),
        blockNumber,
      }),
    authorizationLogs: async (context, fromBlock, toBlock) => {
      const queries = ["AuthorizationUsed", "AuthorizationCanceled"] as const;
      const logs = await Promise.all(
        queries.map((name) =>
          client.getLogs({
            address: context.asset as Address,
            event: ABI.find((entry) => entry.type === "event" && entry.name === name) as Extract<
              (typeof ABI)[number],
              { type: "event"; name: typeof name }
            >,
            args: { authorizer: context.payer as Address, nonce: context.nonce as Hex },
            fromBlock,
            toBlock,
            strict: true,
          }),
        ),
      );
      return logs.flat() as ChainLog[];
    },
    receipt: async (transaction) => client.getTransactionReceipt({ hash: transaction as Hex }),
  };
}
