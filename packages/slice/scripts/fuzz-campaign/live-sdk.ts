/** TEST-only consumer exercise. Every authorization is durably reserved before signing. */
import assert from "node:assert/strict";
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
import {
  AgentOrderStatusSchema,
  API_ROUTES,
  expandPath,
} from "../../../../packages/contracts/src/index.js";
import { createClient, type LiveOrder } from "../../../../packages/sdk/src/client.js";

const require = createRequire(new URL("../../package.json", import.meta.url));
const { x402Client } = require("@x402/core/client");
const { registerExactEvmScheme } = require("@x402/evm/exact/client");
const { wrapFetchWithPayment, decodePaymentResponseHeader } = require("@x402/fetch");
const { privateKeyToAccount } = require("viem/accounts");
const base = "https://test.agentify.ad";
const local = fileURLToPath(new URL("../../../../.local/fuzz-campaign/", import.meta.url));
const scenario = process.argv[2];
const isWoo = scenario === "woo-download";
const evidencePath = fileURLToPath(
  new URL(
    `../../../../docs/research/fuzz-campaign-2026-10-15/live-${isWoo ? "woo" : "sdk"}-evidence.json`,
    import.meta.url,
  ),
);
const fixture = JSON.parse(readFileSync(`${local}/${isWoo ? "woo" : "sdk"}-merchant.json`, "utf8"));
const content = readFileSync(
  new URL(
    "../../../../deploy/woocommerce-lab/seed/downloads/gift-message-templates.txt",
    import.meta.url,
  ),
  "utf8",
);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const goods = { content, sha256: hash(content) };
const scenarios = ["sync", "async", "confirm", "refused", "redelivery", "debt", "woo-download"];
assert(scenario !== undefined && scenarios.includes(scenario), "name one registered scenario");
mkdirSync(local, { recursive: true, mode: 0o700 });
const lock = `${local}/payment.lock`;
const lockFd = openSync(lock, "wx", 0o600);
const budgetPath = `${local}/payment-budget.json`;
type Reservation = { scenario: string; at: string; atomic: string; state: string };
const budget: { requests: number; reservations: Reservation[] } = existsSync(budgetPath)
  ? JSON.parse(readFileSync(budgetPath, "utf8"))
  : { requests: 0, reservations: [] };
assert(
  Number.isSafeInteger(budget.requests) && budget.requests >= 0 && budget.requests <= 2000,
  "invalid persistent request count",
);
assert(
  Array.isArray(budget.reservations) && budget.reservations.length <= 40,
  "invalid persistent authorization count",
);
for (const reservation of budget.reservations) {
  assert(
    typeof reservation.atomic === "string" && /^\d+$/.test(reservation.atomic),
    "invalid reserved atomic amount",
  );
  assert(
    BigInt(reservation.atomic) > 0n && BigInt(reservation.atomic) <= 10_000n,
    "a reserved authorization exceeds the per-payment cap",
  );
}
assert(
  budget.reservations.reduce((n, r) => n + BigInt(r.atomic), 0n) <= 400_000n,
  "persistent authorization total exceeds the campaign cap",
);
function persistBudget() {
  const temp = `${budgetPath}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(budget, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, budgetPath);
  const directory = openSync(local, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
const evidence = existsSync(evidencePath)
  ? JSON.parse(readFileSync(evidencePath, "utf8"))
  : {
      subject: "e11fef741e875ef6f9c42465a6b27577dd2921a1",
      base,
      network: "eip155:84532",
      merchant: fixture.merchantId,
      setup:
        "Real email login and seller/wallet forms; key provisioned through application issuer as a TEST fixture. Woo uses actual lab grant and imported card.",
      cases: [],
    };
const row: Record<string, unknown> & {
  observations: string[];
  handlerCalls: number;
  problems: unknown[];
} = {
  scenario,
  startedAt: new Date().toISOString(),
  observations: [],
  handlerCalls: 0,
  problems: [],
};
let merchant: ReturnType<typeof createClient> | undefined;
const originalFetch = globalThis.fetch;
let turn = Promise.resolve();
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input.toString() : input.url,
  );
  assert(
    url.origin === base ||
      (isWoo && url.origin === "https://woo.nuanu.ai" && (init?.method ?? "GET") === "GET"),
    "only TEST and the lab download are allowed",
  );
  const previous = turn;
  let release!: () => void;
  turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    assert(budget.requests < 2000, "campaign HTTP request cap");
    budget.requests += 1;
    persistBudget();
    await new Promise((resolve) => setTimeout(resolve, 210));
  } finally {
    release();
  }
  return originalFetch(input, {
    ...init,
    redirect: "error",
    signal: init?.signal ?? AbortSignal.timeout(90_000),
  });
};
try {
  assert(
    !budget.reservations.some((r) => r.scenario === scenario),
    "scenario already reserved: inspect its existing outcome before another attempt",
  );
  merchant = createClient({ apiKey: fixture.apiKey, baseUrl: base });
  const mode =
    scenario === "async" || scenario === "debt" || isWoo
      ? "async"
      : scenario === "confirm"
        ? "confirm"
        : "sync";
  const sku = `campaign-gift-messages-${scenario}`;
  const card = {
    merchant_item_id: sku,
    title: "Gift Message Templates - TEST",
    description:
      "Test copy of the WooCommerce lab's twenty gift-card messages, delivered as plain text. Test funds only.",
    price: "0.01 USD",
    result: { content: "string", sha256: "string" },
    fulfillment: mode,
    ...(mode !== "sync" ? { fulfill_deadline_seconds: 120 } : {}),
    ...(scenario === "confirm" ? { confirm_deadline_seconds: 60 } : {}),
    ...(scenario === "sync" || scenario === "refused" ? {} : { price_check: "handler" as const }),
  } as const;
  row.mode = mode;
  const published = isWoo
    ? { ok: true as const, id: "item_c8671bcfeb7e40ae99ae80efa1206b82" }
    : await merchant.catalog.publish(card);
  if (isWoo) {
    assert(published.ok);
    const catalog = await (await fetch(`${base}/x402/catalog`)).json();
    const item = catalog.items.find((entry: { id: string }) => entry.id === published.id);
    assert.equal(item.title, "Gift Message Templates");
    assert.equal(item.price.amount, "0.01");
    assert.equal(item.fulfillment, "async");
    row.merchant = fixture.merchantId;
  }
  if (scenario === "confirm") {
    assert.equal(published.ok, false, "confirm is intentionally refused during the pilot");
    if (published.ok) throw new Error("confirm was unexpectedly admitted");
    assert.equal(published.error.code, "card_rejected");
    assert(
      published.error.problems?.some(
        (problem) => problem.path.length === 1 && problem.path[0] === "fulfillment",
      ),
      "confirm refusal must identify its unsupported fulfillment mode",
    );
    assert.equal(
      budget.reservations.filter((reservation) => reservation.scenario === scenario).length,
      0,
    );
    row.expectedPublicationRefusal = {
      code: published.error.code,
      paths: published.error.problems?.map((problem) => problem.path),
    };
    row.finalStatus = "publication_refused";
    row.passed = true;
  } else {
    assert(published.ok, JSON.stringify(published));
    const repeated = isWoo ? published : await merchant.catalog.publish(card);
    assert(repeated.ok && repeated.id === published.id, "publish repeat duplicated a product");
    row.cardId = published.id;
    let handed: LiveOrder | undefined;
    const handled = new Map<string, number>();
    merchant.on("problem", (problem) => {
      row.problems.push({ kind: problem.kind, code: "code" in problem ? problem.code : undefined });
    });
    merchant.on("quote", (question) => question.available({ amount: "0.01", currency: "USD" }));
    merchant.on("order", (order) => {
      assert.equal(order.merchant_item_id, sku);
      assert.equal(order.test, true);
      handed = order;
      const seen = (handled.get(order.id) ?? 0) + 1;
      handled.set(order.id, seen);
      row.handlerCalls += 1;
      if (scenario === "redelivery" && seen === 1)
        throw new Error("registered temporary merchant failure");
      if (scenario === "refused" || scenario === "debt")
        return order.refused({ code: "cannot_fulfill", message: "Registered test refusal." });
      if (mode !== "sync") return order.accepted();
      return order.delivered(goods);
    });
    if (!isWoo) await merchant.start();
    assert(process.env.STAND_BUYER_KEY, "buyer key must come from the ignored environment file");
    const payment = new x402Client();
    registerExactEvmScheme(payment, { signer: privateKeyToAccount(process.env.STAND_BUYER_KEY) });
    payment.setSpendControls({ maxAmountPerPayment: "$0.01" });
    const resource = `${base}/x402/${encodeURIComponent(published.id)}/purchase`;
    let authorisedOrderId: string | undefined;
    payment.onBeforePaymentCreation(
      async ({
        selectedRequirements: req,
        paymentRequired: challenge,
      }: {
        selectedRequirements: {
          network: string;
          scheme: string;
          asset: string;
          payTo: string;
          amount: string;
          extra?: { order_id?: unknown };
        };
        paymentRequired: { x402Version: number; resource: { url: string } };
      }) => {
        assert.equal(challenge.resource.url, resource);
        assert.equal(req.network, "eip155:84532");
        assert.equal(req.scheme, "exact");
        assert.equal(req.asset.toLowerCase(), "0x036cbd53842c5426634e7929541ec2318f3dcf7e");
        assert.equal(req.payTo.toLowerCase(), fixture.split.address.toLowerCase());
        assert.equal(req.amount, "10000");
        assert.equal(challenge.x402Version, 2);
        assert(
          typeof req.extra?.order_id === "string" && req.extra.order_id.length > 0,
          "only a purchase priced against a concrete order may be signed",
        );
        assert(
          !budget.reservations.some((reservation) => reservation.scenario === scenario),
          "one authorization per scenario, including unknown outcomes",
        );
        assert(budget.reservations.length < 40);
        const sum = budget.reservations.reduce((n, r) => n + BigInt(r.atomic), 0n);
        assert(sum + BigInt(req.amount) <= 400_000n);
        budget.reservations.push({
          scenario,
          at: new Date().toISOString(),
          atomic: req.amount,
          state: "reserved-before-signing",
        });
        persistBudget();
        authorisedOrderId = req.extra.order_id;
        row.quoteOrderHash = hash(authorisedOrderId);
      },
    );
    const paying = wrapFetchWithPayment(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        globalThis.fetch(input, init),
      payment,
    );
    const purchase = await paying(resource, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params: {} }),
    });
    const body = AgentOrderStatusSchema.parse(await purchase.json());
    row.purchaseHttp = purchase.status;
    row.purchaseStatus = body.status;
    assert.equal(body.test, true);
    assert.equal(
      body.order_id,
      authorisedOrderId,
      "the response must name the order whose quote was signed",
    );
    assert.equal(body.price?.amount, "0.01");
    assert.equal(body.price.currency, "USD");
    const receipt = purchase.headers.get("payment-response");
    if (receipt) {
      const settled = decodePaymentResponseHeader(receipt);
      assert.equal(settled.network, "eip155:84532");
      assert.equal(settled.success, true);
      row.settlement = {
        success: settled.success,
        transaction: settled.transaction,
        network: settled.network,
      };
    }
    const statusUrl = body.status_url;
    assert.equal(
      typeof statusUrl,
      "string",
      `purchase did not name a status address (HTTP ${purchase.status})`,
    );
    assert.equal(new URL(statusUrl).origin, base);
    assert.equal(
      statusUrl,
      `${base}${expandPath(API_ROUTES.get_order_status.path, { order_id: body.order_id })}`,
    );
    let last = body;
    let closed = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await fetch(statusUrl);
      assert.equal(response.status, 200);
      last = AgentOrderStatusSchema.parse(await response.json());
      assert.equal(last.order_id, body.order_id);
      assert.equal(last.status_url, statusUrl);
      assert.equal(last.test, true);
      if (row.observations.at(-1) !== last.status) row.observations.push(last.status);
      if (scenario === "debt" && last.status === "refund_due" && !closed && handed) {
        assert.equal(handed.id, body.order_id);
        const delivered = await merchant.orders.forId(handed.id).deliver(goods);
        row.debtClosure = delivered;
        assert(delivered.ok);
        assert.equal(delivered.result, "debt_closed_by_delivery");
        closed = true;
      } else if (
        mode === "async" &&
        scenario !== "debt" &&
        handed &&
        !closed &&
        last.status === "in_progress"
      ) {
        assert.equal(handed.id, body.order_id);
        const delivered = await merchant.orders.forId(handed.id).deliver(goods);
        assert(delivered.ok);
        row.explicitDelivery = delivered;
        closed = true;
      }
      if (
        [
          "delivered",
          "shipped",
          "rejected",
          "declined",
          "cancelled",
          "expired",
          "delivered_unpaid",
          "refunded",
        ].includes(last.status)
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    row.finalStatus = last.status;
    if (!isWoo) assert.equal(handed?.id, body.order_id);
    if (scenario === "redelivery")
      assert(
        row.handlerCalls >= 2,
        "the registered temporary failure must reach a later handler delivery",
      );
    if (scenario === "debt") assert(closed, "the observed refund debt must be closed by delivery");
    row.orderHash = hash(handed?.id ?? last.order_id ?? statusUrl);
    if (scenario === "refused") {
      assert.equal(last.status, "rejected");
      assert.equal(last.refusal?.code, "cannot_fulfill");
      assert.equal(last.delivered, null);
      assert.equal(receipt, null, "a synchronous refusal must not report a settlement");
    } else {
      assert.equal(last.status, "delivered");
      if (isWoo) {
        assert(last.delivered && typeof last.delivered.download_url === "string");
        assert.equal(new URL(last.delivered.download_url).origin, "https://woo.nuanu.ai");
        for (let repeat = 0; repeat < 2; repeat += 1) {
          const download: Response = await fetch(last.delivered.download_url);
          assert.equal(download.status, 200);
          const bytes = Buffer.from(await download.arrayBuffer());
          assert.deepEqual(bytes, Buffer.from(content, "utf8"));
          row.actualDownloadedBytes = bytes.length;
          row.actualDownloadedSha256 = createHash("sha256").update(bytes).digest("hex");
        }
        assert.equal(last.delivered.file_name, "gift-message-templates.txt");
        assert(
          typeof last.delivered.order_number === "string" && last.delivered.order_number.length > 0,
        );
        row.repeatedDownloads = 2;
        row.wooOrderNumber = last.delivered.order_number;
        writeFileSync(
          `${local}/woo-order-private.json`,
          JSON.stringify({ orderId: body.order_id, statusUrl, delivered: last.delivered }),
          { mode: 0o600 },
        );
      } else assert.deepEqual(last.delivered, goods);
      row.deliveredBytes = Buffer.byteLength(content);
      row.deliveredSha256 = goods.sha256;
      if (mode !== "sync" && !isWoo) {
        assert(handed);
        const duplicate = await merchant.orders.forId(handed.id).deliver(goods);
        assert(duplicate.ok);
        assert.equal(duplicate.result, "already_delivered");
        row.duplicateDelivery = duplicate;
      }
    }
    row.passed = true;
    for (const reservation of budget.reservations.filter((r) => r.scenario === scenario))
      reservation.state = `observed-${row.finalStatus}`;
    persistBudget();
  }
} catch (error) {
  row.passed = false;
  row.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await merchant?.stop();
  globalThis.fetch = originalFetch;
  row.finishedAt = new Date().toISOString();
  evidence.cases.push(row);
  evidence.requestCount = budget.requests;
  evidence.authorizationsReserved = budget.reservations.length;
  evidence.atomicReserved = budget.reservations
    .reduce((n, r) => n + BigInt(r.atomic), 0n)
    .toString();
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  closeSync(lockFd);
  unlinkSync(lock);
  console.log(JSON.stringify(row));
}
