import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  type Address,
  createPublicClient,
  decodeEventLog,
  formatTransactionReceipt,
  type Hex,
  http,
  numberToHex,
  parseAbi,
  type RpcTransactionReceipt,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import {
  type PaymentRecoveryContext,
  type PaymentRecoveryOutcome,
  type PaymentRecoveryRequest,
  RecoveryFailure,
} from "../../ports/facilitator.js";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "../../split/networks.js";

export type RecoveryAuthorization = Omit<PaymentRecoveryContext, "notBefore">;
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
/**
 * Only reads: this adapter has no transaction submission capability. Log
 * queries are not used, because public endpoints refuse or narrow them.
 */
export interface ChainReader {
  networkId(): Promise<number>;
  /** The finalized block when no number is given. */
  block(number?: bigint): Promise<ChainBlock>;
  authorizationState(context: RecoveryAuthorization, number: bigint): Promise<boolean>;
  blockReceipts(number: bigint): Promise<readonly ChainReceipt[]>;
  receipt(transaction: string): Promise<ChainReceipt>;
}

const ABI = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
/**
 * How many blocks one poll reads. An authorization accepted here is valid for
 * about two minutes, some sixty Base blocks, so one poll usually covers it;
 * a longer one, from an older record, continues on the next poll.
 */
const BLOCKS_PER_POLL = 64n;
const EXPIRED_UNUSED: PaymentRecoveryOutcome = {
  settled: false,
  reason: "The original payment authorization expired unused on the finalized chain.",
};
const NOT_FOUND =
  "The original authorization was used, but no transfer or cancellation of it was found in the blocks where it was valid.";
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
    const { context } = request;
    if (request.nextBlock !== undefined && !uint256(request.nextBlock))
      throw new RecoveryFailure("The saved recovery cursor is not a block number.");
    const reader = await this.reader(context);
    const finalized = await reader.block();
    const used = await reader.authorizationState(context, finalized.number);
    if (!used && finalized.timestamp >= BigInt(context.validBefore)) return EXPIRED_UNUSED;
    if (request.transaction && nonce(request.transaction)) {
      try {
        const proof = await this.hinted(reader, context, finalized, request.transaction);
        if (proof) return proof;
      } catch {
        // A hash that leads nowhere must not prevent finding the original nonce's transaction.
      }
    }
    if (!used)
      return {
        settled: "unknown",
        reason: "The original authorization remains usable or is awaiting finality.",
      };
    return this.search(reader, context, finalized, request.nextBlock);
  }

  /**
   * Reads the receipts of the blocks in which the authorization could execute:
   * from the first one at or after it was known unused, or after its
   * `validAfter`, to the last one before its `validBefore`. The token refuses
   * it outside that window, so nothing outside is read.
   */
  private async search(
    reader: ChainReader,
    context: PaymentRecoveryContext,
    finalized: ChainBlock,
    cursor: string | undefined,
  ): Promise<PaymentRecoveryOutcome> {
    const validBefore = BigInt(context.validBefore);
    let earliest = BigInt(context.notBefore);
    if (BigInt(context.validAfter) + 1n > earliest) earliest = BigInt(context.validAfter) + 1n;
    if (cursor === undefined && finalized.timestamp < earliest)
      return { settled: "unknown", reason: NOT_FOUND };
    let next =
      cursor === undefined ? await firstBlockAt(reader, finalized, earliest) : BigInt(cursor);
    for (let read = 0n; read < BLOCKS_PER_POLL; read += 1n) {
      if (next > finalized.number)
        return { settled: "unknown", reason: NOT_FOUND, nextBlock: next.toString() };
      const block = await reader.block(next);
      if (block.timestamp >= validBefore) {
        // Unused before this block, it can no longer pay: every later block
        // is past its validBefore, and a later cancellation marked it used.
        if (next > 0n && !(await reader.authorizationState(context, next - 1n)))
          return EXPIRED_UNUSED;
        return { settled: "unknown", reason: NOT_FOUND, nextBlock: next.toString() };
      }
      const receipts = (await reader.blockReceipts(next)).filter((receipt) =>
        receipt.logs.some((log) => this.authorizationEvent(log, context) !== null),
      );
      for (const receipt of receipts) {
        const proof = this.proof(context, receipt, block);
        if (proof) return proof;
      }
      if (receipts.length > 0)
        return {
          settled: "unknown",
          reason:
            "The original authorization was found, but its complete finalized receipt could not be verified.",
          nextBlock: next.toString(),
        };
      next += 1n;
    }
    return {
      settled: "unknown",
      reason: "The blocks where the original authorization was valid are still being read.",
      nextBlock: next.toString(),
    };
  }

  private async reader(context: PaymentRecoveryContext): Promise<ChainReader> {
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
      !uint256(context.notBefore) ||
      BigInt(context.validBefore) <= BigInt(context.validAfter)
    ) {
      throw new RecoveryFailure("The saved authorization is not a supported payment profile.");
    }
    const reader = this.readerFor(context.network);
    const answered = await reader.networkId();
    if (answered !== Number(context.network.split(":")[1]))
      throw new RecoveryFailure(
        `The recovery RPC serves chain ${answered}, not the saved payment's ${context.network}.`,
      );
    return reader;
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

  private async hinted(
    reader: ChainReader,
    context: PaymentRecoveryContext,
    finalized: ChainBlock,
    transaction: string,
  ): Promise<PaymentRecoveryOutcome | null> {
    const receipt = await reader.receipt(transaction);
    if (!same(receipt.transactionHash, transaction) || receipt.blockNumber > finalized.number)
      return null;
    return this.proof(context, receipt, await reader.block(receipt.blockNumber));
  }

  /**
   * The receipt's verdict, if it proves this authorization's outcome in the
   * canonical `block`, which the callers have checked is finalized.
   */
  private proof(
    context: PaymentRecoveryContext,
    receipt: ChainReceipt,
    block: ChainBlock,
  ): PaymentRecoveryOutcome | null {
    const transaction = receipt.transactionHash;
    if (
      receipt.status !== "success" ||
      block.number !== receipt.blockNumber ||
      !same(block.hash, receipt.blockHash)
    )
      return null;
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

/**
 * The first block whose time is at or after `time`, which the finalized block
 * has reached. A block's time is at least a second after its parent's, so no
 * block more than `finalized.timestamp - time` below the finalized one can be
 * it; the bisection starts from there.
 */
async function firstBlockAt(reader: ChainReader, finalized: ChainBlock, time: bigint) {
  let low = finalized.number - (finalized.timestamp - time);
  if (low < 0n) low = 0n;
  let high = finalized.number;
  while (low < high) {
    const middle = (low + high) / 2n;
    if ((await reader.block(middle)).timestamp >= time) high = middle;
    else low = middle + 1n;
  }
  return low;
}

/** Whether recovery is on for this channel, and the sentence that tells an operator so. */
export interface RecoveryStart {
  readonly recovery?: Eip3009Recovery;
  readonly said: string;
  /** Whether an RPC was configured and recovery is off anyway. */
  readonly broken: boolean;
}

/**
 * Recovery for the channel's network through `rpcUrl`, once the endpoint has
 * answered that network's chain id. An endpoint that answers another chain, or
 * does not answer, leaves recovery off and says why; verification and
 * settlement through the facilitator never depend on it.
 */
export async function recoveryOn(network: string, rpcUrl?: string): Promise<RecoveryStart> {
  if (!rpcUrl)
    return {
      said: "payment recovery is off because no RPC is configured: a charge whose answer is lost stays unresolved",
      broken: false,
    };
  const reader = defaultReader(network, rpcUrl);
  const host = new URL(rpcUrl).host;
  try {
    const answered = await reader.networkId();
    if (answered !== Number(network.split(":")[1]))
      return {
        said: `payment recovery is off: the RPC at ${host} serves chain ${answered}, not this channel's ${network}`,
        broken: true,
      };
  } catch (thrown) {
    return {
      said: `payment recovery is off: ${thrown instanceof RecoveryFailure ? thrown.message : `the RPC at ${host} could not be asked for its chain`}`,
      broken: true,
    };
  }
  return {
    recovery: new Eip3009Recovery((savedNetwork) => {
      if (savedNetwork !== network)
        throw new RecoveryFailure(
          `The configured recovery RPC serves ${network}, not the saved payment's ${savedNetwork}.`,
        );
      return reader;
    }),
    said: `payment recovery reads ${network} from ${host}`,
    broken: false,
  };
}

function defaultReader(network: string, rpcUrl: string): ChainReader {
  const chain = network === "eip155:8453" ? base : baseSepolia;
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl, { timeout: 10_000, retryCount: 0 }),
  });
  const host = new URL(rpcUrl).host;
  const read = async <T>(method: string, call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (thrown) {
      throw new RecoveryFailure(`${method} at ${host} failed: ${kindOf(thrown)}.`);
    }
  };
  return {
    networkId: () => read("eth_chainId", () => client.getChainId()),
    block: (number) =>
      read("eth_getBlockByNumber", async () => {
        const block = await client.getBlock(
          number === undefined ? { blockTag: "finalized" } : { blockNumber: number },
        );
        return { number: block.number, hash: block.hash, timestamp: block.timestamp };
      }),
    authorizationState: (context, blockNumber) =>
      read("eth_call", () =>
        client.readContract({
          address: context.asset as Address,
          abi: ABI,
          functionName: "authorizationState",
          args: [context.payer as Address, context.nonce as Hex],
          blockNumber,
        }),
      ),
    blockReceipts: (number) =>
      read("eth_getBlockReceipts", async () => {
        // viem has no action for this call, so it is sent and formatted by hand.
        const receipts = (await client.request({
          method: "eth_getBlockReceipts",
          params: [numberToHex(number)],
        } as never)) as RpcTransactionReceipt[] | null;
        if (!Array.isArray(receipts)) throw new Error("no receipts");
        return receipts.map((receipt) => formatTransactionReceipt(receipt));
      }),
    receipt: (transaction) =>
      read("eth_getTransactionReceipt", () =>
        client.getTransactionReceipt({ hash: transaction as Hex }),
      ),
  };
}

/**
 * What kind of failure a read met, from names and numbers alone: an error's
 * message can carry the endpoint's whole address.
 */
function kindOf(thrown: unknown): string {
  const words: string[] = [];
  let at: unknown = thrown;
  for (let depth = 0; depth < 4 && typeof at === "object" && at !== null; depth += 1) {
    const { name, status, code, cause } = at as {
      name?: unknown;
      status?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    if (typeof name === "string" && /^[A-Z][A-Za-z]{0,63}$/.test(name)) words.push(name);
    if (typeof status === "number") words.push(`HTTP ${status}`);
    if (typeof code === "number") words.push(`RPC code ${code}`);
    at = cause;
  }
  return words.length === 0 ? "an unnamed failure" : [...new Set(words)].join(", ");
}
