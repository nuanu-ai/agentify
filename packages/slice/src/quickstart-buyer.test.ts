/**
 * The quickstart's test buyer, `apps/docs/programs/buyer.mts`, run the way a
 * reader runs it: copied into a directory of its own beside a `.env`, and
 * started with `node --env-file=.env buyer.mts`. The page shows that very
 * file, so what passes here is what a merchant's engineer copies.
 *
 * The program buys from the real gateway on its real HTTP surface, booted in
 * this process with an in-memory store and a scripted facilitator, from a
 * merchant on the real SDK. The network between them breaks the way
 * `buyer-program-faults.ts` says, which also keeps every call on this machine
 * and shortens the program's waits between reads.
 *
 * Each test holds one promise the page makes to the person running it: a
 * purchase ends in the goods or in plain words and a non-zero exit, the
 * order's address is kept in a file and never printed, a failed read is not
 * an order's state, and the buyer signs once, only on the channel's chain and
 * only up to the card's price.
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptedFacilitator } from "@agentify/gateway";
import { type AgentifyClient, createClient, type LiveOrder } from "@nuanu-ai/agentify";
import type { CardInput } from "@nuanu-ai/agentify-contracts";
import { generatePrivateKey } from "viem/accounts";
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

/** The file the program writes each order's address to, beside itself. */
const PURCHASE = "purchase.json";

/** What the fault preload prints for each read of an order it lets through. */
const READ_MARK = "[faults] order read";

const goodsOf = (orderId: string) => ({ access_url: `https://example.com/a/${orderId}` });

interface Faults {
  readonly statusReads?: readonly number[];
  readonly losePaidAnswer?: boolean;
  readonly challengeNetwork?: string;
  readonly challengeAsset?: string;
  readonly waitMs?: number;
  readonly stopBeforePayment?: boolean;
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
    file = PURCHASE,
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
    const child = spawn(process.execPath, ["--import", FAULTS, "--env-file=.env", "buyer.mts", file], {
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

  const readsIn = (printed: string): number => printed.split(READ_MARK).length - 1;

  /** The order's address as the program wrote it, or undefined where it wrote none. */
  const keptAddress = (): string | undefined => {
    const file = join(directory, PURCHASE);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).statusUrl : undefined;
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

  it("delivers the goods of a synchronous purchase and keeps the order's address in a file only its owner reads", async () => {
    const bought = await run(AT_ONCE);

    expect(bought.code, bought.printed).toBe(0);
    expect(bought.printed).toMatch(/https:\/\/example\.com\/a\/\S+/);
    const statusUrl = keptAddress();
    expect(statusUrl, bought.printed).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/x402\/orders\//);
    // The address opens the order, so it is kept in the file and not printed.
    expect(bought.printed).not.toContain(statusUrl);
    expect(statSync(join(directory, PURCHASE)).mode & 0o777).toBe(0o600);
    expect(facilitator.settles).toHaveLength(1);
  });

  it("reads an asynchronous order at its address until the goods arrive", async () => {
    // Waits long enough between reads for the merchant to take the order and deliver.
    const running = run(LATER, { waitMs: 200 });
    const order = await onlyHeld();
    await order.deliver(goodsOf(order.id));
    const finished = await running;

    expect(finished.code, finished.printed).toBe(0);
    expect(finished.printed).toContain(goodsOf(order.id).access_url);
    expect(readsIn(finished.printed)).toBeGreaterThan(0);
    expect(finished.printed).not.toContain(keptAddress());
    expect(facilitator.settles).toHaveLength(1);
  });

  it("stops when the reads run out, with the order's address kept and not printed", async () => {
    const waiting = await run(LATER);

    expect(waiting.code, waiting.printed).not.toBe(0);
    expect(readsIn(waiting.printed)).toBe(60);
    expect(waiting.printed).toContain(PURCHASE);
    const statusUrl = keptAddress();
    expect(statusUrl, waiting.printed).toBeDefined();
    expect(waiting.printed).not.toContain(statusUrl);
  });

  it("keeps the order a refused purchase answers with a 409, prints no address and exits non-zero", async () => {
    const refused = await run(REFUSED);

    expect(refused.code, refused.printed).not.toBe(0);
    expect(refused.printed).toContain("out_of_stock");
    expect(refused.printed).toContain(PURCHASE);
    const statusUrl = keptAddress();
    expect(statusUrl, refused.printed).toBeDefined();
    expect(refused.printed).not.toContain(statusUrl);
    expect(facilitator.settles).toHaveLength(0);
  });

  it("reports a read of the order that failed and reads on until the goods arrive", async () => {
    const running = run(LATER, { statusReads: [503], waitMs: 200 });
    const order = await onlyHeld();
    await order.deliver(goodsOf(order.id));
    const finished = await running;

    expect(finished.code, finished.printed).toBe(0);
    expect(finished.printed).toContain("503");
    expect(finished.printed).toContain(goodsOf(order.id).access_url);
    expect(finished.printed).not.toContain(keptAddress());
  });

  it("stops with the order's address kept and not printed when every read fails", async () => {
    const unread = await run(LATER, { statusReads: Array(60).fill(503) });

    expect(unread.code, unread.printed).not.toBe(0);
    expect(unread.printed).toContain("503");
    expect(unread.printed).toContain(ADDRESSES);
    expect(readsIn(unread.printed)).toBe(0);
    const statusUrl = keptAddress();
    expect(statusUrl, unread.printed).toBeDefined();
    expect(unread.printed).not.toContain(statusUrl);
  });

  it.each([
    [
      "the charge for goods already made failed",
      { settled: false, reason: "the wallet did not hold the price" },
    ],
    [
      "nobody knows whether the charge went through",
      { settled: "unknown", reason: "the payment network did not answer" },
    ],
  ] as const)("signs once and stops when %s", async (_what, settlement) => {
    facilitator.willSettle(settlement);

    const stopped = await run(AT_ONCE);

    expect(stopped.code, stopped.printed).not.toBe(0);
    expect(stopped.printed).toContain(PURCHASE);
    expect(keptAddress()).toBeDefined();
    expect(facilitator.verifies).toHaveLength(1);
    expect(facilitator.settles).toHaveLength(1);
  });

  it("resumes a paid purchase after losing its answer and restarting, without another order or charge", async () => {
    const lost = await run(AT_ONCE, { losePaidAnswer: true });

    expect(lost.code, lost.printed).not.toBe(0);
    expect(keptAddress()).toBeUndefined();
    expect(facilitator.verifies).toHaveLength(1);
    expect(facilitator.settles).toHaveLength(1);
    const orderId = facilitator.settles[0]?.orderId;
    const resumed = await run(AT_ONCE);
    expect(resumed.code, resumed.printed).toBe(0);
    expect(resumed.printed).toContain(goodsOf(orderId ?? "").access_url);
    expect(keptAddress()).toBeDefined();
    expect(facilitator.settles).toHaveLength(1);
    expect(await merchant.orders.list()).toHaveLength(1);
  });

  it("reads the saved order after its card leaves the catalog", async () => {
    const bought = await run(AT_ONCE);
    const address = keptAddress();
    expect(bought.code, bought.printed).toBe(0);
    await fetch(`${booted.baseUrl}/v0/cards/${ids.get(AT_ONCE.merchant_item_id)}/pause`, {
      method: "POST",
      headers: { authorization: `Bearer ${booted.merchantKey}` },
    });
    const resumed = await run(AT_ONCE);
    expect(resumed.code, resumed.printed).toBe(0);
    expect(keptAddress()).toBe(address);
    expect(facilitator.verifies).toHaveLength(1);
    expect(facilitator.settles).toHaveLength(1);
    expect(await merchant.orders.list()).toHaveLength(1);
  });

  it("starts a distinct purchase only when given a different file and keeps the first purchase", async () => {
    const first = await run(AT_ONCE);
    expect(first.code, first.printed).toBe(0);
    const saved = readFileSync(join(directory, PURCHASE), "utf8");
    const second = await run(AT_ONCE, {}, {}, "second-purchase.json");
    expect(second.code, second.printed).toBe(0);
    expect(readFileSync(join(directory, PURCHASE), "utf8")).toBe(saved);
    expect(facilitator.settles).toHaveLength(2);
    expect(await merchant.orders.list()).toHaveLength(2);
  });

  it("pays nothing when its purchase cannot be saved", async () => {
    const stopped = await run(AT_ONCE, {}, {}, "missing/purchase.json");
    expect(stopped.code, stopped.printed).not.toBe(0);
    expect(facilitator.verifies).toHaveLength(0);
    expect(facilitator.settles).toHaveLength(0);
  });

  it("refuses a damaged purchase file before opening or paying an order", async () => {
    await writeFile(join(directory, PURCHASE), "{broken");
    const stopped = await run(AT_ONCE);
    expect(stopped.code, stopped.printed).not.toBe(0);
    expect(await merchant.orders.list()).toHaveLength(0);
    expect(facilitator.settles).toHaveLength(0);
    expect(readFileSync(join(directory, PURCHASE), "utf8")).toBe("{broken");
  });

  it.each([
    ["wallet", { BUYER_PRIVATE_KEY: generatePrivateKey() }],
    ["site", { AGENTIFY_URL: "http://127.0.0.1:9" }],
    ["product", { ITEM_ID: "item_another" }],
  ])("does not spend or replace a saved purchase after its %s changes", async (_what, env) => {
    await run(AT_ONCE, { losePaidAnswer: true });
    const saved = readFileSync(join(directory, PURCHASE), "utf8");
    const stopped = await run(AT_ONCE, {}, env);
    expect(stopped.code, stopped.printed).not.toBe(0);
    expect(facilitator.settles).toHaveLength(1);
    expect(await merchant.orders.list()).toHaveLength(1);
    expect(readFileSync(join(directory, PURCHASE), "utf8")).toBe(saved);
  });

  it("does not start another purchase while the original payment outcome is unknown", async () => {
    facilitator.willSettle({ settled: "unknown", reason: "the payment network did not answer" });
    await run(AT_ONCE, { losePaidAnswer: true });
    const stopped = await run(AT_ONCE);
    expect(stopped.code, stopped.printed).not.toBe(0);
    expect(facilitator.settles).toHaveLength(1);
    expect(await merchant.orders.list()).toHaveLength(1);
  });

  it("does not replace an expired saved price with a new purchase", async () => {
    const stopped = await run(AT_ONCE, { stopBeforePayment: true });
    expect(stopped.code, stopped.printed).not.toBe(0);
    const [order] = await merchant.orders.list();
    if (!order) throw new Error("the price request must have opened an order");
    const saved = await booted.gateway.orderById(order.id);
    if (!saved) throw new Error("the order must still be held");
    await booted.gateway.runner.apply(order.id, {
      kind: "deadline_expired",
      deadline: "quote_expiry",
      at: (saved.order.timestamps.quotedAt ?? 0) + saved.order.policy.deadlines.quoteTtlMs,
    });
    const resumed = await run(AT_ONCE);
    expect(resumed.code, resumed.printed).not.toBe(0);
    expect(facilitator.verifies).toHaveLength(0);
    expect(facilitator.settles).toHaveLength(0);
    expect(await merchant.orders.list()).toHaveLength(1);
  });

  it("makes an existing readable purchase file private before using it", async () => {
    await run(AT_ONCE);
    chmodSync(join(directory, PURCHASE), 0o644);
    const resumed = await run(AT_ONCE);
    expect(resumed.code, resumed.printed).toBe(0);
    expect(statSync(join(directory, PURCHASE)).mode & 0o777).toBe(0o600);
    expect(facilitator.settles).toHaveLength(1);
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
    expect(keptAddress()).toBeUndefined();
    expect(facilitator.verifies).toHaveLength(0);
  });

  it("signs no payment for more than the card's price", async () => {
    const refused = await run(PRICED);

    expect(refused.code, refused.printed).not.toBe(0);
    expect(keptAddress()).toBeUndefined();
    expect(facilitator.verifies).toHaveLength(0);
  });

  it.each([
    ["no wallet key", { BUYER_PRIVATE_KEY: null }],
    ["no card", { ITEM_ID: null }],
    ["no channel", { AGENTIFY_URL: null }],
    ["a channel that does not answer", { AGENTIFY_URL: "http://127.0.0.1:9" }],
  ])("stops in plain words, without a stack trace, given %s", async (_what, env) => {
    const stopped = await run(AT_ONCE, {}, env);

    expect(stopped.code, stopped.printed).not.toBe(0);
    expect(stopped.printed).not.toMatch(/^\s+at /m);
    expect(stopped.printed).not.toContain("undefined");
    expect(keptAddress()).toBeUndefined();
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
    const installed = /^npm install (@x402\/core\S*.*)$/m.exec(quickstart)?.[1]?.split(" ") ?? [];

    expect(installed.sort()).toStrictEqual(
      ["@x402/core", "@x402/evm", "viem"]
        .map((name) => `${name}@${tested.devDependencies[name]}`)
        .sort(),
    );
  });
});
