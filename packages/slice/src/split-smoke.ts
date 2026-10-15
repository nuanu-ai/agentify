/**
 * The payout split smoke: a test merchant's split on Base Sepolia, paid twice
 * through a real gateway in this process and the x402.org facilitator, and
 * paid out with the very transactions the payout screen and the operator's
 * command build. It never runs from `pnpm test`, refuses every chain but Base
 * Sepolia (eip155:84532), and stops before anything is signed unless told
 * `--confirm`.
 *
 *   AGENTIFY_SMOKE=1 SMOKE_BUYER_KEY=0x… SMOKE_PAYOUT_KEY=0x… pnpm smoke:split
 *   AGENTIFY_SMOKE=1 SMOKE_BUYER_KEY=0x… SMOKE_PAYOUT_KEY=0x… pnpm smoke:split --confirm
 *
 * The buyer's key holds test USDC. The payout key holds test ETH, sends the
 * payouts, and its address is the test merchant's wallet, so it pays out its
 * own share the way a merchant would. SMOKE_PRICE_USD (0.01) is each payment,
 * SMOKE_MAX_USD (0.05) the most the run pays in all, SMOKE_MAX_GAS_ETH
 * (0.0005) the most it spends on gas, which the payout key must hold before
 * anything is paid, and BASE_SEPOLIA_RPC_URL (https://sepolia.base.org) where
 * it reads and sends. The keys are never printed.
 *
 * Every run is a new merchant, so its split is new. Before the first payment
 * the split's every parameter and both payout transactions are appended to
 * `split-smoke.jsonl` in the directory the command runs in (`packages/slice`
 * under pnpm), and each step's transaction is appended as it lands: whatever a
 * run leaves in a split can be paid out from there by anyone.
 *
 * Predictions, written before the first run, for a price of p units of USDC
 * (10000 at $0.01) and the rate in the code, 1000 of 1000000; the merchant
 * wallet is credited nothing in the warehouse before the run, and the
 * commission wallet c (the experiment left it 1):
 *
 *   0. The chain answers 84532; the commission wallet, the factory, the
 *      implementation, the warehouse, Multicall3 and USDC read as the
 *      pre-release check reads them; the registry's split for the merchant is
 *      the one the code computes, and the challenge asks p units of USDC at it.
 *   1. The split has no code; the first payment settles, and its one USDC
 *      transfer is the buyer's p to the split.
 *   2. The payout screen's transaction creates the split (one SplitCreated with
 *      the journal's parameters), distributes p - 1 and withdraws the
 *      merchant's share: credited floor((p - 1) × 999000 / 1000000) = 9989, it
 *      receives 9988; Agentify is credited floor((p - 1) × 1000 / 1000000) = 9.
 *      One unit stays on the split, the rounding's one unit in its credit, and
 *      one in the merchant's.
 *   3. A second payment of p settles to the created split.
 *   4. The same transaction creates nothing and distributes exactly p: the
 *      merchant receives 9990, Agentify is credited 10.
 *   5. The operator's transaction for this split distributes 0, pays the
 *      merchant a transfer of 0 and the commission wallet c + 9 + 10 - 1; one
 *      unit stays credited to each, four one-unit residues in all.
 *   6. At every transaction's block each party's USDC, held and credited, is
 *      the predicted amount, and the transaction's USDC transfers are exactly
 *      the predicted ones, between the buyer, the split, the warehouse, the
 *      merchant wallet and the commission wallet and nobody else.
 *
 * Decision rule: any difference fails the run at its step, printing the
 * prediction and what the chain showed; the run sends nothing after it. Gas
 * used is printed and not predicted.
 */

import path from "node:path";
import { PUBLIC_X402_FACILITATOR_URL } from "@agentify/core";
import {
  issueKey,
  merchantPayout,
  operatorPayouts,
  PAYOUT_SPLIT_NETWORKS,
  type PayoutSplit,
  type PayoutSplitNetwork,
  type PayoutTransaction,
  payoutSplitFor,
  payoutSplitNetworkOf,
  randomIds,
  setPayoutWallet,
  systemClock,
} from "@agentify/gateway";
import type { Card } from "@nuanu-ai/agentify-contracts";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  getAddress,
  type Hex,
  http,
  parseAbi,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { estimateL1Fee } from "viem/op-stack";
import { makeBuyer } from "./buyer.js";
import { EUROPE_ESIM } from "./cards.js";
import { commissionWalletVerdicts } from "./commission-wallet.js";
import { bootGateway, sliceEnv } from "./gateway-harness.js";
import { startMerchant } from "./merchant.js";
import { realFacilitator, verdictOnPurchase } from "./smoke.js";
import type { Ledger } from "./split-ledger.js";
import {
  type Cost,
  runSplitSmoke,
  SMOKE_NETWORK,
  SmokeStopped,
  type SmokeWorld,
  smokeSettings,
  whyNotBaseSepolia,
} from "./split-smoke-run.js";

const say = (line: string): void => {
  console.log(`[smoke:split] ${line}`);
};

const USDC_BALANCE = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
const WAREHOUSE_BALANCE = parseAbi([
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
]);

const EVENTS = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event SplitCreated(address indexed split, (address[] recipients, uint256[] allocations, uint256 totalAllocation, uint16 distributionIncentive) splitParams, address owner, address creator, bytes32 salt)",
  "event SplitDistributed(address indexed token, address indexed distributor, uint256 amount)",
]);

/** Retries a read a public RPC may answer from a node a block behind. */
async function patiently<T>(reading: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await reading();
    } catch (thrown) {
      if (attempt === 10) {
        throw thrown;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

const sameSplit = (a: PayoutSplit, b: PayoutSplit): boolean =>
  (Object.keys(b) as (keyof PayoutSplit)[]).every((field) => a[field] === b[field]);

/** Base Sepolia through the RPC, and the gateway this process runs, as the run sees them. */
function baseSepoliaWorld(options: {
  readonly rpcUrl: string;
  readonly payoutKey: Hex;
  readonly network: PayoutSplitNetwork;
  readonly split: PayoutSplit;
  readonly buyer: string;
  readonly payment: () => Promise<Hex>;
  readonly instruction: () => Promise<PayoutTransaction>;
  readonly operator: () => Promise<PayoutTransaction>;
}): SmokeWorld {
  const { network, split } = options;
  const client = createPublicClient({ chain: baseSepolia, transport: http(options.rpcUrl) });
  const account = privateKeyToAccount(options.payoutKey);
  const wallet = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(options.rpcUrl),
  });
  const usdc = getAddress(network.usdc);
  const parties = [
    getAddress(options.buyer),
    getAddress(split.address),
    getAddress(split.merchantWallet),
    getAddress(split.commissionWallet),
  ];

  return {
    chainId: () => client.getChainId(),
    observe: async (at) => {
      const blockNumber = at === "latest" ? await client.getBlockNumber() : at;
      return patiently(async () => {
        const answers = await client.multicall({
          allowFailure: false,
          blockNumber,
          contracts: [
            ...parties.map(
              (party) =>
                ({
                  address: usdc,
                  abi: USDC_BALANCE,
                  functionName: "balanceOf",
                  args: [party],
                }) as const,
            ),
            ...parties.map(
              (party) =>
                ({
                  address: getAddress(network.warehouse),
                  abi: WAREHOUSE_BALANCE,
                  functionName: "balanceOf",
                  args: [party, BigInt(usdc)],
                }) as const,
            ),
          ],
        });
        const code = await client.getCode({ address: getAddress(split.address), blockNumber });
        const column = (from: number): Ledger["held"] =>
          Object.fromEntries(parties.map((party, at) => [party, answers[from + at] as bigint]));
        return {
          block: blockNumber,
          ledger: { held: column(0), credited: column(parties.length) },
          splitCode: code,
        };
      });
    },
    payoutKeyBalance: () => client.getBalance({ address: account.address }),
    instruction: options.instruction,
    operatorPayout: options.operator,
    pay: options.payment,
    costOf: async (transaction): Promise<Cost> => {
      const request = {
        account,
        to: getAddress(transaction.to),
        data: transaction.data,
        value: 0n,
      } as const;
      const estimated = await client.estimateGas(request);
      const fees = await client.estimateFeesPerGas();
      const l1Fee = await estimateL1Fee(client, { ...request, chain: baseSepolia });
      // A payout given too little gas reverts whole: Multicall3 still has to
      // return its results after the last call, which costs more than the
      // gas a failing call leaves behind. The quarter more only covers state
      // that moves between the estimate and the block.
      return {
        gas: (estimated * 5n) / 4n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        l1Fee,
      };
    },
    send: (transaction, cost) =>
      wallet.sendTransaction({
        to: getAddress(transaction.to),
        data: transaction.data,
        value: 0n,
        gas: cost.gas,
        maxFeePerGas: cost.maxFeePerGas,
        maxPriorityFeePerGas: cost.maxPriorityFeePerGas,
      }),
    mined: async (hash) => {
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
      const logs = parseEventLogs({ abi: EVENTS, logs: receipt.logs });
      const from = (address: string) => (log: { address: string }) =>
        getAddress(log.address) === getAddress(address);
      return {
        hash,
        block: receipt.blockNumber,
        succeeded: receipt.status === "success",
        gasUsed: receipt.gasUsed,
        paid: receipt.gasUsed * receipt.effectiveGasPrice + (receipt.l1Fee ?? 0n),
        transfers: logs
          .filter((log) => log.eventName === "Transfer")
          .filter(from(usdc))
          .map((log) => ({
            from: getAddress(log.args.from),
            to: getAddress(log.args.to),
            value: log.args.value,
          })),
        created: logs
          .filter((log) => log.eventName === "SplitCreated")
          .filter(from(network.factory))
          .map((log) => ({
            split: getAddress(log.args.split),
            recipients: log.args.splitParams.recipients.map((recipient) => getAddress(recipient)),
            allocations: log.args.splitParams.allocations,
            totalAllocation: log.args.splitParams.totalAllocation,
            distributionIncentive: log.args.splitParams.distributionIncentive,
            owner: getAddress(log.args.owner),
            salt: log.args.salt,
          })),
        distributed: logs
          .filter((log) => log.eventName === "SplitDistributed")
          .filter(from(split.address))
          .map((log) => log.args.amount),
      };
    },
  };
}

async function main(): Promise<void> {
  const settings = smokeSettings(process.env, process.argv.slice(2));
  const network = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, SMOKE_NETWORK);
  // No chain is named to the client, so the chain it reaches is what it is
  // asked rather than what it is told.
  const client = createPublicClient({ transport: http(settings.rpcUrl) });

  const whyNot = whyNotBaseSepolia(await client.getChainId());
  if (whyNot !== null) {
    throw new SmokeStopped("the chain", whyNot);
  }
  const verdicts = await commissionWalletVerdicts({
    networks: [SMOKE_NETWORK],
    chainsRead: [SMOKE_NETWORK],
    table: PAYOUT_SPLIT_NETWORKS,
    clientOf: () => client,
    owners: {},
  });
  for (const verdict of verdicts) {
    say(`${verdict.passed ? "PASS" : "FAIL"} ${verdict.check}: ${verdict.saw}`);
  }
  if (verdicts.some((verdict) => !verdict.passed)) {
    throw new SmokeStopped("the chain", "the network does not read as the code names it");
  }

  const buyer = privateKeyToAccount(settings.buyerKey).address;
  const merchantWallet = privateKeyToAccount(settings.payoutKey).address;
  const priceUsd = formatUnits(settings.price, 6);
  const booted = await bootGateway(
    realFacilitator,
    sliceEnv({ PAYMENT_NETWORK: SMOKE_NETWORK, FACILITATOR_URL: PUBLIC_X402_FACILITATOR_URL }),
  );
  try {
    const { store } = booted.gateway.runtime;
    const now = systemClock();
    const merchantId = randomIds("mch");
    await store.addMerchant({ id: merchantId, name: "the split smoke's test merchant" }, now);
    await store.setServiceName(merchantId, "Agentify split smoke", now);
    await setPayoutWallet(store, booted.config.payoutSplit, merchantId, merchantWallet, now);
    const { secret } = await issueKey(
      store,
      randomIds,
      merchantId,
      "the split smoke",
      now,
      booted.config.environment,
    );

    const { inForce } = await booted.gateway.payoutSplitsOf(merchantId);
    const computed = payoutSplitFor(network, merchantId, merchantWallet);
    if (inForce === null || !sameSplit(inForce, computed)) {
      throw new SmokeStopped(
        "the plan",
        `the registry recorded ${JSON.stringify(inForce)} for ${merchantId}, and the code computes ${JSON.stringify(computed)}`,
      );
    }

    const merchant = startMerchant(booted.baseUrl, secret);
    await merchant.start();
    try {
      const card: Card = { ...EUROPE_ESIM, price: { amount: priceUsd, currency: "USD" } };
      const published = await merchant.client.catalog.publish(card);
      if (!published.ok) {
        throw new SmokeStopped(
          "the plan",
          `the gateway refused the smoke's card (${published.error.code}): ${JSON.stringify(published.error.problems)}`,
        );
      }
      const shopper = makeBuyer({
        baseUrl: booted.baseUrl,
        privateKey: settings.buyerKey,
        maxUsd: Number(priceUsd),
      });
      const listing = (await shopper.catalog()).find((one) => one.title === card.title);
      if (listing === undefined) {
        throw new SmokeStopped(
          "the plan",
          "the smoke's card is not in the catalog it was published to",
        );
      }
      const [asked] = (await shopper.challenge(listing.id)).accepts;
      if (
        asked === undefined ||
        asked.network !== SMOKE_NETWORK ||
        getAddress(asked.payTo) !== getAddress(computed.address) ||
        getAddress(asked.asset) !== getAddress(network.usdc) ||
        asked.amount !== settings.price.toString()
      ) {
        throw new SmokeStopped(
          "the plan",
          `the challenge asks ${JSON.stringify(asked)}, and ${settings.price} units of ${network.usdc} at ${computed.address} on ${SMOKE_NETWORK} was predicted`,
        );
      }
      say(`gateway ${booted.baseUrl} in this process, facilitator ${PUBLIC_X402_FACILITATOR_URL}`);
      say(`buyer ${buyer}; test merchant ${merchantId}, paid at ${merchantWallet}`);
      say(`challenge: ${asked.amount} units of USDC to ${asked.payTo}, the merchant's split`);

      await runSplitSmoke({
        world: baseSepoliaWorld({
          rpcUrl: settings.rpcUrl,
          payoutKey: settings.payoutKey,
          network,
          split: inForce,
          buyer,
          payment: async () => {
            const bought = await shopper.buy(listing.id, { email: "smoke@example.com" });
            const verdict = await verdictOnPurchase(bought, (id) => store.orderById(id));
            switch (verdict.kind) {
              case "settled":
                return verdict.transaction as Hex;
              case "not_charged":
                throw new Error(`nothing was charged: ${verdict.why}`);
              default:
                throw new Error(
                  `whether money moved is not known: ${verdict.why}. Read the buyer's balance before running again`,
                );
            }
          },
          instruction: async () =>
            merchantPayout(
              booted.config.payoutSplit,
              (await booted.gateway.payoutSplitsOf(merchantId)).toPayOut,
              booted.config.payoutSplitNetworks,
            ),
          operator: async () => {
            const theirs = (await booted.gateway.splitsToPayOut()).filter(
              (one) => one.merchantId === merchantId,
            );
            const [only, ...more] = operatorPayouts(
              booted.config.payoutSplit,
              theirs,
              booted.config.payoutSplitNetworks,
            );
            if (only === undefined || more.length > 0) {
              throw new Error(
                `the operator's payout of ${merchantId} is ${more.length + 1} transactions`,
              );
            }
            return only;
          },
        }),
        network,
        split: inForce,
        buyer,
        price: settings.price,
        gasCap: settings.gasCap,
        confirm: settings.confirm,
        journal: path.resolve("split-smoke.jsonl"),
        say,
      });
    } finally {
      await merchant.stop();
    }
  } finally {
    await booted.stop();
  }
}

// Only where somebody typed the command: a run that began on import would
// read the chain and could pay from inside whatever imported it.
if (import.meta.main) {
  main().catch((thrown: unknown) => {
    // The message only, never the error itself: a payment client's error can
    // carry its request along, and a key is not to be risked in a log.
    console.error(
      thrown instanceof SmokeStopped
        ? `[smoke:split] STOPPED at ${thrown.step}: ${thrown.message}`
        : `[smoke:split] the split smoke failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
    process.exit(1);
  });
}
