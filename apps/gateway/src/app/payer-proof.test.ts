/**
 * What a payment proves of its payer before the payment layer is asked,
 * which decides where it waits: a wallet's own key, and what it holds.
 */
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { PaymentEdge } from "../http/x402.js";
import { testConfig } from "../testing/harness.js";
import { aWallet, signedPayment } from "../testing/signed-payment.js";
import { PayerReads, payerOf } from "./payer-proof.js";

const PAY_TO = "0x0000000000000000000000000000000000000001";
const requirements: PaymentRequirements = new PaymentEdge(testConfig()).requirementsFor(
  { amount: "80.00", currency: "USD" },
  "a-stamped-price",
  PAY_TO,
);
const BUYER = aWallet("the buyer");
const signed = (signature?: `0x${string}`) =>
  signedPayment(BUYER, requirements, {
    nonce: "0x01",
    validBefore: 1_800_000_000_000,
    ...(signature === undefined ? {} : { signature }),
  });

describe("what a payment proves of its payer", () => {
  it("names the wallet whose own key signed it", async () => {
    expect(await payerOf(await signed(), requirements)).toMatchObject({
      signedByKey: true,
      wallet: BUYER.address,
      lowS: true,
      validAfter: 0n,
    });
  });

  it("says a signature is the high-s copy of one its key made", async () => {
    const honest = JSON.parse(Buffer.from(await signed(), "base64").toString()) as {
      payload: { signature: string };
    };
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const sig = honest.payload.signature;
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const v = Number.parseInt(sig.slice(130, 132), 16);
    const flipped = `0x${sig.slice(2, 66)}${(n - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}`;

    expect(await payerOf(await signed(flipped as `0x${string}`), requirements)).toMatchObject({
      signedByKey: true,
      wallet: BUYER.address,
      lowS: false,
    });
  });

  it.each([
    ["noise in a signature's length", `0x${"5a".repeat(65)}`],
    ["a wrapped signature, as an undeployed contract wallet sends", `0x${"ab".repeat(200)}`],
    ["no signature at all, as a contract wallet may accept", "0x"],
  ] as const)("names only the wallet it claims for %s", async (_what, signature) => {
    expect(await payerOf(await signed(signature), requirements)).toMatchObject({
      signedByKey: false,
      claimed: BUYER.address.toLowerCase(),
    });
  });

  it("names only the wallet it claims for a signature another key made over the same terms", async () => {
    const other = await signedPayment(aWallet("somebody else"), requirements, {
      nonce: "0x01",
      validBefore: 1_800_000_000_000,
    });
    const theirs = JSON.parse(Buffer.from(other, "base64").toString()) as {
      payload: { signature: `0x${string}` };
    };
    expect(await payerOf(await signed(theirs.payload.signature), requirements)).toMatchObject({
      signedByKey: false,
    });
  });

  it("names one stand-in for every payment that names no wallet at all", async () => {
    expect(await payerOf("not a payment header", requirements)).toStrictEqual({
      signedByKey: false,
      claimed: "unidentified",
      validAfter: null,
    });
  });
});

describe("a payer's wallet as read from the chain", () => {
  /** A chain whose answers a test sets, counting reads and holding them where asked. */
  const aChain = () => {
    const chain = {
      reads: 0,
      held: 5n as bigint | Error,
      gate: null as Promise<void> | null,
      async balance(): Promise<bigint> {
        throw new Error("not asked here");
      },
      async payerState(): Promise<{ held: bigint; used: boolean }> {
        chain.reads += 1;
        if (chain.gate !== null) await chain.gate;
        if (chain.held instanceof Error) throw chain.held;
        return { held: chain.held, used: false };
      },
    };
    return chain;
  };

  it("asks the chain once for the same authorization asked about at once", async () => {
    const chain = aChain();
    const reads = new PayerReads(
      () => chain,
      () => 0,
    );

    const both = await Promise.all([
      reads.stateOf("mch_a", "0xtoken", "0xwallet", "0x01", 1n),
      reads.stateOf("mch_a", "0xtoken", "0xwallet", "0x01", 1n),
    ]);

    expect(both).toStrictEqual([
      { held: 5n, used: false },
      { held: 5n, used: false },
    ]);
    expect(chain.reads).toBe(1);
  });

  it("reads a few wallets at a time for one merchant, and turns the rest to no answer", async () => {
    const chain = aChain();
    let open!: () => void;
    chain.gate = new Promise((resolve) => {
      open = resolve;
    });
    const reads = new PayerReads(
      () => chain,
      () => 0,
    );
    const asked = Array.from({ length: 12 }, (_, one) =>
      reads.stateOf("mch_a", "0xtoken", `0xwallet${one}`, "0x01", 1n),
    );
    const elsewhere = reads.stateOf("mch_b", "0xtoken", "0xwallet", "0x01", 1n);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chain.reads).toBeLessThan(12);
    expect(chain.reads).toBeGreaterThan(1);
    open();
    expect(await elsewhere).toStrictEqual({ held: 5n, used: false });
    expect((await Promise.all(asked)).filter((state) => state === null).length).toBeGreaterThan(0);
  });

  it("keeps a balance that covers the price for a few seconds, and never one that does not", async () => {
    const chain = aChain();
    let now = 0;
    const reads = new PayerReads(
      () => chain,
      () => now,
    );

    chain.held = 0n;
    expect(await reads.stateOf("mch_a", "0xtoken", "0xwallet", "0x01", 1n)).toMatchObject({
      held: 0n,
    });
    chain.held = 9n;
    expect(await reads.stateOf("mch_a", "0xtoken", "0xwallet", "0x02", 1n)).toMatchObject({
      held: 9n,
    });
    chain.held = 0n;
    expect(await reads.stateOf("mch_a", "0xtoken", "0xwallet", "0x03", 1n)).toMatchObject({
      held: 9n,
    });
    now += 5_000;
    expect(await reads.stateOf("mch_a", "0xtoken", "0xwallet", "0x04", 1n)).toMatchObject({
      held: 0n,
    });
    expect(chain.reads).toBe(3);
  });

  it("answers nothing for a read that failed or a chain that is not configured", async () => {
    const chain = aChain();
    chain.held = new Error("the chain endpoint did not answer");

    expect(
      await new PayerReads(
        () => chain,
        () => 0,
      ).stateOf("m", "t", "w", "0x01", 1n),
    ).toBeNull();
    expect(
      await new PayerReads(
        () => undefined,
        () => 0,
      ).stateOf("m", "t", "w", "0x01", 1n),
    ).toBeNull();
  });

  it("keeps a bounded number of wallets, letting the oldest go first", async () => {
    const chain = aChain();
    const reads = new PayerReads(
      () => chain,
      () => 0,
    );
    for (let one = 0; one <= 1_024; one += 1)
      await reads.stateOf("mch_a", "0xtoken", `0xwallet${one}`, "0x01", 1n);
    const before = chain.reads;

    await reads.stateOf("mch_a", "0xtoken", "0xwallet1024", "0x02", 1n);
    expect(chain.reads).toBe(before);
    await reads.stateOf("mch_a", "0xtoken", "0xwallet0", "0x02", 1n);
    expect(chain.reads).toBe(before + 1);
  });
});
