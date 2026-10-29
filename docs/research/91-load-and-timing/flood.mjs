// DRAFT, not run. The generator for steps 4 and 5 of ../91-load-and-timing.md.
//
//   FLOOD_MODE=unpaid  unpaid purchase requests at one card, above its
//                      merchant's price gate (four at once, sixteen a second,
//                      sixteen waiting). Local stack only: it refuses any
//                      address but a local one.
//   FLOOD_MODE=junk    payments whose signature is random bytes, each against a
//                      price of its own, so that they wait in the lane for
//                      payments nobody can vouch for and are refused there. Test
//                      channel only, by the owner's agreement: the local
//                      sandbox facilitator verifies any payment and would admit
//                      a junk one as a pretend sale.
//
// Junk payments are built by the official x402 client from real challenges of
// a fixed-price card, which ask no merchant and cost nothing, signed by a
// throwaway key that holds nothing, and then given random signature bytes.
// Each takes a price of its own because the gateway checks one payment per
// price at a time and answers the rest 409 before any lane. JUNK_PAYERS=one
// keeps the throwaway's address as every payment's payer, which meets the
// bound of one place and one place in line per payer; JUNK_PAYERS=fresh names
// a new address in each.
//
// Guards, because the target is shared: refuses without
// AGENTIFY_LOAD_CONFIRM=1, and junk mode without AGENTIFY_JUNK_AGREED=1 too;
// caps concurrency, rate, duration and the number of junk payments; and stops
// early on a rising share of 5xx answers, and in junk mode at the first answer
// that is neither seller_busy nor a refusal of the payment. Never point it at
// the WooCommerce lab shop or at merchant B.

// This draft lives under docs/, which is no package, so it names the client
// packages it runs against rather than declaring them; it is run from the
// run's private folder, where they are installed from npm.
// biome-ignore lint/correctness/noUndeclaredDependencies: a docs draft run where the packages are installed
import { x402Client, x402HTTPClient } from "@x402/core/client";
// biome-ignore lint/correctness/noUndeclaredDependencies: a docs draft run where the packages are installed
import { registerExactEvmScheme } from "@x402/evm/exact/client";
// biome-ignore lint/correctness/noUndeclaredDependencies: a docs draft run where the packages are installed
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const env = process.env;
if (env.AGENTIFY_LOAD_CONFIRM !== "1") {
  throw new Error("This is a draft. Set AGENTIFY_LOAD_CONFIRM=1 only inside an agreed window.");
}
if (!env.AGENTIFY_URL || !env.FLOOD_ITEM_ID) {
  throw new Error("Needs AGENTIFY_URL and FLOOD_ITEM_ID, a card of merchant A.");
}
const mode = env.FLOOD_MODE === "junk" ? "junk" : "unpaid";
const site = new URL(env.AGENTIFY_URL);
const local =
  ["localhost", "127.0.0.1", "[::1]"].includes(site.hostname) ||
  site.hostname.endsWith(".localhost") ||
  site.hostname.endsWith(".test");
if (mode === "unpaid" && !local) {
  throw new Error(
    "The unpaid flood runs on the local stack only; AGENTIFY_URL is not a local address.",
  );
}
if (mode === "junk" && (local || env.AGENTIFY_JUNK_AGREED !== "1")) {
  throw new Error(
    "Junk payments run on the test channel only, with AGENTIFY_JUNK_AGREED=1 once the owner has agreed the window.",
  );
}

const CONCURRENCY = Math.min(
  Number(env.FLOOD_CONCURRENCY ?? (mode === "junk" ? 10 : 30)),
  mode === "junk" ? 10 : 40,
);
const PER_SECOND = Math.min(Number(env.FLOOD_RATE ?? 30), 40);
const DURATION_MS =
  Math.min(Number(env.FLOOD_SECONDS ?? (mode === "junk" ? 30 : 60)), mode === "junk" ? 30 : 60) *
  1000;
const JUNK_AT_MOST = Math.min(Number(env.JUNK_PAYMENTS ?? 300), 300);
const STOP_5XX_SHARE = 0.2;

const url = `${site.origin}/x402/${encodeURIComponent(env.FLOOD_ITEM_ID)}/purchase`;
const asJson = { "content-type": "application/json", accept: "application/json" };
const body = env.PURCHASE_BODY ?? JSON.stringify({ params: {} });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomHex = (bytes) =>
  `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex")}`;

const answers = {};
let fivexx = 0;
let total = 0;
let stopReason = null;

/** Junk payments, each against a fresh price of its own, built before the burst starts. */
async function junkPayments() {
  const throwaway = privateKeyToAccount(generatePrivateKey());
  const core = new x402Client();
  registerExactEvmScheme(core, { signer: throwaway });
  const http = new x402HTTPClient(core);
  const headers = [];
  // Asked at most ten a second, well inside a price's three minutes for 300.
  while (headers.length < JUNK_AT_MOST) {
    const response = await fetch(url, { method: "POST", headers: asJson, body });
    const text = await response.text();
    if (response.status !== 402)
      throw new Error(
        `The card answered ${response.status} to an unpaid request; nothing was sent.`,
      );
    const challenge = http.getPaymentRequiredResponse(
      (name) => response.headers.get(name),
      JSON.parse(text),
    );
    const payment = await http.createPaymentPayload(challenge);
    payment.payload.signature = randomHex(65);
    if (env.JUNK_PAYERS === "fresh") {
      payment.payload.authorization.from = privateKeyToAccount(generatePrivateKey()).address;
    }
    headers.push(http.encodePaymentSignatureHeader(payment));
    await pause(100);
  }
  return headers;
}

const junk = mode === "junk" ? await junkPayments() : [];

async function oneCall() {
  const payment = mode === "junk" ? junk.pop() : {};
  if (payment === undefined) {
    stopReason ??= "every junk payment was sent";
    return;
  }
  try {
    const response = await fetch(url, { method: "POST", headers: { ...asJson, ...payment }, body });
    const text = await response.text();
    const code = text.match(/"code"\s*:\s*"([a-z_]+)"/)?.[1] ?? "";
    const key = `${response.status} ${code}`.trim();
    answers[key] = (answers[key] ?? 0) + 1;
    total += 1;
    if (response.status >= 500) fivexx += 1;
    if (total > 20 && fivexx / total > STOP_5XX_SHARE)
      stopReason ??= "more than a fifth of answers were 5xx";
    if (mode === "junk" && code !== "seller_busy" && code !== "payment_not_verified") {
      stopReason ??= `an answer this burst does not expect: ${key}`;
    }
  } catch {
    answers.network = (answers.network ?? 0) + 1;
  }
}

const started = Date.now();
const workers = Array.from({ length: CONCURRENCY }, async () => {
  while (stopReason === null && Date.now() - started < DURATION_MS) {
    await oneCall();
    await pause((CONCURRENCY / PER_SECOND) * 1000);
  }
});
await Promise.all(workers);
console.log(
  JSON.stringify(
    {
      mode,
      item: env.FLOOD_ITEM_ID,
      seconds: (Date.now() - started) / 1000,
      total,
      answers,
      stopReason,
    },
    null,
    2,
  ),
);
