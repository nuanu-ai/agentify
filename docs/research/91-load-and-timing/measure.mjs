// DRAFT, not run. The client-side harness for step 1 of ../91-load-and-timing.md.
//
// It times every HTTP call it makes and records the status, the Retry-After it
// was given and the retries it made. The x402 client signs an EIP-3009
// authorisation without reading the chain, so this harness makes no chain read
// and none can land in an endpoint figure; the per-phase split comes from the
// gateway's histograms and settlement landing from the database and the chain,
// both read apart from this. It drives the official x402 client as
// packages/slice/src/stand-buyer.ts does, so no protocol bytes are written by hand.
//
//   MODE=unpaid  unpaid purchase requests for ITEM_ID (SAMPLES, default 100)
//   MODE=paid    whole purchases of ITEM_ID (SAMPLES, default 6); needs
//                BUYER_PRIVATE_KEY, MAX_USD per purchase and MAX_TOTAL_USD
//   MODE=status  reads of STATUS_URL (SAMPLES, default 100)
//
// SPACING_MS waits between samples: 6000 for a WooCommerce card, whose
// connector keeps a product read for five seconds. PURCHASE_BODY is the JSON
// a purchase sends, by default {"params":{}}.
//
// Refuses to start without AGENTIFY_LOAD_CONFIRM=1. The signer key and the
// status address are read from the environment and never written or logged:
// a status address opens its order's goods. Writes one JSON file, mode 600, in
// the current directory, which belongs in the run's private folder.

import { writeFileSync } from "node:fs";
// This draft lives under docs/, which is no package, so it names the client
// packages it runs against rather than declaring them; it is run from the
// run's private folder, where they are installed from npm.
// biome-ignore lint/correctness/noUndeclaredDependencies: a docs draft run where the packages are installed
import { x402Client, x402HTTPClient } from "@x402/core/client";
// biome-ignore lint/correctness/noUndeclaredDependencies: a docs draft run where the packages are installed
import { registerExactEvmScheme } from "@x402/evm/exact/client";
// biome-ignore lint/correctness/noUndeclaredDependencies: a docs draft run where the packages are installed
import { privateKeyToAccount } from "viem/accounts";

const env = process.env;
if (env.AGENTIFY_LOAD_CONFIRM !== "1") {
  throw new Error("This is a draft. Set AGENTIFY_LOAD_CONFIRM=1 only inside an agreed window.");
}
const mode = env.MODE ?? "unpaid";
if (!["unpaid", "paid", "status"].includes(mode))
  throw new Error("MODE is unpaid, paid or status.");
const samples = Number.parseInt(env.SAMPLES ?? (mode === "paid" ? "6" : "100"), 10);
const spacingMs = Number.parseInt(env.SPACING_MS ?? "0", 10);
const RETRIES_AT_MOST = 5;

const dollars = (text) => (/^\d+(\.\d+)?$/.test(text ?? "") ? Number(text) : 0);
const calls = []; // { call, ms, status, retryAfter }
const purchases = []; // { ms, status, retries }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One HTTP call, timed from the request to the last byte of its body. */
const timed = async (call, url, init) => {
  const started = performance.now();
  const response = await fetch(url, init);
  const text = await response.text();
  const retryAfter = response.headers.get("retry-after");
  calls.push({ call, ms: performance.now() - started, status: response.status, retryAfter });
  return { response, text, retryAfter };
};

/** Sends the same request again after each 429, as the gateway's Retry-After asks. */
const withRetries = async (call, url, init) => {
  let retries = 0;
  let answer = await timed(call, url, init);
  while (answer.response.status === 429 && retries < RETRIES_AT_MOST) {
    await pause(Number(answer.retryAfter ?? "2") * 1000);
    retries += 1;
    answer = await timed(call, url, init);
  }
  return { answer, retries };
};

const purchaseUrl = () => {
  if (!env.AGENTIFY_URL || !env.ITEM_ID) throw new Error("Needs AGENTIFY_URL and ITEM_ID.");
  return `${env.AGENTIFY_URL.replace(/\/+$/, "")}/x402/${encodeURIComponent(env.ITEM_ID)}/purchase`;
};
const body = env.PURCHASE_BODY ?? JSON.stringify({ params: {} });
const asJson = { "content-type": "application/json", accept: "application/json" };

async function unpaid() {
  const url = purchaseUrl();
  for (let i = 0; i < samples; i += 1) {
    await timed("unpaid", url, { method: "POST", headers: asJson, body });
    await pause(spacingMs);
  }
}

async function status() {
  if (!env.STATUS_URL) throw new Error("Needs STATUS_URL.");
  for (let i = 0; i < samples; i += 1) {
    await timed("status", env.STATUS_URL, { headers: { accept: "application/json" } });
    await pause(spacingMs);
  }
}

async function paid() {
  const perPurchase = dollars(env.MAX_USD);
  const total = dollars(env.MAX_TOTAL_USD);
  if (!env.BUYER_PRIVATE_KEY || perPurchase <= 0 || total <= 0) {
    throw new Error("A paid run needs BUYER_PRIVATE_KEY, MAX_USD and MAX_TOTAL_USD.");
  }
  const url = purchaseUrl();
  const core = new x402Client();
  registerExactEvmScheme(core, { signer: privateKeyToAccount(env.BUYER_PRIVATE_KEY) });
  core.setSpendControls({ maxAmountPerPayment: `$${env.MAX_USD}` });
  const http = new x402HTTPClient(core);
  for (let i = 0; i < samples; i += 1) {
    // Counted at the per-purchase cap, so the total cannot be passed whatever the prices.
    if ((purchases.length + 1) * perPurchase > total) break;
    const started = performance.now();
    const asked = await withRetries("price", url, { method: "POST", headers: asJson, body });
    if (asked.answer.response.status !== 402) {
      purchases.push({
        ms: performance.now() - started,
        status: asked.answer.response.status,
        retries: asked.retries,
      });
      continue;
    }
    const challenge = http.getPaymentRequiredResponse(
      (name) => asked.answer.response.headers.get(name),
      JSON.parse(asked.answer.text),
    );
    const payment = http.encodePaymentSignatureHeader(await http.createPaymentPayload(challenge));
    const paidFor = await withRetries("pay", url, {
      method: "POST",
      headers: { ...asJson, ...payment },
      body,
    });
    purchases.push({
      ms: performance.now() - started,
      status: paidFor.answer.response.status,
      retries: asked.retries + paidFor.retries,
    });
    await pause(spacingMs);
  }
}

if (mode === "unpaid") await unpaid();
else if (mode === "status") await status();
else await paid();

const summary = (rows) => {
  const ms = rows.map((row) => row.ms).sort((a, b) => a - b);
  const at = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
  const statuses = {};
  for (const row of rows) statuses[row.status] = (statuses[row.status] ?? 0) + 1;
  return { count: ms.length, p50_ms: at(0.5), p95_ms: at(0.95), max_ms: ms.at(-1), statuses };
};
const kinds = {};
for (const call of calls) {
  kinds[call.call] ??= [];
  kinds[call.call].push(call);
}
const out = {
  mode,
  item: env.ITEM_ID ?? null,
  calls: Object.fromEntries(Object.entries(kinds).map(([kind, rows]) => [kind, summary(rows)])),
  purchases: purchases.length === 0 ? null : summary(purchases),
  retries: purchases.reduce((sum, row) => sum + row.retries, 0),
  every_call: calls,
};
const file = `measure-${mode}-${Date.now()}.json`;
writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o600 });
console.log(file);
