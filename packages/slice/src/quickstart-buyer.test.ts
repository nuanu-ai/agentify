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
 * and makes the program's waits between reads take a millisecond.
 *
 * Each test holds one promise the page makes to the person running it: a
 * failed read is not an order's state, an order that has not finished can be
 * taken up again, a lost answer comes back without a second charge, and the
 * buyer signs only on the channel's chain and only up to the card's price.
 */

import { spawn } from "node:child_process";
import {
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Booted, bootGateway } from "./gateway-harness.js";

const PROGRAM = fileURLToPath(new URL("../../../apps/docs/programs/buyer.mts", import.meta.url));
const FAULTS = fileURLToPath(new URL("./buyer-program-faults.ts", import.meta.url));
/** The x402 client and viem the program imports, at the release this package installs. */
const MODULES = fileURLToPath(new URL("../node_modules", import.meta.url));

/** The same valueless local-devnet key the rest of the slice signs with. */
const TEST_BUYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

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

/** A second valueless local-devnet key, a wallet other than the one that paid. */
const OTHER_BUYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

/** What the fault preload prints for each read of an order it lets through. */
const READ_MARK = "[faults] order read";

const goodsOf = (orderId: string) => ({ access_url: `https://example.com/a/${orderId}` });

interface Faults {
  readonly statusReads?: readonly number[];
  readonly losePaidAnswer?: boolean;
  readonly challengeNetwork?: string;
  readonly challengeAsset?: string;
}

interface Run {
  readonly code: number | null;
  readonly printed: string;
}

/** What the program keeps beside itself, as far as these tests read it. */
interface Kept {
  readonly challenge?: unknown;
  readonly payment?: unknown;
  readonly status_url?: string;
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

  const readsIn = (printed: string): number => printed.split(READ_MARK).length - 1;

  const kept = (): Kept | null => {
    const file = join(directory, "purchase.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Kept) : null;
  };

  const onlyHeld = (): LiveOrder => {
    const [order, ...others] = held.values();
    if (order === undefined || others.length > 0) {
      throw new Error(`the merchant holds ${held.size} orders, not one`);
    }
    return order;
  };

  it("stops reading an order still in_progress with its address kept, and finishes it on the next run without buying again", async () => {
    const waiting = await run(LATER);

    expect(waiting.code, waiting.printed).not.toBe(0);
    const statusUrl = kept()?.status_url;
    expect(statusUrl, waiting.printed).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/x402\/orders\//);
    // The address opens the order, so it is kept in the file and not printed.
    expect(waiting.printed).not.toContain(statusUrl);

    const order = onlyHeld();
    await order.deliver(goodsOf(order.id));
    const finished = await run(LATER);

    expect(finished.code, finished.printed).toBe(0);
    expect(finished.printed).toContain(goodsOf(order.id).access_url);
    expect(facilitator.settles).toHaveLength(1);
    expect(held.size).toBe(1);
  });

  it("tells a read that failed from the order's state, and reads again until it has one", async () => {
    await run(LATER);
    const order = onlyHeld();
    await order.deliver(goodsOf(order.id));

    // Every read fails: the run does not finish, and it names no state.
    const unread = await run(LATER, { statusReads: Array(100).fill(503) });

    expect(unread.code, unread.printed).not.toBe(0);
    expect(unread.printed).toContain("503");
    expect(unread.printed).not.toContain(goodsOf(order.id).access_url);
    expect(unread.printed).not.toContain("undefined");
    const statusUrl = kept()?.status_url;
    expect(statusUrl).toBeDefined();
    expect(unread.printed).not.toContain(statusUrl);

    // One read fails: the next one is the order.
    const recovered = await run(LATER, { statusReads: [503] });

    expect(recovered.code, recovered.printed).toBe(0);
    expect(recovered.printed).toContain("503");
    expect(recovered.printed).toContain(goodsOf(order.id).access_url);
  });

  it("keeps the payment request and the signed payment before paying, and gets a lost answer back without a second charge", async () => {
    const lost = await run(AT_ONCE, { losePaidAnswer: true });

    expect(lost.code, lost.printed).not.toBe(0);
    expect(kept()?.challenge, lost.printed).toBeDefined();
    expect(kept()?.payment).toBeDefined();
    expect(kept()?.status_url).toBeUndefined();
    expect(statSync(join(directory, "purchase.json")).mode & 0o777).toBe(0o600);
    expect(facilitator.settles).toHaveLength(1);

    const recovered = await run(AT_ONCE);

    expect(recovered.code, recovered.printed).toBe(0);
    expect(recovered.printed).toMatch(/https:\/\/example\.com\/a\/\S+/);
    expect(kept()?.status_url).toBeDefined();
    expect(facilitator.verifies).toHaveLength(1);
    expect(facilitator.settles).toHaveLength(1);

    // The negative control: without the kept file the program buys again, and
    // this test sees that second charge.
    rmSync(join(directory, "purchase.json"));
    const again = await run(AT_ONCE);

    expect(again.code, again.printed).toBe(0);
    expect(facilitator.settles).toHaveLength(2);
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
    expect(kept()).toBeNull();
    expect(facilitator.verifies).toHaveLength(0);
  });

  it("signs no payment for more than the card's price", async () => {
    const refused = await run(PRICED);

    expect(refused.code, refused.printed).not.toBe(0);
    expect(kept()).toBeNull();
    expect(facilitator.verifies).toHaveLength(0);

    // The same purchase at the card's own price goes through.
    const bought = await run(AT_ONCE);

    expect(bought.code, bought.printed).toBe(0);
    expect(facilitator.settles).toHaveLength(1);
  });
  it("keeps the order a refused purchase answers with, prints no address, and only reads it on the next run", async () => {
    const refused = await run(REFUSED);

    expect(refused.code, refused.printed).not.toBe(0);
    expect(refused.printed).toContain("out_of_stock");
    const statusUrl = kept()?.status_url;
    expect(statusUrl, refused.printed).toBeDefined();
    expect(refused.printed).not.toContain(statusUrl);
    const signed = kept()?.payment;

    const again = await run(REFUSED);

    expect(again.code, again.printed).not.toBe(0);
    expect(readsIn(again.printed)).toBe(1);
    expect(kept()?.payment).toStrictEqual(signed);
    expect(facilitator.verifies).toHaveLength(1);
    expect(facilitator.settles).toHaveLength(0);
  });

  it("reads on while nobody knows whether the charge went through, and never signs again for it", async () => {
    facilitator.willSettle({ settled: "unknown", reason: "the payment network did not answer" });

    const unknown = await run(AT_ONCE);

    expect(unknown.code, unknown.printed).not.toBe(0);
    expect(readsIn(unknown.printed)).toBeGreaterThan(1);
    expect(kept()?.status_url).toBeDefined();

    await run(AT_ONCE);

    expect(facilitator.verifies).toHaveLength(1);
    expect(facilitator.settles).toHaveLength(1);
  });

  it("pays the kept request again when the charge for goods already made failed, and gets the goods", async () => {
    facilitator.willSettle(
      { settled: false, reason: "the wallet did not hold the price" },
      { settled: true, transaction: "0xtx2" },
    );

    const unpaid = await run(AT_ONCE);

    expect(unpaid.code, unpaid.printed).not.toBe(0);
    expect(kept()?.status_url).toBeDefined();
    expect(facilitator.settles).toHaveLength(1);

    const paid = await run(AT_ONCE);

    expect(paid.code, paid.printed).toBe(0);
    expect(paid.printed).toMatch(/https:\/\/example\.com\/a\/\S+/);
    expect(facilitator.settles).toHaveLength(2);
  });

  it("keeps the purchase when paying again for goods already made is refused, and gets them once the wallet can pay", async () => {
    facilitator.willSettle(
      { settled: false, reason: "the wallet did not hold the price" },
      { settled: true, transaction: "0xtx2" },
    );
    await run(AT_ONCE);
    facilitator.willRefuseVerification("insufficient_funds", "the wallet does not hold the price");

    const refused = await run(AT_ONCE);

    expect(refused.code, refused.printed).not.toBe(0);
    // The goods are held for this purchase, so the reader is not sent to buy again.
    expect(refused.printed).not.toMatch(/delete/i);
    expect(kept()?.status_url).toBeDefined();

    facilitator.willVerify();
    const paid = await run(AT_ONCE);

    expect(paid.code, paid.printed).toBe(0);
    expect(paid.printed).toMatch(/https:\/\/example\.com\/a\/\S+/);
    expect(facilitator.settles).toHaveLength(2);
  });

  it("does not sign the kept payment request from a wallet other than the one that signed it", async () => {
    await run(AT_ONCE, { losePaidAnswer: true });
    const signed = kept()?.payment;

    const other = await run(AT_ONCE, {}, { BUYER_PRIVATE_KEY: OTHER_BUYER_KEY });

    expect(other.code, other.printed).not.toBe(0);
    expect(kept()?.payment).toStrictEqual(signed);
    expect(facilitator.verifies).toHaveLength(1);
  });

  it.each([
    ["no wallet key", { BUYER_PRIVATE_KEY: null }],
    ["a wallet key that is not one", { BUYER_PRIVATE_KEY: "0x1234" }],
    ["no card", { ITEM_ID: null }],
    ["no channel", { AGENTIFY_URL: null }],
    ["a channel that does not answer", { AGENTIFY_URL: "http://127.0.0.1:9" }],
  ])("stops in plain words, without a stack trace, given %s", async (_what, env) => {
    const stopped = await run(AT_ONCE, {}, env);

    expect(stopped.code, stopped.printed).not.toBe(0);
    expect(stopped.printed).not.toMatch(/^\s+at /m);
    expect(stopped.printed).not.toContain("undefined");
    expect(kept()).toBeNull();
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
