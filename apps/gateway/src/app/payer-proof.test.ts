/**
 * What a payment proves of its payer before the payment layer is asked,
 * which decides where it waits: a wallet's own key, and what it holds.
 */
import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { PaymentEdge } from "../http/x402.js";
import { testConfig } from "../testing/harness.js";
import { aWallet, signedPayment } from "../testing/signed-payment.js";
import { keyHolderOf, RecentBalances } from "./payer-proof.js";

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

describe("the wallet whose own key signed a payment", () => {
  it("is the wallet the payment names, where its key signed it", async () => {
    expect(await keyHolderOf(await signed(), requirements)).toBe(BUYER.address);
  });

  it.each([
    ["noise in a signature's length", `0x${"5a".repeat(65)}`],
    ["a wrapped signature, as an undeployed contract wallet sends", `0x${"ab".repeat(200)}`],
    ["no signature at all, as a contract wallet may accept", "0x"],
  ] as const)("is none for %s", async (_what, signature) => {
    expect(await keyHolderOf(await signed(signature), requirements)).toBeNull();
  });

  it("is none for a signature another key made over the same terms", async () => {
    const other = await signedPayment(aWallet("somebody else"), requirements, {
      nonce: "0x01",
      validBefore: 1_800_000_000_000,
    });
    const theirs = JSON.parse(Buffer.from(other, "base64").toString()) as {
      payload: { signature: `0x${string}` };
    };
    expect(await keyHolderOf(await signed(theirs.payload.signature), requirements)).toBeNull();
  });

  it("is none for something that is not a payment", async () => {
    expect(await keyHolderOf("not a payment header", requirements)).toBeNull();
  });
});

describe("a wallet's balance as lately read", () => {
  /** A chain whose balances a test sets, counting each read. */
  const aChain = () => {
    const chain = {
      reads: 0,
      held: 5n as bigint | Error,
      async balance(): Promise<bigint> {
        chain.reads += 1;
        if (chain.held instanceof Error) throw chain.held;
        return chain.held;
      },
    };
    return chain;
  };

  it("asks the chain once for one wallet within a few seconds, and again after", async () => {
    const chain = aChain();
    let now = 0;
    const balances = new RecentBalances(
      () => chain,
      () => now,
    );

    expect(await balances.of("0xtoken", "0xwallet")).toBe(5n);
    chain.held = 7n;
    expect(await balances.of("0xTOKEN", "0xWALLET")).toBe(5n);
    now += 5_000;
    expect(await balances.of("0xtoken", "0xwallet")).toBe(7n);
    expect(chain.reads).toBe(2);
  });

  it("answers nothing for a read that failed, and keeps nothing of it", async () => {
    const chain = aChain();
    chain.held = new Error("the chain endpoint did not answer");
    const balances = new RecentBalances(
      () => chain,
      () => 0,
    );

    expect(await balances.of("0xtoken", "0xwallet")).toBeNull();
    chain.held = 3n;
    expect(await balances.of("0xtoken", "0xwallet")).toBe(3n);
  });

  it("answers nothing where no chain is configured", async () => {
    expect(
      await new RecentBalances(
        () => undefined,
        () => 0,
      ).of("0xtoken", "0xw"),
    ).toBeNull();
  });

  it("keeps a bounded number of wallets, letting the oldest go first", async () => {
    const chain = aChain();
    const balances = new RecentBalances(
      () => chain,
      () => 0,
    );
    for (let one = 0; one <= 1_024; one += 1) await balances.of("0xtoken", `0xwallet${one}`);
    const before = chain.reads;

    await balances.of("0xtoken", "0xwallet1024");
    expect(chain.reads).toBe(before);
    await balances.of("0xtoken", "0xwallet0");
    expect(chain.reads).toBe(before + 1);
  });
});
