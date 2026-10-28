/**
 * The quickstart's test buyer, `apps/docs/programs/buyer.mts`, run the way a
 * reader runs it: copied into a directory of its own beside a `.env`, and
 * started with `node --env-file=.env buyer.mts`. The page shows that very
 * file, so what passes here is what a merchant's engineer copies.
 *
 * The program buys from the real gateway on its real HTTP surface, booted in
 * this process with an in-memory store and a scripted facilitator, from a
 * merchant on the real SDK. `buyer-program-faults.ts` keeps every call on this
 * machine, shortens the program's waits between reads and can move a payment
 * request onto another chain.
 *
 * Each test holds one promise the page makes to the person running it: the
 * first run makes a wallet key and buys nothing, the next one ends in the
 * goods or in the merchant's own answer, and the program signs only on the
 * channel's chain and up to the card's price.
 */

import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptedFacilitator } from "@agentify/gateway";
import { type AgentifyClient, createClient, type LiveOrder } from "@nuanu-ai/agentify";
import type { CardInput } from "@nuanu-ai/agentify-contracts";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Booted, bootGateway } from "./gateway-harness.js";

const PROGRAM = fileURLToPath(new URL("../../../apps/docs/programs/buyer.mts", import.meta.url));
const FAULTS = fileURLToPath(new URL("./buyer-program-faults.ts", import.meta.url));
/** The x402 client and viem the program imports, at the release this package installs. */
const MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));

/** A key made for this run, so that no key sits in the repository. */
const TEST_BUYER_KEY = generatePrivateKey();

/** The card the quickstart publishes on its third step, sold at once. */
const AT_ONCE = {
  merchant_item_id: "access-monthly",
  title: "One month of access to the service",
  description: "What the buyer gets, what it is good for, and what is not included.",
  price: "5.00 USD",
  params: { email: { type: "string", required: true, title: "Where to send it" } },
  result: { access_url: "string" },
} satisfies CardInput;

/** The same card delivered later, as the quickstart's asynchronous handler does. */
const LATER = {
  ...AT_ONCE,
  merchant_item_id: "access-monthly-later",
  fulfillment: "async",
} satisfies CardInput;

/** The same card with its price asked at purchase, which answers more than the card says. */
const PRICED = {
  ...AT_ONCE,
  merchant_item_id: "access-monthly-priced",
  price_check: "handler",
} satisfies CardInput;

/** The same card, which the merchant refuses: the quickstart's out-of-stock answer. */
const REFUSED = {
  ...AT_ONCE,
  merchant_item_id: "access-monthly-refused",
} satisfies CardInput;

const goodsOf = (orderId: string) => ({ access_url: `https://example.com/a/${orderId}` });

interface Faults {
  readonly challengeNetwork?: string;
  readonly challengeAsset?: string;
  readonly waitMs?: number;
}

interface Run {
  readonly code: number | null;
  readonly printed: string;
}

describe("the quickstart's test buyer", () => {
  let facilitator: ScriptedFacilitator;
  let booted: Booted;
  let merchant: AgentifyClient;
  let directory: string;
  const held = new Map<string, LiveOrder>();
  const ids = new Map<string, string>();

  beforeEach(async () => {
    facilitator = new ScriptedFacilitator();
    booted = await bootGateway(() => facilitator);
    merchant = createClient({ apiKey: booted.merchantKey, baseUrl: booted.baseUrl });
    held.clear();
    merchant.on("order", (order) => {
      if (order.merchant_item_id === REFUSED.merchant_item_id) {
        return order.refused({ code: "out_of_stock", message: "No seats left on that plan" });
      }
      if (order.merchant_item_id === LATER.merchant_item_id) {
        held.set(order.id, order);
        return order.accepted();
      }
      return order.delivered(goodsOf(order.id));
    });
    merchant.on("quote", (question) => question.available({ amount: "6.00", currency: "USD" }));
    await merchant.start();
    for (const card of [AT_ONCE, LATER, PRICED, REFUSED]) {
      const published = await merchant.catalog.publish(card);
      if (!published.ok) throw new Error(JSON.stringify(published.error));
      ids.set(card.merchant_item_id, published.id);
    }

    directory = mkdtempSync(join(tmpdir(), "agentify-buyer-"));
    copyFileSync(PROGRAM, join(directory, "buyer.mts"));
    symlinkSync(MODULES, join(directory, "node_modules"));
  });

  afterEach(async () => {
    rmSync(directory, { recursive: true, force: true });
    try {
      await merchant.stop();
    } finally {
      await booted.stop();
    }
  });

  /**
   * Runs the program as the quickstart says to, buying the named card, with
   * `.env` holding what the quickstart puts there unless `env` says otherwise;
   * a value of `null` leaves that line out.
   */
  const run = async (
    card: CardInput,
    faults: Faults = {},
    env: Readonly<Record<string, string | null>> = {},
  ): Promise<Run> => {
    const lines = {
      AGENTIFY_URL: booted.baseUrl,
      BUYER_PRIVATE_KEY: TEST_BUYER_KEY,
      ITEM_ID: ids.get(card.merchant_item_id) ?? "",
      ...env,
    };
    await writeFile(
      join(directory, ".env"),
      Object.entries(lines)
        .flatMap(([name, value]) => (value === null ? [] : [`${name}=${value}`]))
        .join("\n"),
    );
    const child = spawn(process.execPath, ["--import", FAULTS, "--env-file=.env", "buyer.mts"], {
      cwd: directory,
      env: { BUYER_FAULTS: JSON.stringify(faults) },
    });
    let printed = "";
    child.stdout.on("data", (chunk) => {
      printed += chunk;
    });
    child.stderr.on("data", (chunk) => {
      printed += chunk;
    });
    const code = await new Promise<number | null>((done) => child.on("close", done));
    return { code, printed };
  };

  /**
   * The one order the merchant took on. The merchant's subscription polls, so
   * the order reaches the merchant some time after the purchase answers; it is
   * waited for rather than expected at once.
   */
  const onlyHeld = async (): Promise<LiveOrder> => {
    for (let waited = 0; held.size === 0 && waited < 10_000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [order, ...others] = held.values();
    if (order === undefined || others.length > 0) {
      throw new Error(`the merchant holds ${held.size} orders, not one`);
    }
    return order;
  };

  it("makes a wallet key when .env has none, buys nothing, and buys with the line it printed", async () => {
    const first = await run(AT_ONCE, {}, { BUYER_PRIVATE_KEY: null });

    expect(first.code, first.printed).toBe(0);
    const key = /^BUYER_PRIVATE_KEY=(0x[0-9a-f]{64})$/m.exec(first.printed)?.[1] as
      | `0x${string}`
      | undefined;
    expect(key, first.printed).toBeDefined();
    // The faucet funds the address printed, so it has to be the key's own.
    expect(first.printed).toContain(privateKeyToAccount(key ?? "0x").address);
    expect(await merchant.orders.list()).toHaveLength(0);

    const bought = await run(AT_ONCE, {}, { BUYER_PRIVATE_KEY: key ?? null });
    expect(bought.code, bought.printed).toBe(0);
    expect(bought.printed).toMatch(/https:\/\/example\.com\/a\/\S+/);
  });

  it("buys a card priced above 1 USD and prints its goods", async () => {
    const bought = await run(AT_ONCE);

    expect(bought.code, bought.printed).toBe(0);
    expect(bought.printed).toMatch(/https:\/\/example\.com\/a\/\S+/);
    expect(bought.printed).toContain('"delivered"');
    expect(facilitator.settles).toHaveLength(1);
  });

  it("reads an asynchronous order at its address until the goods arrive", async () => {
    // Waits long enough between reads for the merchant to take the order and deliver.
    const running = run(LATER, { waitMs: 1_000 });
    const order = await onlyHeld();
    await order.deliver(goodsOf(order.id));
    const finished = await running;

    expect(finished.code, finished.printed).toBe(0);
    expect(finished.printed).toContain(goodsOf(order.id).access_url);
    expect(facilitator.settles).toHaveLength(1);
  });

  it("prints the merchant's refusal and charges nothing", async () => {
    const refused = await run(REFUSED);

    expect(refused.printed).toContain("out_of_stock");
    expect(facilitator.settles).toHaveLength(0);
  });

  it("signs no payment request on a chain other than the channel's", async () => {
    // Base and its USDC, a chain and a token the x402 client would otherwise
    // sign for within the card's price.
    const refused = await run(AT_ONCE, {
      challengeNetwork: "eip155:8453",
      challengeAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    });

    expect(refused.code, refused.printed).not.toBe(0);
    expect(refused.printed).toContain("eip155:8453");
    expect(facilitator.verifies).toHaveLength(0);
  });

  it("signs no payment for more than the card's price", async () => {
    const refused = await run(PRICED);

    expect(refused.code, refused.printed).not.toBe(0);
    expect(facilitator.verifies).toHaveLength(0);
  });

  it("is installed at the release of the x402 client and viem it is tested with", () => {
    // The page's install line would otherwise take whatever npm has today,
    // and a reader would run a program nobody ran.
    const tested = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { devDependencies: Record<string, string> };
    const quickstart = readFileSync(
      fileURLToPath(new URL("../../../apps/docs/quickstart.md", import.meta.url)),
      "utf8",
    );
    const installed = /^npm install (@x402\/\S+ .*)$/m.exec(quickstart)?.[1]?.split(" ") ?? [];

    expect(installed.sort()).toStrictEqual(
      ["@x402/evm", "@x402/fetch", "viem"]
        .map((name) => `${name}@${tested.devDependencies[name]}`)
        .sort(),
    );
  });
});
