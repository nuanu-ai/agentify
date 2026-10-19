import { encodePaymentSignatureHeader } from "@x402/core/http";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { PaymentEdge } from "../../http/x402.js";
import type { PaymentRecoveryContext } from "../../ports/facilitator.js";
import { X402Facilitator } from "./facilitator.js";
import {
  type ChainBlock,
  type ChainLog,
  type ChainReader,
  type ChainReceipt,
  Eip3009Recovery,
  recoveryOn,
} from "./recovery.js";

const ABI = parseAbi([
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const PAYER = "0x0000000000000000000000000000000000000002";
const PAY_TO = "0x0000000000000000000000000000000000000001";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NONCE = `0x${"a".repeat(64)}` as const;
const TX = `0x${"b".repeat(64)}` as const;
const HASH = `0x${"c".repeat(64)}` as const;
const CONTEXT: PaymentRecoveryContext = {
  kind: "evm-exact-eip3009",
  network: "eip155:84532",
  asset: ASSET,
  payer: PAYER,
  payTo: PAY_TO,
  amount: "80000000",
  validAfter: "400",
  validBefore: "1300",
  nonce: NONCE,
  fromBlock: "10",
};

function event(
  name: "AuthorizationUsed" | "AuthorizationCanceled" | "Transfer",
  index: number,
): ChainLog {
  return {
    address: ASSET,
    transactionHash: TX,
    blockNumber: 20n,
    blockHash: HASH,
    logIndex: index,
    topics:
      name === "Transfer"
        ? (encodeEventTopics({
            abi: ABI,
            eventName: name,
            args: { from: PAYER, to: PAY_TO },
          }) as string[])
        : (encodeEventTopics({
            abi: ABI,
            eventName: name,
            args: { authorizer: PAYER, nonce: NONCE },
          }) as string[]),
    data: name === "Transfer" ? encodeAbiParameters([{ type: "uint256" }], [80000000n]) : "0x",
  };
}

class Chain implements ChainReader {
  chainId = 84532;
  head: ChainBlock = { number: 30n, hash: HASH, timestamp: 1200n };
  usedAt: bigint | null = 20n;
  historicalUnavailable = false;
  failed = false;
  events: ChainLog[] = [event("AuthorizationUsed", 4)];
  receiptValue: ChainReceipt = {
    transactionHash: TX,
    blockNumber: 20n,
    blockHash: HASH,
    status: "success",
    logs: [event("AuthorizationUsed", 4), event("Transfer", 5)],
  };
  async networkId() {
    return this.chainId;
  }
  async block(number?: bigint): Promise<ChainBlock> {
    if (this.failed) throw new Error("RPC unavailable");
    return number === undefined ? this.head : { number, hash: HASH, timestamp: 1000n };
  }
  async authorizationState(_context: PaymentRecoveryContext, number: bigint) {
    if (this.historicalUnavailable && number !== this.head.number) throw new Error("no archive");
    return this.usedAt !== null && number >= this.usedAt;
  }
  async authorizationLogs(_context: PaymentRecoveryContext, from: bigint, to: bigint) {
    return this.events.filter((log) => log.blockNumber >= from && log.blockNumber <= to);
  }
  async receipt(_transaction: string) {
    return this.receiptValue;
  }
}

describe("recovering an EIP-3009 payment from chain evidence", () => {
  it("recovers a held payment accepted without RPC after a reader is configured", async () => {
    const edge = new PaymentEdge({
      payment: {
        facilitatorUrl: "https://facilitator.invalid",
        network: CONTEXT.network,
        payTo: PAY_TO,
        cdpApiKeyId: null,
        cdpApiKeySecret: null,
      },
      publicBaseUrl: "https://agentify.example",
      deadlines: { quoteTtlMs: 30_000, syncResponseMs: 260_000 },
    });
    const payment = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: edge.requirementsFor({ amount: "80.00", currency: "USD" }, "pay_1", PAY_TO),
      payload: {
        signature: "0x12",
        authorization: {
          from: PAYER,
          to: PAY_TO,
          value: CONTEXT.amount,
          validAfter: CONTEXT.validAfter,
          validBefore: CONTEXT.validBefore,
          nonce: NONCE,
        },
      },
    });
    const charge = {
      paymentRef: "pay_1",
      amount: "80.00",
      currency: "USD",
      payTo: PAY_TO,
      payment,
    };
    const client = {
      verify: async () => ({ isValid: true, payer: PAYER }),
      settle: async () => {
        throw new Error("The settlement reply was lost.");
      },
      getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
    };
    const first = new X402Facilitator(client, edge, undefined, () => 1_000_000);
    const accepted = await first.verify(charge);
    expect(accepted).toMatchObject({ verified: true, recovery: { fromBlock: "0" } });
    expect(await first.settle(charge)).toMatchObject({ settled: "unknown" });
    if (accepted.verified !== true || !accepted.recovery)
      throw new Error("No durable context was returned.");
    const restored = new X402Facilitator(client, edge, new Eip3009Recovery(() => new Chain()));
    if (!restored.reconcile) throw new Error("No configured recovery capability.");
    expect(await restored.reconcile({ context: accepted.recovery })).toMatchObject({
      settled: true,
      transaction: TX,
    });
  });

  it("has no chain recovery capability when no RPC URL is configured", () => {
    expect(recoveryOn("eip155:84532")).toBeUndefined();
  });

  it("does not query a configured RPC for a different saved chain or reveal its credentials", async () => {
    const recovery = recoveryOn("eip155:8453", "https://secret:credential@rpc.invalid");
    if (!recovery) throw new Error("Configured RPC did not produce a recovery reader.");
    const outcome = await recovery.reconcile({ context: CONTEXT });
    expect(outcome).toMatchObject({ settled: "unknown" });
    expect(JSON.stringify(outcome)).not.toContain("credential");
  });
  it("finds a finalized exact transfer without calling settle or knowing a transaction hash", async () => {
    const chain = new Chain();
    expect(await new Eip3009Recovery(() => chain).reconcile({ context: CONTEXT })).toStrictEqual({
      settled: true,
      transaction: TX,
      executedAt: 1_000_000,
    });
  });

  it("proves nonpayment only after an unused authorization has irreversibly expired", async () => {
    const chain = new Chain();
    chain.usedAt = null;
    const recovery = new Eip3009Recovery(() => chain);
    expect(await recovery.reconcile({ context: CONTEXT })).toMatchObject({ settled: "unknown" });
    chain.head = { ...chain.head, timestamp: 1300n };
    expect(await recovery.reconcile({ context: CONTEXT })).toMatchObject({ settled: false });
  });

  it("recognizes a finalized cancellation as nonpayment even before expiry", async () => {
    const chain = new Chain();
    chain.events = [event("AuthorizationCanceled", 4)];
    chain.receiptValue = { ...chain.receiptValue, logs: chain.events };
    expect(await new Eip3009Recovery(() => chain).reconcile({ context: CONTEXT })).toMatchObject({
      settled: false,
    });
  });

  it.each([
    "reverted",
    "unfinalized",
    "noncanonical",
    "different token",
    "different payer",
    "different recipient",
    "different amount",
    "different nonce",
    "intervening log",
    "duplicate use",
    "wrong receipt hash",
    "out of window",
  ])("keeps %s evidence unknown", async (fault) => {
    const chain = new Chain();
    const logs = [...chain.receiptValue.logs];
    if (fault === "reverted") chain.receiptValue.status = "reverted";
    if (fault === "unfinalized") chain.head = { ...chain.head, number: 19n };
    if (fault === "noncanonical") chain.receiptValue.blockHash = `0x${"d".repeat(64)}`;
    if (fault === "different token") logs[1] = { ...event("Transfer", 5), address: PAYER };
    if (fault === "different payer")
      logs[1] = {
        ...event("Transfer", 5),
        topics: encodeEventTopics({
          abi: ABI,
          eventName: "Transfer",
          args: { from: PAY_TO, to: PAY_TO },
        }) as string[],
      };
    if (fault === "different recipient")
      logs[1] = {
        ...event("Transfer", 5),
        topics: encodeEventTopics({
          abi: ABI,
          eventName: "Transfer",
          args: { from: PAYER, to: PAYER },
        }) as string[],
      };
    if (fault === "different amount")
      logs[1] = { ...event("Transfer", 5), data: encodeAbiParameters([{ type: "uint256" }], [1n]) };
    if (fault === "different nonce")
      logs[0] = {
        ...event("AuthorizationUsed", 4),
        topics: encodeEventTopics({
          abi: ABI,
          eventName: "AuthorizationUsed",
          args: { authorizer: PAYER, nonce: `0x${"d".repeat(64)}` },
        }) as string[],
      };
    if (fault === "intervening log") logs.splice(1, 0, { ...event("Transfer", 5), address: PAYER });
    if (fault === "duplicate use") logs.push(event("AuthorizationUsed", 6));
    if (fault === "wrong receipt hash") chain.receiptValue.transactionHash = `0x${"d".repeat(64)}`;
    chain.receiptValue.logs = logs;
    const context = fault === "out of window" ? { ...CONTEXT, validBefore: "900" } : CONTEXT;
    expect(
      await new Eip3009Recovery(() => chain).reconcile({ context, transaction: TX }),
    ).toMatchObject({ settled: "unknown" });
  });

  it("uses a candidate hash only as a hint and still finds the original authorization", async () => {
    const chain = new Chain();
    const actual = chain.receiptValue;
    chain.receipt = async (transaction) =>
      transaction === TX ? actual : { ...actual, status: "reverted", transactionHash: transaction };
    expect(
      await new Eip3009Recovery(() => chain).reconcile({
        context: CONTEXT,
        transaction: `0x${"d".repeat(64)}`,
      }),
    ).toMatchObject({ settled: true, transaction: TX });
  });

  it("keeps missing evidence and RPC failures unknown", async () => {
    const chain = new Chain();
    chain.events = [];
    const recovery = new Eip3009Recovery(() => chain);
    expect(await recovery.reconcile({ context: CONTEXT })).toMatchObject({ settled: "unknown" });
    chain.failed = true;
    expect(await recovery.reconcile({ context: CONTEXT })).toMatchObject({ settled: "unknown" });
  });

  it("refuses a reader connected to a different chain", async () => {
    const chain = new Chain();
    chain.chainId = 8453;
    expect(await new Eip3009Recovery(() => chain).reconcile({ context: CONTEXT })).toMatchObject({
      settled: "unknown",
    });
  });

  it("advances a bounded durable cursor when historical reads are unavailable", async () => {
    const chain = new Chain();
    chain.head = { ...chain.head, number: 5000n };
    chain.usedAt = 2500n;
    chain.historicalUnavailable = true;
    chain.events = [{ ...event("AuthorizationUsed", 4), blockNumber: 2500n }];
    chain.receiptValue = {
      ...chain.receiptValue,
      blockNumber: 2500n,
      logs: chain.receiptValue.logs.map((log) => ({ ...log, blockNumber: 2500n })),
    };
    const recovery = new Eip3009Recovery(() => chain);
    const context = { ...CONTEXT, fromBlock: "0" };
    const first = await recovery.reconcile({ context });
    expect(first).toMatchObject({ settled: "unknown", nextBlock: "1000" });
    const second = await recovery.reconcile({ context, nextBlock: "1000" });
    expect(second).toMatchObject({ settled: "unknown", nextBlock: "2000" });
    expect(await recovery.reconcile({ context, nextBlock: "2000" })).toMatchObject({
      settled: true,
    });
  });

  it("finds an old cancellation before validAfter using historical nonce state", async () => {
    const chain = new Chain();
    chain.head = { ...chain.head, number: 100000000n };
    chain.usedAt = 20n;
    chain.events = [event("AuthorizationCanceled", 4)];
    chain.receiptValue.logs = chain.events;
    expect(
      await new Eip3009Recovery(() => chain).reconcile({
        context: { ...CONTEXT, fromBlock: "0", validAfter: "1100" },
      }),
    ).toMatchObject({ settled: false });
  });

  it("does not skip a range after one of its receipts fails to load", async () => {
    const chain = new Chain();
    chain.receipt = async () => {
      throw new Error("receipt unavailable");
    };
    expect(
      await new Eip3009Recovery(() => chain).reconcile({ context: CONTEXT }),
    ).not.toHaveProperty("nextBlock");
  });

  it("revisits a discovered authorization until its complete receipt is available", async () => {
    const chain = new Chain();
    const complete = chain.receiptValue;
    chain.receiptValue = { ...complete, logs: [event("AuthorizationUsed", 4)] };
    const recovery = new Eip3009Recovery(() => chain);
    const first = await recovery.reconcile({ context: CONTEXT });
    expect(first).toMatchObject({ settled: "unknown" });
    expect(first).not.toHaveProperty("nextBlock");
    chain.receiptValue = complete;
    expect(await recovery.reconcile({ context: CONTEXT })).toMatchObject({
      settled: true,
      transaction: TX,
    });
  });

  it("requires the next full receipt entry as well as the next log index", async () => {
    const chain = new Chain();
    chain.receiptValue = {
      ...chain.receiptValue,
      logs: [
        event("AuthorizationUsed", 4),
        { ...event("Transfer", 99), address: PAYER },
        event("Transfer", 5),
      ],
    };
    expect(await new Eip3009Recovery(() => chain).reconcile({ context: CONTEXT })).toMatchObject({
      settled: "unknown",
    });
  });
});
