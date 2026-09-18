/**
 * The acceptance buyer is tested without a network or a funded wallet.
 *
 * These tests stop immediately before the one operation that can spend test
 * funds and replace it with a counted fake. They prove the durable gates that
 * have to survive a process restart: exact challenge ownership, the two caps,
 * one explicit signature, and the narrower recovery door.
 */

import type { PaymentRequired } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import {
  type AcceptanceFiles,
  BASE_SEPOLIA,
  BASE_SEPOLIA_USDC,
  type BuyerFactory,
  runAcceptanceBuyer,
  TEST_GATEWAY,
} from "./acceptance-buyer-command.js";
import type { Answered, StandBuyer } from "./stand-buyer.js";

const BUYER_KEY = `0x${"11".repeat(32)}`;
const BUYER = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";
const PAYEE = "0x784D1234567890123456789012345678901234Ac";
const ITEM = "item_acceptance";
const ORDER = "ord_acceptance";
const LEDGER = "/safe/acceptance-attempts.json";
const PARAMS = "/safe/params.json";

const challenge = (over: Record<string, unknown> = {}): PaymentRequired =>
  ({
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: BASE_SEPOLIA,
        amount: "10000",
        asset: BASE_SEPOLIA_USDC,
        payTo: PAYEE,
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2", order_id: ORDER },
      },
    ],
    resource: {
      url: `${TEST_GATEWAY}/x402/${ITEM}/purchase`,
      description: "A controlled TEST-only artifact.",
      mimeType: "application/json",
      serviceName: "Agentify SDK acceptance",
    },
    extensions: {},
    ...over,
  }) as PaymentRequired;

const probe = (held = challenge()): PaymentRequired => {
  const copy = structuredClone(held);
  const first = copy.accepts[0];
  if (first !== undefined) {
    const extra = { ...(first.extra as Record<string, unknown>) };
    delete extra.order_id;
    first.extra = extra;
  }
  return { ...copy, error: "This resource requires payment" };
};

const status = (word: string): Answered => ({
  status: 200,
  body: {
    order_id: ORDER,
    status: word,
    price: { amount: "0.01", currency: "USD", at: "2026-09-18T09:00:00Z" },
    delivered: word === "delivered" ? { artifact_id: "agt_test_one" } : null,
    test: true,
  },
  challenge: null,
  settlement: null,
});

const deliveredUnpaid: Answered = status("delivered_unpaid");
const delivered: Answered = {
  ...status("delivered"),
  settlement: { success: true, transaction: `0x${"ab".repeat(32)}`, network: BASE_SEPOLIA },
};

class MemoryFiles implements AcceptanceFiles {
  readonly documents = new Map<string, unknown>([[PARAMS, { request_nonce: "acceptance-1" }]]);
  locked = false;

  async readJson(path: string): Promise<unknown | null> {
    return structuredClone(this.documents.get(path) ?? null);
  }

  async writeJson(path: string, value: unknown): Promise<void> {
    this.documents.set(path, structuredClone(value));
  }

  async lockedBy<T>(_path: string, work: () => Promise<T>): Promise<T> {
    if (this.locked) throw new Error("the acceptance ledger is locked by another process");
    this.locked = true;
    try {
      return await work();
    } finally {
      this.locked = false;
    }
  }
}

interface FakeOptions {
  readonly opened?: Answered;
  readonly paid?: Answered | Error;
  readonly standing?: Answered;
  readonly current?: PaymentRequired;
  readonly address?: string;
}

function fakeBuyer(options: FakeOptions = {}) {
  const calls = { opened: 0, paid: 0, status: 0, probe: 0 };
  const buyer: StandBuyer = {
    address: options.address ?? BUYER,
    catalog: async () => [],
    askPrice: async () => {
      calls.probe += 1;
      return { status: 402, body: {}, challenge: options.current ?? probe(), settlement: null };
    },
    startPurchase: async () => {
      calls.opened += 1;
      return (
        options.opened ?? {
          status: 402,
          body: {},
          challenge: challenge(),
          settlement: null,
        }
      );
    },
    payFor: async () => {
      calls.paid += 1;
      if (options.paid instanceof Error) throw options.paid;
      return options.paid ?? deliveredUnpaid;
    },
    payBadly: async () => ({ status: 400, body: {}, challenge: null, settlement: null }),
    status: async () => {
      calls.status += 1;
      return options.standing ?? deliveredUnpaid;
    },
    purchasePath: (itemId) => `/x402/${itemId}/purchase`,
  };
  const outside: BuyerFactory = () => buyer;
  return { outside, calls };
}

const environment = (over: Record<string, string | undefined> = {}) => ({
  AGENTIFY_ACCEPTANCE: "1",
  ACCEPTANCE_BUYER_KEY: BUYER_KEY,
  ...over,
});

const openArgs = [
  "open",
  "--ledger",
  LEDGER,
  "--item",
  ITEM,
  "--params",
  PARAMS,
  "--confirm",
];

function aRun(options: FakeOptions = {}, files = new MemoryFiles()) {
  const said: string[] = [];
  const fake = fakeBuyer(options);
  const run = (argv: readonly string[], env = environment()) =>
    runAcceptanceBuyer(argv, env, fake.outside, files, (line) => said.push(line), () =>
      new Date("2026-09-18T09:00:00Z"),
    );
  return { ...fake, files, run, text: () => said.join("\n") };
}

async function openedRun(options: FakeOptions = {}) {
  const one = aRun(options);
  expect(await one.run(openArgs)).toBe(0);
  return one;
}

describe("opening the exact order challenge", () => {
  it("persists the challenge and order without signing anything", async () => {
    const one = await openedRun();

    expect(one.calls.opened).toBe(1);
    expect(one.calls.paid).toBe(0);
    expect(one.files.documents.get(LEDGER)).toMatchObject({
      version: 1,
      base_url: TEST_GATEWAY,
      buyer: BUYER,
      attempts: [
        {
          number: 1,
          item_id: ITEM,
          order_id: ORDER,
          state: "challenged",
          amount_atomic: "10000",
          challenge: challenge(),
        },
      ],
    });
    expect(one.text()).toContain("persisted");
    expect(one.text()).toContain("nothing was signed");
    expect(one.text()).not.toContain(BUYER_KEY);
  });

  it.each([
    ["mainnet", { network: "eip155:8453" }],
    ["another asset", { asset: "0x0000000000000000000000000000000000000001" }],
    ["more than one cent", { amount: "10001" }],
    ["self payment", { payTo: BUYER }],
  ])("refuses %s before a ledger is created", async (_name, changed) => {
    const held = challenge({ accepts: [{ ...challenge().accepts[0], ...changed }] });
    const one = aRun({ opened: { status: 402, body: {}, challenge: held, settlement: null } });

    expect(await one.run(openArgs)).toBe(2);
    expect(one.files.documents.has(LEDGER)).toBe(false);
    expect(one.calls.paid).toBe(0);
  });
});

describe("one explicitly confirmed payment", () => {
  it("records delivered_unpaid so a later recovery can name the same order", async () => {
    const one = await openedRun();

    expect(await one.run(["pay", "--ledger", LEDGER, "--attempt", "1", "--confirm"])).toBe(1);

    expect(one.calls.paid).toBe(1);
    expect(one.files.documents.get(LEDGER)).toMatchObject({
      attempts: [{ number: 1, state: "delivered_unpaid", order_id: ORDER }],
    });
  });

  it("does not sign without confirm", async () => {
    const one = await openedRun();

    expect(await one.run(["pay", "--ledger", LEDGER, "--attempt", "1"])).toBe(2);
    expect(one.calls.paid).toBe(0);
    expect(one.files.documents.get(LEDGER)).toMatchObject({
      attempts: [{ state: "challenged" }],
    });
  });

  it("leaves an unanswered signed call counted and refuses to call it a failure", async () => {
    const one = await openedRun({ paid: new Error("connection vanished") });

    expect(await one.run(["pay", "--ledger", LEDGER, "--attempt", "1", "--confirm"])).toBe(3);
    expect(one.files.documents.get(LEDGER)).toMatchObject({
      attempts: [{ state: "unresolved" }],
    });
    expect(one.text()).toMatch(/whether.*charged.*unknown/i);
  });
});

describe("same-order recovery", () => {
  it("makes one fresh payment call after status and challenge equivalence are proved", async () => {
    const one = await openedRun({ paid: delivered });
    expect(await one.run(["pay", "--ledger", LEDGER, "--attempt", "1", "--confirm"])).toBe(0);

    // Make the first attempt the recoverable failure while leaving the fake's
    // next answer as the successful recovery.
    const ledger = one.files.documents.get(LEDGER) as { attempts: Record<string, unknown>[] };
    ledger.attempts[0] = { ...ledger.attempts[0], state: "delivered_unpaid" };
    one.files.documents.set(LEDGER, ledger);

    expect(
      await one.run([
        "recover",
        "--ledger",
        LEDGER,
        "--order",
        ORDER,
        "--worker-off",
        "--confirm",
      ]),
    ).toBe(0);

    expect(one.calls.status).toBe(1);
    expect(one.calls.probe).toBe(1);
    expect(one.calls.paid).toBe(2);
    expect(one.files.documents.get(LEDGER)).toMatchObject({
      attempts: [
        { number: 1, state: "delivered_unpaid" },
        { number: 2, state: "delivered", recovery_of: ORDER },
      ],
    });
  });

  it.each([
    ["worker assertion", []],
    ["confirmation", ["--worker-off"]],
  ])("refuses recovery without %s", async (_name, tail) => {
    const one = await openedRun();
    expect(await one.run(["pay", "--ledger", LEDGER, "--attempt", "1", "--confirm"])).toBe(1);

    expect(
      await one.run(["recover", "--ledger", LEDGER, "--order", ORDER, ...tail]),
    ).toBe(2);
    expect(one.calls.paid).toBe(1);
  });

  it("refuses when the public order is not delivered_unpaid", async () => {
    const one = await openedRun({ standing: status("delivered") });
    expect(await one.run(["pay", "--ledger", LEDGER, "--attempt", "1", "--confirm"])).toBe(1);

    expect(
      await one.run([
        "recover",
        "--ledger",
        LEDGER,
        "--order",
        ORDER,
        "--worker-off",
        "--confirm",
      ]),
    ).toBe(2);
    expect(one.calls.paid).toBe(1);
  });

  it("refuses challenge drift and a different buyer before signing", async () => {
    for (const options of [
      { current: probe(challenge({ resource: { ...challenge().resource, description: "changed" } })) },
      { address: PAYEE },
    ]) {
      const one = await openedRun(options);
      expect(await one.run(["pay", "--ledger", LEDGER, "--attempt", "1", "--confirm"])).toBe(1);

      expect(
        await one.run([
          "recover",
          "--ledger",
          LEDGER,
          "--order",
          ORDER,
          "--worker-off",
          "--confirm",
        ]),
      ).toBe(2);
      expect(one.calls.paid).toBe(1);
    }
  });

  it("counts reservations across processes and refuses the sixth cent", async () => {
    const one = await openedRun();
    expect(await one.run(["pay", "--ledger", LEDGER, "--attempt", "1", "--confirm"])).toBe(1);

    for (let expected = 2; expected <= 5; expected += 1) {
      expect(
        await one.run([
          "recover",
          "--ledger",
          LEDGER,
          "--order",
          ORDER,
          "--worker-off",
          "--confirm",
        ]),
      ).toBe(1);
      expect((one.files.documents.get(LEDGER) as { attempts: unknown[] }).attempts).toHaveLength(
        expected,
      );
    }

    expect(
      await one.run([
        "recover",
        "--ledger",
        LEDGER,
        "--order",
        ORDER,
        "--worker-off",
        "--confirm",
      ]),
    ).toBe(2);
    expect(one.calls.paid).toBe(5);
  });
});
