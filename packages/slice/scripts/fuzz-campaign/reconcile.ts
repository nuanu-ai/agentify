/** Read-only TEST reconciliation: receipts are matched to actual USDC Transfer logs. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { OrderListSchema, ReceiptListSchema } from "../../../../packages/contracts/src/index.js";

const require = createRequire(new URL("../../package.json", import.meta.url));
const { createPublicClient, http, parseAbi, parseEventLogs } = require("viem");
const rpc = createPublicClient({ transport: http("https://sepolia.base.org", { retryCount: 1 }) });
assert.equal(await rpc.getChainId(), 84532);
const usdcAddress = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const buyer = "0x4813B4258dc8b06Bfe5a30572c5855fC3B217432";
const abi = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "function balanceOf(address) view returns (uint256)",
]);
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const report: { at: string; chainId: number; merchants: unknown[]; buyerBalanceAtomic?: string } = {
  at: new Date().toISOString(),
  chainId: 84532,
  merchants: [],
};
for (const name of ["sdk", "woo"]) {
  const fixture = JSON.parse(
    readFileSync(
      new URL(`../../../../.local/fuzz-campaign/${name}-merchant.json`, import.meta.url),
      "utf8",
    ),
  );
  async function get(path: string) {
    await new Promise((resolve) => setTimeout(resolve, 220));
    const r = await fetch(`https://test.agentify.ad${path}`, {
      headers: { authorization: `Bearer ${fixture.apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(r.status, 200);
    return r.json();
  }
  const receipts = ReceiptListSchema.parse(await get("/v0/receipts")).receipts;
  const orders = OrderListSchema.parse(await get("/v0/orders")).orders;
  const expected = name === "sdk" ? 4 : 1;
  assert.equal(receipts.length, expected);
  assert(orders.length >= expected + (name === "sdk" ? 1 : 0));
  assert.equal(new Set(receipts.map((r) => r.order_id)).size, expected);
  const evidence = [];
  let firstBlock: bigint | undefined;
  const lastBlock: bigint = await rpc.getBlockNumber();
  for (const receipt of receipts) {
    assert.equal(receipt.test, true);
    assert.equal(receipt.price.amount, "0.01");
    assert.equal(receipt.price.currency, "USD");
    assert(receipt.transaction);
    const mined = await rpc.getTransactionReceipt({ hash: receipt.transaction });
    assert.equal(mined.status, "success");
    if (firstBlock === undefined || mined.blockNumber < firstBlock) firstBlock = mined.blockNumber;
    const transfers = parseEventLogs({
      abi,
      logs: mined.logs.filter(
        (l: { address: string }) => l.address.toLowerCase() === usdcAddress.toLowerCase(),
      ),
      eventName: "Transfer",
    });
    const matching = transfers.filter(
      (l: { args: { from: string; to: string } }) =>
        l.args.from.toLowerCase() === buyer.toLowerCase() &&
        l.args.to.toLowerCase() === fixture.split.address.toLowerCase(),
    );
    assert.equal(matching.length, 1);
    assert.equal(matching[0].args.value, 10_000n);
    const status = await get(`/x402/orders/${encodeURIComponent(receipt.order_id)}/status`);
    assert.equal(status.order_id, receipt.order_id);
    assert.equal(status.status, "delivered");
    evidence.push({
      orderHash: hash(receipt.order_id),
      transaction: receipt.transaction,
      block: mined.blockNumber.toString(),
      matchingTransfers: matching.length,
      atomic: matching[0].args.value.toString(),
    });
  }
  assert(firstBlock !== undefined);
  // The splits are campaign-specific. Query the entire campaign interval, including time before the first payment.
  const logs: { transactionHash: string }[] = [];
  for (let from = firstBlock - 100n; from <= lastBlock; from += 199n) {
    const to = from + 198n < lastBlock ? from + 198n : lastBlock;
    logs.push(
      ...(await rpc.getLogs({
        address: usdcAddress,
        event: abi[0],
        args: { from: buyer, to: fixture.split.address },
        fromBlock: from,
        toBlock: to,
      })),
    );
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
  assert.equal(logs.length, expected, "unexpected extra buyer-to-split transfer");
  assert.equal(
    new Set(logs.map((l: { transactionHash: string }) => l.transactionHash)).size,
    expected,
  );
  const receiptTxs = receipts.map((r) => r.transaction?.toLowerCase()).sort();
  assert.equal(new Set(receiptTxs).size, expected);
  assert.deepEqual(receiptTxs, logs.map((l) => l.transactionHash.toLowerCase()).sort());
  const after = ReceiptListSchema.parse(await get("/v0/receipts")).receipts;
  assert.deepEqual(after, receipts, "repeated status reads changed receipts");
  const refused = orders.filter((o) => o.status === "rejected");
  assert.equal(refused.length, name === "sdk" ? 1 : 0);
  for (const order of refused) assert(!receipts.some((r) => r.order_id === order.id));
  report.merchants.push({
    name,
    merchantId: fixture.merchantId,
    split: fixture.split.address,
    orderCount: orders.length,
    receiptCount: receipts.length,
    refusedWithoutReceipt: refused.length,
    chainTransferCount: logs.length,
    fromBlock: (firstBlock - 100n).toString(),
    toBlock: lastBlock.toString(),
    receiptsUnchangedAfterStatusReads: true,
    splitBalanceAtomic: (
      await rpc.readContract({
        address: usdcAddress,
        abi,
        functionName: "balanceOf",
        args: [fixture.split.address],
      })
    ).toString(),
    evidence,
  });
}
report.buyerBalanceAtomic = (
  await rpc.readContract({ address: usdcAddress, abi, functionName: "balanceOf", args: [buyer] })
).toString();
writeFileSync(
  new URL(
    "../../../../docs/research/fuzz-campaign-2026-10-15/reconciliation-evidence.json",
    import.meta.url,
  ),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report));
