/**
 * The smoke command: the same buyer and mock merchant as the offline suite,
 * against a gateway wired to the real x402 facilitator on the Base Sepolia
 * testnet, where a purchase moves real testnet USDC.
 *
 * It never runs from `pnpm test`. It touches the network and, with
 * `--confirm`, makes a real transfer of testnet money, so it is fenced behind
 * explicit intent and a spending cap, and by default it is a dry run that stops
 * before anything is signed. Each safeguard below refuses the run outright
 * rather than proceeding on a guess.
 *
 * The facilitator is real: it verifies and settles against Base Sepolia through
 * the CDP endpoint with the credentials in the environment. The store and the
 * queue are in memory, so nothing the run writes outlives the process. The
 * buyer's key is read from the environment, never printed and never written
 * down.
 *
 *   AGENTIFY_SMOKE=1 SMOKE_BUYER_KEY=0x… SMOKE_PAY_TO=0x… pnpm smoke
 *   AGENTIFY_SMOKE=1 SMOKE_BUYER_KEY=0x… SMOKE_PAY_TO=0x… \
 *     CDP_API_KEY_ID=… CDP_API_KEY_SECRET=… pnpm smoke --confirm
 *
 * PAYMENT_RPC_URL optionally selects a dedicated read-only Base Sepolia RPC.
 *
 * The first is a dry run: it boots the gateway, publishes the card, reads the
 * real payment challenge and prints exactly what a payment would be, then stops
 * without signing. The second, with credentials and the flag, executes one real
 * testnet settlement.
 */

import { CDP_FACILITATOR_URL, isTestnetChain, PUBLIC_X402_FACILITATOR_URL } from "@agentify/core";
import {
  type Facilitator,
  type GatewayConfig,
  PaymentEdge,
  recoveryOn,
  type StoredOrder,
  X402Facilitator,
} from "@agentify/gateway";
import type { CardInput } from "@nuanu-ai/agentify-contracts";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { getDefaultAsset } from "@x402/evm";
import { type Bought, makeBuyer } from "./buyer.js";
import { EUROPE_ESIM } from "./cards.js";
import { bootGateway, sliceEnv } from "./gateway-harness.js";
import { startMerchant } from "./merchant.js";

/** Address tails that are burn holes rather than a merchant's wallet. */
const BURN_TAILS = ["dead", "beef", "0000"];

const say = (...parts: unknown[]): void => {
  console.log("[smoke]", ...parts);
};

/**
 * Refuses the run. Declared as a function rather than an arrow so its `never`
 * return narrows the flow after it — a value a gate has just refused as absent
 * is known to be present below.
 */
function die(why: string): never {
  console.error(`[smoke] REFUSED: ${why}`);
  process.exit(1);
}

/** Whether an address is a burn hole or not an address at all — never a payee. */
const isBurnAddress = (address: string): boolean => {
  const hex = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(hex)) {
    return true;
  }
  const body = hex.slice(2);
  return BURN_TAILS.some((tail) => body === "0".repeat(40 - tail.length) + tail);
};

/**
 * Why this network is not one this command may spend on, or nothing. A function
 * rather than a condition inside `main`, so that `spending-gate.test.ts` can
 * call it and prove that the places which classify a chain agree.
 */
export function whyNotThisNetwork(network: string, allowMainnet: boolean): string | null {
  if (isTestnetChain(network) || allowMainnet) {
    return null;
  }
  return `${network} is not a known testnet; real money needs an explicit SMOKE_ALLOW_MAINNET=1, which this command is not meant for`;
}

/**
 * What the smoke can say about the money after its one purchase: it settled,
 * nothing was charged, or nobody can tell from here. The third is never folded
 * into the second, because paying again after a charge whose fate is unknown
 * would be a second charge.
 */
export type PurchaseVerdict =
  | {
      readonly kind: "settled";
      readonly transaction: string;
      readonly readFrom: "answer" | "order";
    }
  | { readonly kind: "not_charged"; readonly why: string }
  | { readonly kind: "unknown"; readonly why: string };

/** Stages after which the payment layer has nothing more to say about the charge. */
const CHARGE_ANSWERED: ReadonlySet<StoredOrder["order"]["payment"]> = new Set([
  "settled",
  "settle_failed",
  "outcome_unknown",
]);

const refusalMessageIn = (body: unknown): string => {
  const error = (body as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === "string" ? error.message : JSON.stringify(body);
};

const orderIdIn = (body: unknown): string | null => {
  const id = (body as { order_id?: unknown } | null)?.order_id;
  return typeof id === "string" ? id : null;
};

/**
 * Judges the purchase from its answer and the order it opened.
 *
 * A synchronous sale carries the settlement on the answer. An asynchronous one
 * charges while the order is opened and answers with the order alone, so the
 * settlement is read from the order the in-process gateway recorded, once its
 * charge has been answered or the wait has run out.
 */
export async function verdictOnPurchase(
  bought: Pick<Bought, "status" | "body" | "settlement">,
  readOrder: (orderId: string) => Promise<StoredOrder | null>,
  { timeoutMs = 30_000, everyMs = 250 } = {},
): Promise<PurchaseVerdict> {
  const answer = bought.settlement;
  if (answer !== null) {
    return answer.success && answer.transaction !== ""
      ? { kind: "settled", transaction: answer.transaction, readFrom: "answer" }
      : { kind: "not_charged", why: `the settlement did not succeed: ${JSON.stringify(answer)}` };
  }

  const orderId = orderIdIn(bought.body);
  if (orderId === null) {
    return bought.status >= 500
      ? {
          kind: "unknown",
          why: `the gateway failed with HTTP ${bought.status} and named no order: ${refusalMessageIn(bought.body)}`,
        }
      : {
          kind: "not_charged",
          why: `the gateway refused the purchase with HTTP ${bought.status}: ${refusalMessageIn(bought.body)}`,
        };
  }

  const deadline = Date.now() + timeoutMs;
  let stored = await readOrder(orderId);
  while (stored !== null && !CHARGE_ANSWERED.has(stored.order.payment) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, everyMs));
    stored = await readOrder(orderId);
  }

  if (stored === null) {
    return {
      kind: "unknown",
      why: `the gateway holds no order ${orderId} to read the charge from`,
    };
  }
  switch (stored.order.payment) {
    case "settled":
      return stored.settlement === null || stored.settlement.transaction === ""
        ? { kind: "unknown", why: "the order reads settled but carries no transaction to check" }
        : { kind: "settled", transaction: stored.settlement.transaction, readFrom: "order" };
    case "settle_failed":
      return { kind: "not_charged", why: "the payment layer answered that the charge failed" };
    case "outcome_unknown":
      return { kind: "unknown", why: "the charge was sent and the payment layer never answered" };
    case "settling":
      return { kind: "unknown", why: `the charge was still running after ${timeoutMs} ms` };
    default:
      return {
        kind: "not_charged",
        why: `no charge was started (payment stage: ${stored.order.payment})`,
      };
  }
}

/** The real facilitator, built from the loaded config exactly as production does. */
export async function realFacilitator(config: GatewayConfig): Promise<Facilitator> {
  const edge = new PaymentEdge(config);
  const { cdpApiKeyId, cdpApiKeySecret } = config.payment;
  const client = new HTTPFacilitatorClient({
    url: config.payment.facilitatorUrl,
    ...(cdpApiKeyId === null || cdpApiKeySecret === null
      ? {}
      : {
          createAuthHeaders: async () => {
            const headers = {
              "CDP-Api-Key-Id": cdpApiKeyId,
              "CDP-Api-Key-Secret": cdpApiKeySecret,
            };
            return { verify: headers, settle: headers, supported: headers };
          },
        }),
  });
  const started = await recoveryOn(config.payment.network, config.payment.rpcUrl);
  console.log(started.said);
  return new X402Facilitator(client, edge, started.recovery);
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm") || process.env.SMOKE_CONFIRM === "1";
  const mode = confirm ? "LIVE (--confirm): one real testnet settlement" : "dry run (no payment)";

  // --- the gates: any one of them refuses the run ---------------------------

  if (process.env.AGENTIFY_SMOKE !== "1") {
    die(
      "set AGENTIFY_SMOKE=1 to run the smoke — it touches the network and, with --confirm, moves testnet money",
    );
  }

  const buyerKey = process.env.SMOKE_BUYER_KEY ?? process.env.BUYER_PRIVATE_KEY;
  if (buyerKey === undefined) {
    die(
      "set SMOKE_BUYER_KEY to a throwaway testnet wallet key — there is nothing to pay with otherwise",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(buyerKey)) {
    die("SMOKE_BUYER_KEY is not a private key (expected 0x followed by 64 hex characters)");
  }

  const payTo = process.env.SMOKE_PAY_TO;
  if (payTo === undefined) {
    die(
      "set SMOKE_PAY_TO to the merchant's testnet address — the money has nowhere to go otherwise",
    );
  }
  if (isBurnAddress(payTo)) {
    die(`SMOKE_PAY_TO ${payTo} is not a payable address (it is malformed or a known burn address)`);
  }

  const network = process.env.SMOKE_NETWORK ?? "eip155:84532";
  const whyNot = whyNotThisNetwork(network, process.env.SMOKE_ALLOW_MAINNET === "1");
  if (whyNot !== null) {
    die(whyNot);
  }

  const maxUsd = Number(process.env.SMOKE_MAX_USD ?? "0.05");
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) {
    die("SMOKE_MAX_USD must be a positive number of dollars");
  }

  const priceUsd = process.env.SMOKE_PRICE_USD ?? "0.01";
  if (!/^\d+(?:\.\d+)?$/.test(priceUsd) || Number(priceUsd) > maxUsd) {
    die(
      `SMOKE_PRICE_USD ${priceUsd} is either not an amount or above the SMOKE_MAX_USD cap of ${maxUsd}`,
    );
  }

  const cdpApiKeyId = process.env.CDP_API_KEY_ID;
  const cdpApiKeySecret = process.env.CDP_API_KEY_SECRET;
  const haveCdp = cdpApiKeyId !== undefined && cdpApiKeySecret !== undefined;
  if (confirm && !haveCdp) {
    die(
      "--confirm needs CDP_API_KEY_ID and CDP_API_KEY_SECRET for the facilitator to verify and settle on Base Sepolia",
    );
  }

  const facilitatorUrl =
    process.env.SMOKE_FACILITATOR_URL ??
    (haveCdp ? CDP_FACILITATOR_URL : PUBLIC_X402_FACILITATOR_URL);

  // --- boot the real gateway and publish the card ---------------------------

  const env = sliceEnv({
    PAY_TO_ADDRESS: payTo,
    PAYMENT_NETWORK: network,
    ...(process.env.PAYMENT_RPC_URL === undefined
      ? {}
      : { PAYMENT_RPC_URL: process.env.PAYMENT_RPC_URL }),
    FACILITATOR_URL: facilitatorUrl,
    ...(haveCdp ? { CDP_API_KEY_ID: cdpApiKeyId, CDP_API_KEY_SECRET: cdpApiKeySecret } : {}),
  });

  const booted = await bootGateway(realFacilitator, env);
  // The key this boot seeded, taken from the boot itself rather than spelled
  // here: its prefix follows the chain the smoke was pointed at, so a string
  // written into this file would be right on Base Sepolia and refused above the
  // lookup the day somebody set SMOKE_NETWORK to mainnet.
  const merchant = startMerchant(booted.baseUrl, booted.merchantKey);
  await merchant.start();
  const buyer = makeBuyer({ baseUrl: booted.baseUrl, privateKey: buyerKey, maxUsd });

  // A cheap asynchronous eSIM: the money moves at the purchase in one
  // settlement, so a single paid call is the whole of what the smoke has to do.
  // Same merchant_item_id as the catalog eSIM, so the mock merchant's own
  // handler answers it; only the price is the testnet one.
  const smokeCard: CardInput = { ...EUROPE_ESIM, price: { amount: priceUsd, currency: "USD" } };

  try {
    const published = await merchant.client.catalog.publish(smokeCard);
    if (!published.ok) {
      die(
        `the gateway refused the smoke card (${published.error.code}): ${JSON.stringify(published.error.problems)}`,
      );
    }

    const catalog = await buyer.catalog();
    const listing = catalog.find((card) => card.title === smokeCard.title);
    if (listing === undefined) {
      die("the smoke card did not appear in the catalog it was just published to");
      return;
    }

    // Read the real challenge without paying: it names the amount, the asset and
    // the address a payment would go to.
    const challenge = await buyer.challenge(listing);
    const requirement = challenge.accepts[0];
    if (requirement === undefined) {
      die("the payment challenge carried no payment options");
      return;
    }

    const asset = getDefaultAsset(network as `${string}:${string}`);
    const decimals =
      asset.asset.toLowerCase() === requirement.asset.toLowerCase() ? asset.decimals : null;
    const amountUsd = decimals === null ? null : Number(requirement.amount) / 10 ** decimals;

    say(`mode: ${mode}`);
    say(
      `gateway: ${booted.baseUrl} (in-process; in-memory store and queue; REAL x402 facilitator)`,
    );
    say(`facilitator: ${facilitatorUrl} (CDP credentials ${haveCdp ? "present" : "absent"})`);
    say(`buyer wallet: ${buyer.address} (public address; the key is never printed)`);
    say(`product: ${listing.title} — catalog id ${listing.id}`);
    say(
      `challenge: pay ${requirement.amount} ${requirement.asset} ` +
        `(= ${amountUsd === null ? "?" : `$${amountUsd}`} ${asset.symbol}) ` +
        `to ${requirement.payTo} on ${requirement.network}, valid for ${requirement.maxTimeoutSeconds}s`,
    );
    say(`spending cap: $${maxUsd} per payment (enforced by the buyer's own x402 client)`);

    if (amountUsd !== null && amountUsd > maxUsd) {
      die(`the challenge asks $${amountUsd}, above the SMOKE_MAX_USD cap of $${maxUsd}`);
    }

    if (!confirm) {
      say("DRY RUN: every safeguard passed and NOTHING was signed. No money moved.");
      say(
        "To execute one real Base Sepolia USDC transfer, re-run the same command with --confirm.",
      );
      return;
    }

    // Refuse rather than trust the buyer's client cap alone. If the challenge's
    // asset is not the one this network's default table knows, the dollar amount
    // could not be read above, and paying then would be paying an amount this
    // command could not check.
    if (amountUsd === null) {
      die(
        `could not read the challenge amount in dollars (asset ${requirement.asset} is not ${asset.symbol} on ${network}), so it cannot be checked against the cap`,
      );
    }

    // --- the one real paid call (only under --confirm) ----------------------
    say("--confirm: signing and settling one real testnet payment now.");
    const bought = await buyer.buy(listing, { email: "smoke@example.com" });
    say(`HTTP ${bought.status}`);
    say(`resource answered: ${JSON.stringify(bought.body)}`);
    if (bought.settlement !== null) {
      say(`settlement on the answer: ${JSON.stringify(bought.settlement)}`);
    }
    const verdict = await verdictOnPurchase(bought, (id) =>
      booted.gateway.runtime.store.orderById(id),
    );
    switch (verdict.kind) {
      case "not_charged":
        die(`nothing was charged: ${verdict.why}`);
        break;
      case "unknown":
        die(
          `whether money moved is not known: ${verdict.why}. Check the buyer's wallet before running again.`,
        );
        break;
      case "settled":
        say(`settled: transaction ${verdict.transaction} (read from the ${verdict.readFrom})`);
        if (bought.status !== 200) {
          die(
            `the charge settled, so the money moved, but the purchase answered HTTP ${bought.status}`,
          );
        }
        say("done: one real testnet settlement went through.");
    }
  } finally {
    await merchant.stop();
    await booted.stop();
  }
}

// The run starts only where somebody typed the command. `spending-gate.test.ts`
// imports this file, and a run that began on import would refuse at its first
// gate and take the importing process down through the exit below.
//
// `import.meta.main` needs Node 24.2 or later, which the repository's
// `engines.node` (`>=24.21`) covers: earlier versions read `undefined`, and
// this command would print nothing, exit 0 and look like a run that went fine.
if (import.meta.main) {
  main().catch((error: unknown) => {
    // The message only, never the whole error object: a payment client's error
    // can carry request details in tow, and the buyer's key is not something to
    // risk printing even by accident.
    console.error(
      `[smoke] the smoke command failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
