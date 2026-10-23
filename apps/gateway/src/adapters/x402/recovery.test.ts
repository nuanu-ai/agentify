import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { encodeAbiParameters, encodeEventTopics, numberToHex, parseAbi } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { PaymentEdge } from "../../http/x402.js";
import { type PaymentRecoveryContext, RecoveryFailure } from "../../ports/facilitator.js";
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
/** Blocks come every two seconds from time zero, as on Base, unless a test says otherwise. */
let secondsPerBlock = 2n;
const timeOf = (number: bigint): bigint => number * secondsPerBlock;
const hashOf = (number: bigint): string => `0x${number.toString(16).padStart(64, "0")}`;
/** The authorization was checked at time 990 (block 495) and is valid until 1100 (block 550). */
const CONTEXT: PaymentRecoveryContext = {
  kind: "evm-exact-eip3009",
  network: "eip155:84532",
  asset: ASSET,
  payer: PAYER,
  payTo: PAY_TO,
  amount: "80000000",
  validAfter: "400",
  validBefore: "1100",
  nonce: NONCE,
  notBefore: "990",
};

function event(
  name: "AuthorizationUsed" | "AuthorizationCanceled" | "Transfer",
  index: number,
  at = 500n,
): ChainLog {
  return {
    address: ASSET,
    transactionHash: TX,
    blockNumber: at,
    blockHash: hashOf(at),
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

/**
 * A chain on which the authorization is used in block `usedAt` by the
 * transaction `receiptValue`. The finalized block is far past the
 * authorization's expiry, as it always is by the time recovery runs.
 */
class Chain implements ChainReader {
  chainId = 84532;
  finalized = 1000n;
  usedAt: bigint | null = 500n;
  failed = false;
  /** Reads allowed before the endpoint answers 429, as a rate limit does; null is no limit. */
  budget: number | null = null;
  calls = 0;
  receiptsRead: bigint[] = [];
  spend() {
    this.calls += 1;
    if (this.budget !== null && this.calls > this.budget)
      throw new RecoveryFailure("eth_getBlockReceipts at rpc.invalid failed: HTTP 429.");
  }
  receiptValue: ChainReceipt = {
    transactionHash: TX,
    blockNumber: 500n,
    blockHash: hashOf(500n),
    status: "success",
    logs: [event("AuthorizationUsed", 4), event("Transfer", 5)],
  };
  async networkId() {
    return this.chainId;
  }
  async block(number?: bigint): Promise<ChainBlock> {
    if (this.failed) throw new RecoveryFailure("eth_getBlockByNumber at rpc.invalid failed.");
    this.spend();
    const at = number ?? this.finalized;
    return { number: at, hash: hashOf(at), timestamp: timeOf(at) };
  }
  async authorizationState(_context: unknown, number: bigint) {
    this.spend();
    return this.usedAt !== null && number >= this.usedAt;
  }
  async blockReceipts(number: bigint) {
    this.spend();
    this.receiptsRead.push(number);
    return number === this.receiptValue.blockNumber ? [this.receiptValue] : [];
  }
  async receipt(_transaction: string) {
    return this.receiptValue;
  }
}

describe("recovering an EIP-3009 payment from chain evidence", () => {
  afterEach(() => {
    secondsPerBlock = 2n;
  });

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
      accepted: edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", PAY_TO),
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
      orderId: "ord_1",
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
    expect(accepted).toMatchObject({ verified: true, recovery: { notBefore: "970" } });
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

  it("finds a transfer without its hash once the finalized chain is past the authorization's expiry", async () => {
    const chain = new Chain();
    expect(await new Eip3009Recovery(() => chain).reconcile({ context: CONTEXT })).toStrictEqual({
      settled: true,
      transaction: TX,
      executedAt: 1_000_000,
    });
    expect(chain.receiptsRead).toEqual([495n, 496n, 497n, 498n, 499n, 500n]);
  });

  it("reads only the blocks where the authorization was valid, then proves it expired unused when a later cancellation marked it used", async () => {
    const chain = new Chain();
    chain.usedAt = 550n;
    chain.receiptValue = {
      ...chain.receiptValue,
      blockNumber: 550n,
      blockHash: hashOf(550n),
      logs: [event("AuthorizationCanceled", 4, 550n)],
    };
    expect(await new Eip3009Recovery(() => chain).reconcile({ context: CONTEXT })).toMatchObject({
      settled: false,
    });
    expect(chain.receiptsRead[0]).toBe(495n);
    expect(chain.receiptsRead.at(-1)).toBe(549n);
  });

  it("keeps a used authorization unknown when its window holds no evidence, and stays where it stopped", async () => {
    const chain = new Chain();
    chain.receiptValue = { ...chain.receiptValue, blockNumber: 700n };
    const recovery = new Eip3009Recovery(() => chain);
    const outcome = await recovery.reconcile({ context: CONTEXT });
    expect(outcome).toMatchObject({ settled: "unknown", nextBlock: "550" });
    chain.receiptsRead = [];
    expect(await recovery.reconcile({ context: CONTEXT, nextBlock: "550" })).toMatchObject({
      settled: "unknown",
    });
    expect(chain.receiptsRead).toEqual([]);
  });

  it("starts at the first block of the window on a chain whose blocks are one second apart", async () => {
    secondsPerBlock = 1n;
    const chain = new Chain();
    chain.finalized = 2000n;
    chain.usedAt = 990n;
    chain.receiptValue = {
      ...chain.receiptValue,
      blockNumber: 990n,
      blockHash: hashOf(990n),
      logs: [event("AuthorizationUsed", 4, 990n), event("Transfer", 5, 990n)],
    };
    expect(await new Eip3009Recovery(() => chain).reconcile({ context: CONTEXT })).toMatchObject({
      settled: true,
      transaction: TX,
    });
    expect(chain.receiptsRead).toEqual([990n]);
  });

  it("continues a long search on the next poll from where it stopped", async () => {
    const chain = new Chain();
    const recovery = new Eip3009Recovery(() => chain);
    const context = { ...CONTEXT, notBefore: "800" };
    const first = await recovery.reconcile({ context });
    expect(first).toMatchObject({ settled: "unknown", nextBlock: "464" });
    expect(chain.receiptsRead[0]).toBe(400n);
    chain.receiptsRead = [];
    expect(await recovery.reconcile({ context, nextBlock: "464" })).toMatchObject({
      settled: true,
      transaction: TX,
    });
    expect(chain.receiptsRead[0]).toBe(464n);
  });

  it("keeps the place a rate-limited poll reached, so a transfer at the window's end is found", async () => {
    const chain = new Chain();
    chain.usedAt = 549n;
    chain.receiptValue = {
      ...chain.receiptValue,
      blockNumber: 549n,
      blockHash: hashOf(549n),
      logs: [event("AuthorizationUsed", 4, 549n), event("Transfer", 5, 549n)],
    };
    const recovery = new Eip3009Recovery(() => chain);
    let cursor: string | undefined;
    for (let poll = 1; poll <= 10; poll += 1) {
      chain.calls = 0;
      chain.budget = 40;
      const outcome = await recovery.reconcile({
        context: CONTEXT,
        ...(cursor === undefined ? {} : { nextBlock: cursor }),
      });
      if (outcome.settled !== "unknown") {
        expect(outcome).toMatchObject({ settled: true, transaction: TX });
        expect(new Set(chain.receiptsRead).size).toBe(chain.receiptsRead.length);
        return;
      }
      expect(outcome.failure).toContain("HTTP 429");
      cursor = outcome.nextBlock;
    }
    throw new Error("ten polls under the rate limit never reached the transfer");
  });

  it("proves nonpayment only after an unused authorization has irreversibly expired", async () => {
    const chain = new Chain();
    chain.usedAt = null;
    chain.finalized = 540n;
    const recovery = new Eip3009Recovery(() => chain);
    expect(await recovery.reconcile({ context: CONTEXT })).toMatchObject({ settled: "unknown" });
    chain.finalized = 550n;
    expect(await recovery.reconcile({ context: CONTEXT })).toMatchObject({ settled: false });
  });

  it("recognizes a finalized cancellation inside the window as nonpayment", async () => {
    const chain = new Chain();
    chain.receiptValue = { ...chain.receiptValue, logs: [event("AuthorizationCanceled", 4)] };
    expect(await new Eip3009Recovery(() => chain).reconcile({ context: CONTEXT })).toMatchObject({
      settled: false,
    });
  });

  it.each([
    "reverted",
    "unfinalized",
    "noncanonical",
    "different token",
    "authorization from another contract",
    "different payer",
    "different recipient",
    "different amount",
    "different nonce",
    "intervening log",
    "non-adjacent log index",
    "duplicate use",
    "wrong receipt hash",
  ])("keeps %s evidence unknown", async (fault) => {
    const chain = new Chain();
    const logs = [...chain.receiptValue.logs];
    if (fault === "reverted") chain.receiptValue.status = "reverted";
    if (fault === "unfinalized") chain.finalized = 499n;
    if (fault === "noncanonical") chain.receiptValue.blockHash = `0x${"d".repeat(64)}`;
    if (fault === "different token") logs[1] = { ...event("Transfer", 5), address: PAYER };
    if (fault === "authorization from another contract")
      logs[0] = { ...event("AuthorizationUsed", 4), address: PAYER };
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
    if (fault === "non-adjacent log index") logs[1] = event("Transfer", 6);
    if (fault === "duplicate use") logs.push(event("AuthorizationUsed", 6));
    if (fault === "wrong receipt hash") chain.receiptValue.transactionHash = `0x${"d".repeat(64)}`;
    chain.receiptValue.logs = logs;
    expect(
      await new Eip3009Recovery(() => chain).reconcile({ context: CONTEXT, transaction: TX }),
    ).toMatchObject({ settled: "unknown" });
  });

  it.each([
    ["at or after its validBefore", { validBefore: "1000" }],
    ["at or before its validAfter", { validAfter: "1000" }],
  ])("never takes a transfer in a block %s as payment", async (_case, terms) => {
    const chain = new Chain();
    const outcome = await new Eip3009Recovery(() => chain).reconcile({
      context: { ...CONTEXT, ...terms },
      transaction: TX,
    });
    expect(outcome.settled).not.toBe(true);
  });

  it("never reads a transfer from a block above the finalized one", async () => {
    const chain = new Chain();
    chain.finalized = 510n;
    chain.receiptValue = {
      ...chain.receiptValue,
      blockNumber: 520n,
      blockHash: hashOf(520n),
      logs: [event("AuthorizationUsed", 4, 520n), event("Transfer", 5, 520n)],
    };
    expect(await new Eip3009Recovery(() => chain).reconcile({ context: CONTEXT })).toMatchObject({
      settled: "unknown",
    });
    expect(chain.receiptsRead.at(-1)).toBe(510n);
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

  it("reports a chain it cannot read instead of answering unknown", async () => {
    const chain = new Chain();
    chain.failed = true;
    await expect(new Eip3009Recovery(() => chain).reconcile({ context: CONTEXT })).rejects.toThrow(
      RecoveryFailure,
    );
  });

  it("refuses a reader connected to a different chain", async () => {
    const chain = new Chain();
    chain.chainId = 8453;
    await expect(new Eip3009Recovery(() => chain).reconcile({ context: CONTEXT })).rejects.toThrow(
      /8453/,
    );
  });

  it("revisits a discovered authorization until its complete receipt is available", async () => {
    const chain = new Chain();
    const complete = chain.receiptValue;
    chain.receiptValue = { ...complete, logs: [event("AuthorizationUsed", 4)] };
    const recovery = new Eip3009Recovery(() => chain);
    const first = await recovery.reconcile({ context: CONTEXT });
    expect(first).toMatchObject({ settled: "unknown", nextBlock: "500" });
    chain.receiptValue = complete;
    expect(await recovery.reconcile({ context: CONTEXT, nextBlock: "500" })).toMatchObject({
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

/**
 * The chain above, served over JSON-RPC on this machine the way a public Base
 * endpoint serves it: log queries are refused, as Base mainnet's refuses them.
 */
async function serve(chain: Chain, status = 200): Promise<{ url: string; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", async () => {
      const { id, method, params } = JSON.parse(body);
      asked.push(method);
      const reply = (result: unknown, code = status) => {
        response.writeHead(code, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id, ...(result as object) }));
      };
      if (status !== 200 || chain.failed)
        return reply({ error: { code: -32011, message: "request limit reached" } }, status);
      const at = (tag: string) => (tag === "finalized" ? chain.finalized : BigInt(tag));
      const rpcLog = (log: ChainLog) => ({
        ...log,
        blockNumber: numberToHex(log.blockNumber),
        logIndex: numberToHex(log.logIndex),
        transactionIndex: "0x0",
        removed: false,
      });
      const rpcReceipt = (receipt: ChainReceipt) => ({
        transactionHash: receipt.transactionHash,
        blockNumber: numberToHex(receipt.blockNumber),
        blockHash: receipt.blockHash,
        status: receipt.status === "success" ? "0x1" : "0x0",
        logs: receipt.logs.map(rpcLog),
        transactionIndex: "0x0",
        from: PAYER,
        to: ASSET,
        type: "0x2",
      });
      switch (method) {
        case "eth_chainId":
          return reply({ result: numberToHex(chain.chainId) });
        case "eth_getBlockByNumber": {
          const block = await chain.block(at(params[0]));
          return reply({
            result: {
              number: numberToHex(block.number),
              hash: block.hash,
              timestamp: numberToHex(block.timestamp),
              transactions: [],
            },
          });
        }
        case "eth_call": {
          const used = await chain.authorizationState(null, at(params[1]));
          return reply({ result: `0x${(used ? "1" : "0").padStart(64, "0")}` });
        }
        case "eth_getBlockReceipts":
          return reply({ result: (await chain.blockReceipts(at(params[0]))).map(rpcReceipt) });
        case "eth_getTransactionReceipt":
          return reply({ result: rpcReceipt(await chain.receipt(params[0])) });
        default:
          return reply({ error: { code: -32011, message: "request limit reached" } }, 429);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v2/provider-key-123?key=provider-key-456`, asked };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

describe("recovering through a JSON-RPC endpoint", () => {
  it("has no chain recovery capability when no RPC URL is configured", async () => {
    expect((await recoveryOn("eip155:84532")).recovery).toBeUndefined();
  });

  it("finds a transfer through an endpoint that refuses log queries", async () => {
    const chain = new Chain();
    const { url, asked } = await serve(chain);
    const { recovery } = await recoveryOn("eip155:84532", url);
    expect(await recovery?.reconcile({ context: CONTEXT })).toStrictEqual({
      settled: true,
      transaction: TX,
      executedAt: 1_000_000,
    });
    expect(asked).not.toContain("eth_getLogs");
  });

  it("says at start-up and on every poll that the endpoint serves another chain, and how to fix it", async () => {
    const chain = new Chain();
    chain.chainId = 8453;
    const { url } = await serve(chain);
    const started = await recoveryOn("eip155:84532", url);
    expect(started.broken).toBe(true);
    expect(started.said).toContain("8453");
    expect(started.said).toContain("PAYMENT_RPC_URL");
    await expect(started.recovery?.reconcile({ context: CONTEXT })).rejects.toThrow(
      /8453.*PAYMENT_RPC_URL/,
    );
  });

  it("starts recovering once an endpoint that did not answer at start-up answers", async () => {
    const chain = new Chain();
    chain.failed = true;
    const { url } = await serve(chain);
    const started = await recoveryOn("eip155:84532", url);
    expect(started.broken).toBe(true);
    expect(started.said).toContain("-32011");
    expect(started.said).not.toContain("provider-key");
    chain.failed = false;
    expect(await started.recovery?.reconcile({ context: CONTEXT })).toMatchObject({
      settled: true,
      transaction: TX,
    });
  });

  it("names a refusing status at start-up without revealing the address's path or query", async () => {
    const { url } = await serve(new Chain(), 429);
    const started = await recoveryOn("eip155:84532", url);
    expect(started.broken).toBe(true);
    expect(started.said).toContain("429");
    expect(started.said).not.toContain("provider-key");
  });

  it("reports a failed read by its kind, without revealing the address's path or query", async () => {
    const chain = new Chain();
    const { url } = await serve(chain);
    const { recovery } = await recoveryOn("eip155:84532", url);
    chain.failed = true;
    const failed = await recovery?.reconcile({ context: CONTEXT }).catch((thrown) => thrown);
    expect(failed).toBeInstanceOf(RecoveryFailure);
    expect(failed.message).toMatch(/^eth_\w+ at 127\.0\.0\.1:\d+ failed: .*-32011/);
    expect(failed.message).not.toContain("provider-key");
  });

  it("does not query the endpoint for a payment saved on another chain", async () => {
    const chain = new Chain();
    chain.chainId = 8453;
    const { url, asked } = await serve(chain);
    const { recovery } = await recoveryOn("eip155:8453", url);
    const before = asked.length;
    await expect(recovery?.reconcile({ context: CONTEXT })).rejects.toThrow(RecoveryFailure);
    expect(asked).toHaveLength(before);
  });
});
