/** TEST-only payout observation. Inspect is read-only; execute reserves gas before signing. */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { PAYOUT_SPLIT_NETWORKS } from "../../../../apps/gateway/src/split/networks.js";
import { type PayoutSplit, payoutSplitFor } from "../../../../apps/gateway/src/split/parameters.js";
import { merchantPayout } from "../../../../apps/gateway/src/split/payout.js";
import {
  type Ledger,
  play,
  type UsdcTransfer,
} from "../../../../packages/slice/src/split-ledger.js";

const require = createRequire(new URL("../../package.json", import.meta.url));
const viem = require("viem");
const { createPublicClient, createWalletClient, getAddress, http, parseAbi, parseEventLogs } = viem;
const { privateKeyToAccount } = require("viem/accounts");
const { baseSepolia } = require("viem/chains");
const { estimateL1Fee } = require("viem/op-stack");

const RPC = "https://sepolia.base.org";
const CHAIN = 84532;
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const CAP = 500_000_000_000_000n;
const local = fileURLToPath(new URL("../../../../.local/fuzz-campaign/", import.meta.url));
const budgetPath = `${local}/payout-budget.json`;
const evidencePath = fileURLToPath(
  new URL(
    "../../../../docs/research/fuzz-campaign-2026-10-15/payout-evidence.json",
    import.meta.url,
  ),
);
const network = PAYOUT_SPLIT_NETWORKS["eip155:84532"];
type Target = "sdk" | "woo";
type Hex = `0x${string}`;
type State = "reserved" | "sent" | "reverted" | "verified" | "inconclusive";
type Reservation = {
  id: string;
  target: Target;
  signer: string;
  reservedWei: string;
  state: State;
  at: string;
  hash?: Hex;
  observation: Record<string, unknown>;
};
type Budget = { chain: 84532; capWei: string; reservations: Reservation[] };
type Snapshot = { block: bigint; ledger: Ledger; eth: bigint };
type Log = { address: string; transactionHash: string | null };
type Receipt = {
  transactionHash: Hex;
  from: string;
  to: string | null;
  blockNumber: bigint;
  blockHash: Hex;
  status: string;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  l1Fee?: bigint;
  logs: readonly unknown[];
};

class GuardError extends Error {}
function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new GuardError(reason);
}
const json = (value: unknown) =>
  `${JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item), 2)}\n`;
const object = (value: unknown): Record<string, unknown> => {
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Invalid fixture shape",
  );
  return value as Record<string, unknown>;
};
function fixture(target: Target): PayoutSplit {
  // Extract public fields only. Fixture files also contain API credentials.
  const input = object(JSON.parse(readFileSync(`${local}/${target}-merchant.json`, "utf8")));
  const recorded = object(input.split);
  check(typeof input.merchantId === "string", "Fixture merchant ID is missing");
  check(typeof recorded.merchantWallet === "string", "Fixture merchant wallet is missing");
  const canonical = payoutSplitFor(network, input.merchantId, recorded.merchantWallet);
  for (const [key, value] of Object.entries(canonical)) {
    const actual = recorded[key];
    check(
      typeof value === "string" && value.startsWith("0x")
        ? typeof actual === "string" && actual.toLowerCase() === value.toLowerCase()
        : actual === value,
      "Fixture split differs from the repository's TEST payout parameters",
    );
  }
  merchantPayout(network, [canonical], PAYOUT_SPLIT_NETWORKS);
  return canonical;
}
function durable(path: string, value: unknown, directory: string) {
  const temp = `${path}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeFileSync(fd, json(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const dir = openSync(directory, "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
function loadBudget(): Budget {
  if (!existsSync(budgetPath)) return { chain: CHAIN, capWei: CAP.toString(), reservations: [] };
  const value = object(JSON.parse(readFileSync(budgetPath, "utf8")));
  check(value.chain === CHAIN && value.capWei === CAP.toString(), "Persistent payout cap changed");
  check(
    Array.isArray(value.reservations) && value.reservations.length <= 2,
    "Invalid payout ledger",
  );
  const seen = new Set<string>();
  for (const item of value.reservations) {
    const row = object(item);
    check(typeof row.id === "string" && !seen.has(row.id), "Duplicate split reservation");
    check(row.target === "sdk" || row.target === "woo", "Invalid payout target");
    check(
      typeof row.signer === "string" && /^0x[\da-fA-F]{40}$/.test(row.signer),
      "Invalid signer",
    );
    check(
      typeof row.reservedWei === "string" && /^\d+$/.test(row.reservedWei),
      "Invalid gas reservation",
    );
    check(
      BigInt(row.reservedWei) > 0n && BigInt(row.reservedWei) <= CAP,
      "Invalid gas reservation",
    );
    check(
      ["reserved", "sent", "reverted", "verified", "inconclusive"].includes(String(row.state)),
      "Invalid payout state",
    );
    seen.add(row.id);
  }
  const budget = value as unknown as Budget;
  check(reservedTotal(budget) <= CAP, "Persistent aggregate gas cap exceeded");
  return budget;
}
const reservedTotal = (budget: Budget) =>
  budget.reservations.reduce((total, row) => total + BigInt(row.reservedWei), 0n);
const BALANCE = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
const CREDIT = parseAbi(["function balanceOf(address owner, uint256 id) view returns (uint256)"]);
const TRANSFER = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
let requests = 0;
const transport = () =>
  http(RPC, {
    retryCount: 0,
    timeout: 20_000,
    fetchOptions: { redirect: "error" },
    onFetchRequest: () => check(++requests <= 2000, "Payout RPC request cap reached"),
  });
const client = createPublicClient({ chain: baseSepolia, transport: transport() });
async function snapshot(split: PayoutSplit, block?: bigint): Promise<Snapshot> {
  const at = block ?? BigInt(await client.getBlockNumber({ cacheTime: 0 }));
  const parties: string[] = [
    ...new Set([
      split.address,
      split.merchantWallet,
      split.commissionWallet,
      getAddress(network.warehouse),
    ]),
  ];
  const answers = await client.multicall({
    allowFailure: false,
    blockNumber: at,
    contracts: [
      ...parties.map((party) => ({
        address: USDC_ADDRESS,
        abi: BALANCE,
        functionName: "balanceOf",
        args: [party],
      })),
      ...parties.map((party) => ({
        address: getAddress(network.warehouse),
        abi: CREDIT,
        functionName: "balanceOf",
        args: [party, BigInt(USDC_ADDRESS)],
      })),
    ],
  });
  const column = (offset: number) =>
    Object.fromEntries(parties.map((party, index) => [party, BigInt(answers[offset + index])]));
  return {
    block: at,
    ledger: { held: column(0), credited: column(parties.length) },
    eth: BigInt(await client.getBalance({ address: split.merchantWallet, blockNumber: at })),
  };
}
function expected(before: Snapshot, split: PayoutSplit) {
  const result = play(before.ledger, network.warehouse, [
    {
      kind: "distribute",
      split: {
        address: split.address,
        recipients: [split.merchantWallet, split.commissionWallet],
        allocations: [split.merchantAllocation, split.commissionAllocation],
        totalAllocation: split.totalAllocation,
      },
    },
    { kind: "withdraw", owner: split.merchantWallet },
  ]);
  const warehouse = getAddress(network.warehouse);
  const held = { ...result.ledger.held };
  for (const transfer of result.transfers) {
    if (transfer.from === warehouse) held[warehouse] -= transfer.value;
    if (transfer.to === warehouse) held[warehouse] += transfer.value;
  }
  return { ...result, ledger: { ...result.ledger, held } };
}
function deltas(before: Ledger, after: Ledger) {
  return Object.fromEntries(
    (["held", "credited"] as const).map((kind) => [
      kind,
      Object.fromEntries(
        Object.keys(before[kind]).map((party) => [party, after[kind][party] - before[kind][party]]),
      ),
    ]),
  );
}
function restoreBefore(value: unknown, split: PayoutSplit): Snapshot {
  const input = object(value);
  const integer = (value: unknown) => {
    check(
      (typeof value === "bigint" && value >= 0n) ||
        (typeof value === "string" && /^\d+$/.test(value)),
      "Stored payout observation contains an invalid unsigned integer",
    );
    return BigInt(value);
  };
  const parties = [
    split.address,
    split.merchantWallet,
    split.commissionWallet,
    getAddress(network.warehouse),
  ];
  const ledger = object(input.ledger);
  const amounts = (value: unknown) => {
    const recorded = object(value);
    check(
      Object.keys(recorded).length === parties.length &&
        parties.every((party) => Object.hasOwn(recorded, party)),
      "Stored payout observation has different tracked addresses",
    );
    return Object.fromEntries(parties.map((party) => [party, integer(recorded[party])]));
  };
  return {
    block: integer(input.block),
    eth: integer(input.eth),
    ledger: { held: amounts(ledger.held), credited: amounts(ledger.credited) },
  };
}
function receiptObservation(receipt: Receipt) {
  return {
    hash: receipt.transactionHash,
    from: receipt.from,
    to: receipt.to,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    l1Fee: receipt.l1Fee ?? null,
    paidWei:
      typeof receipt.l1Fee === "bigint"
        ? receipt.gasUsed * receipt.effectiveGasPrice + receipt.l1Fee
        : null,
  };
}
async function confirmedReceipt(hash: Hex, initial: (receipt: Receipt) => void) {
  const started = Date.now();
  const deadline = started + 60_000;
  let attempts = 0;
  let observed = false;
  const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    check(remaining > 0, "Canonical payout receipt did not become available within 60 seconds");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new GuardError(
                  "Canonical payout receipt did not become available within 60 seconds",
                ),
              ),
            remaining,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const receipt = await bounded<Receipt>(() => client.getTransactionReceipt({ hash }));
      if (!observed) {
        initial(receipt);
        observed = true;
      }
      if (/^0x[\da-fA-F]{64}$/.test(receipt.blockHash) && !/^0x0+$/.test(receipt.blockHash)) {
        const block = await bounded<{ hash: Hex | null }>(() =>
          client.getBlock({ blockNumber: receipt.blockNumber }),
        );
        const head = await bounded<bigint>(() => client.getBlockNumber({ cacheTime: 0 }));
        if (block.hash === receipt.blockHash && head >= receipt.blockNumber + 1n) {
          return { receipt, attempts, elapsedMs: Date.now() - started };
        }
      }
    } catch (error: unknown) {
      if (error instanceof GuardError) throw error;
      // Not mined and transient read failures are retried only within the same fixed deadline.
    }
    const remaining = deadline - Date.now();
    if (remaining > 0)
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, remaining)));
  }
  throw new GuardError("Canonical payout receipt did not become available within 60 seconds");
}
async function verifyReservation(row: Reservation, split: PayoutSplit, persist: () => void) {
  check(
    typeof row.hash === "string" && /^0x[\da-fA-F]{64}$/.test(row.hash),
    "Reservation has no transaction hash; verification cannot send or recover an unknown broadcast",
  );
  check(
    row.id === `${CHAIN}:${split.address.toLowerCase()}` &&
      getAddress(row.signer) === split.merchantWallet,
    "Reservation does not match the selected merchant split",
  );
  const tx = merchantPayout(network, [split], PAYOUT_SPLIT_NETWORKS);
  check(
    row.observation.to === tx.to &&
      row.observation.value === "0" &&
      row.observation.calldataSha256 === createHash("sha256").update(tx.data).digest("hex"),
    "Stored transaction differs from the repository payout",
  );
  const before = restoreBefore(row.observation.before, split);
  const model = expected(before, split);
  check(
    json(row.observation.expectedDeltas) === json(deltas(before.ledger, model.ledger)) &&
      json(row.observation.expectedTransfers) === json(model.transfers),
    "Stored payout prediction differs from the rehydrated ledger model",
  );
  row.observation.initialReceipt ??= row.observation.receipt;
  row.state = "inconclusive";
  persist();
  const confirmed = await confirmedReceipt(row.hash, (receipt) => {
    row.observation.initialReceipt ??= receiptObservation(receipt);
    persist();
  });
  const { receipt } = confirmed;
  row.observation.receipt = receiptObservation(receipt);
  row.observation.canonicalReceiptWait = {
    attempts: confirmed.attempts,
    elapsedMs: confirmed.elapsedMs,
    checkedAt: new Date().toISOString(),
  };
  if (receipt.status !== "success") {
    row.state = "reverted";
    persist();
    throw new GuardError("Payout reverted; execution reservation retained");
  }
  persist();
  check(
    typeof receipt.l1Fee === "bigint",
    "Receipt omits L1 fee; actual gas cost remains inconclusive",
  );
  const paid = receipt.gasUsed * receipt.effectiveGasPrice + receipt.l1Fee;
  const reserved = BigInt(row.reservedWei);
  check(paid <= reserved, "Actual gas fee exceeds reserved ceiling; stop for review");
  check(
    receipt.transactionHash === row.hash &&
      getAddress(receipt.from) === getAddress(row.signer) &&
      getAddress(receipt.to) === getAddress(tx.to),
    "Receipt does not bind to the reserved merchant transaction",
  );
  const afterBlock = receipt.blockNumber;
  check(
    afterBlock > before.block && afterBlock - before.block <= 256n,
    "Payout observation window exceeds its block bound",
  );
  const after = await snapshot(split, afterBlock);
  const canonicalBlock = await client.getBlock({ blockNumber: afterBlock });
  check(canonicalBlock.hash === receipt.blockHash, "Receipt block changed during verification");
  const transfers: UsdcTransfer[] = parseEventLogs({
    abi: TRANSFER,
    logs: receipt.logs,
    strict: true,
  })
    .filter((log: Log) => getAddress(log.address) === USDC_ADDRESS)
    .map((log: { args: UsdcTransfer }) => ({
      from: getAddress(log.args.from),
      to: getAddress(log.args.to),
      value: BigInt(log.args.value),
    }));
  const activity: Log[] = await client.getLogs({
    address: [getAddress(network.warehouse), USDC_ADDRESS],
    fromBlock: before.block + 1n,
    toBlock: afterBlock,
  });
  const tracked = new Set(Object.keys(before.ledger.held).map((address) => address.toLowerCase()));
  const externalWarehouseActivity = activity.some(
    (log) =>
      getAddress(log.address) === getAddress(network.warehouse) && log.transactionHash !== row.hash,
  );
  const externalTransfers = parseEventLogs({ abi: TRANSFER, logs: activity, strict: true }).filter(
    (log: Log & { args: UsdcTransfer }) =>
      log.transactionHash !== row.hash &&
      (tracked.has(log.args.from.toLowerCase()) || tracked.has(log.args.to.toLowerCase())),
  );
  row.observation.after = after;
  row.observation.actualDeltas = deltas(before.ledger, after.ledger);
  row.observation.actualTransfers = transfers;
  row.observation.externalWarehouseActivity = externalWarehouseActivity;
  row.observation.externalTrackedTransfers = externalTransfers.length;
  persist();
  check(
    !externalWarehouseActivity && externalTransfers.length === 0,
    "Concurrent tracked activity makes exact payout attribution inconclusive",
  );
  check(
    json(transfers) === json(model.transfers),
    "Payout token transfers differ from the independent ledger model",
  );
  check(
    json(after.ledger) === json(model.ledger),
    "Payout balances or warehouse credits differ from the independent ledger model",
  );
  row.state = "verified";
  persist();
  console.log(
    json({
      target: row.target,
      state: row.state,
      hash: row.hash,
      reservedWei: reserved,
      actualFeeWei: paid,
      exactTokenDeltas: row.observation.actualDeltas,
    }),
  );
}
async function main() {
  const mode = process.argv[2] ?? "inspect";
  const target = process.argv[3] ?? "all";
  check(
    ["inspect", "execute", "verify"].includes(mode),
    "Use inspect|execute|verify and sdk|woo|all",
  );
  check(["sdk", "woo", "all"].includes(target), "Use inspect|execute|verify and sdk|woo|all");
  check(process.argv.length <= 4, "Unexpected payout arguments");
  check(
    network.network === "eip155:84532" && network.usdc === USDC_ADDRESS,
    "TEST constants changed",
  );
  check(
    baseSepolia.id === CHAIN && (await client.getChainId()) === CHAIN,
    "RPC is not Base Sepolia",
  );
  const targets: Target[] = target === "all" ? ["sdk", "woo"] : [target as Target];
  const splits = targets.map((name) => ({ name, split: fixture(name) }));
  check(
    new Set(splits.map(({ split }) => split.address)).size === splits.length,
    "Fixtures reuse a split",
  );
  if (mode === "inspect") {
    const observations = [];
    for (const { name, split } of splits)
      observations.push({ target: name, split, snapshot: await snapshot(split) });
    console.log(
      json({
        mode,
        chain: CHAIN,
        rpc: RPC,
        usdcAddress: USDC_ADDRESS,
        gasCapWei: CAP,
        observations,
        requests,
      }),
    );
    return;
  }
  mkdirSync(local, { recursive: true, mode: 0o700 });
  const lock = `${local}/payout.lock`;
  const lockFd = openSync(lock, "wx", 0o600);
  try {
    const budget = loadBudget();
    const persist = () => {
      durable(budgetPath, budget, local);
      durable(
        evidencePath,
        {
          chain: CHAIN,
          rpc: RPC,
          usdcAddress: USDC_ADDRESS,
          capWei: CAP,
          requests,
          reservations: budget.reservations,
        },
        fileURLToPath(
          new URL("../../../../docs/research/fuzz-campaign-2026-10-15/", import.meta.url),
        ),
      );
    };
    if (mode === "verify") {
      for (const { name, split } of splits) {
        const row = budget.reservations.find(
          (row) => row.target === name && row.id === `${CHAIN}:${split.address.toLowerCase()}`,
        );
        check(
          row !== undefined,
          "No existing reservation for the selected merchant; verify never sends",
        );
        await verifyReservation(row, split, persist);
      }
      return;
    }
    const key = process.env.FUZZ_MERCHANT_KEY;
    check(
      typeof key === "string" && /^0x[\da-fA-F]{64}$/.test(key),
      "FUZZ_MERCHANT_KEY must be supplied in the environment",
    );
    const account = privateKeyToAccount(key);
    for (const { split } of splits)
      check(
        account.address === split.merchantWallet,
        "Signer differs from the fixture merchant wallet",
      );
    const wallet = createWalletClient({ account, chain: baseSepolia, transport: transport() });
    for (const { name, split } of splits) {
      const id = `${CHAIN}:${split.address.toLowerCase()}`;
      check(
        !budget.reservations.some((row) => row.id === id),
        "This split already has a durable execution reservation; automatic retry refused",
      );
      const tx = merchantPayout(network, [split], PAYOUT_SPLIT_NETWORKS);
      check(
        tx.value === 0n && getAddress(tx.to) === getAddress(network.multicall3),
        "Payout target or value changed",
      );
      const request = { account, to: getAddress(tx.to), data: tx.data, value: 0n };
      const estimated = BigInt(await client.estimateGas(request));
      const fees = await client.estimateFeesPerGas();
      const maxFeePerGas = BigInt(fees.maxFeePerGas);
      const maxPriorityFeePerGas = BigInt(fees.maxPriorityFeePerGas);
      const l1Fee = BigInt(await estimateL1Fee(client, { ...request, chain: baseSepolia }));
      const gas = (estimated * 5n + 3n) / 4n;
      const reserved = gas * maxFeePerGas + 2n * l1Fee;
      check(
        reserved > 0n && reservedTotal(budget) + reserved <= CAP,
        "Aggregate payout gas reservation exceeds 0.0005 test ETH",
      );
      const before = await snapshot(split);
      const model = expected(before, split);
      check(
        model.transfers.some((move) => move.to === split.merchantWallet && move.value > 0n),
        "No positive merchant payout is available",
      );
      const unresolved = budget.reservations
        .filter(
          (row) =>
            row.signer === account.address &&
            ["reserved", "sent", "inconclusive"].includes(row.state),
        )
        .reduce((total, row) => total + BigInt(row.reservedWei), 0n);
      check(
        (reserved + unresolved) * 110n <= before.eth * 100n,
        "Insufficient merchant test ETH with 10 percent gas safety margin",
      );
      const row: Reservation = {
        id,
        target: name,
        signer: account.address,
        reservedWei: reserved.toString(),
        state: "reserved",
        at: new Date().toISOString(),
        observation: {
          before,
          expectedDeltas: deltas(before.ledger, model.ledger),
          expectedTransfers: model.transfers,
          gas,
          maxFeePerGas,
          maxPriorityFeePerGas,
          l1Fee,
          to: tx.to,
          value: "0",
          calldataSha256: createHash("sha256").update(tx.data).digest("hex"),
        },
      };
      budget.reservations.push(row);
      persist();
      // Nothing which signs or sends happens until both reservation files are durable.
      row.hash = await wallet.sendTransaction({
        ...request,
        gas,
        maxFeePerGas,
        maxPriorityFeePerGas,
        chain: baseSepolia,
      });
      row.state = "sent";
      persist();
      await verifyReservation(row, split, persist);
    }
  } finally {
    closeSync(lockFd);
    unlinkSync(lock);
  }
}
main().catch((error: unknown) => {
  // RPC errors may carry raw signed transactions; never print them or fixture parse errors.
  console.error(
    json({
      error:
        error instanceof GuardError
          ? error.message
          : "Payout operation failed; retained reservations require review",
      broadcastRetried: false,
    }),
  );
  process.exitCode = 1;
});
