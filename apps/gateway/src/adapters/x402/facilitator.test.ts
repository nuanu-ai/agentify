import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { type FacilitatorClient, HTTPFacilitatorClient } from "@x402/core/server";
import {
  FacilitatorTimeoutError,
  type PaymentPayload,
  type PaymentRequirements,
  SettleError,
  type SettleResponse,
  type SupportedResponse,
  VerifyError,
  type VerifyResponse,
} from "@x402/core/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentEdge } from "../../http/x402.js";
import type { Charge } from "../../ports/facilitator.js";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "../../split/networks.js";
import { payoutSplitFor } from "../../split/parameters.js";
import { X402Facilitator } from "./facilitator.js";
import { authorizationOf, type ChainReader, Eip3009Recovery } from "./recovery.js";

/** The address the merchant behind these charges is paid at. */
const PAY_TO = "0x0000000000000000000000000000000000000001";
const PAYER = "0x0000000000000000000000000000000000000002";
const NOW_SECONDS = 1_800_000_000;
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW_SECONDS * 1000);
});
afterEach(() => {
  vi.restoreAllMocks();
});
const signed = (payTo = PAY_TO) => ({
  signature: `0x${"a".repeat(130)}`,
  authorization: {
    from: PAYER,
    to: payTo,
    value: "80000000",
    validAfter: String(NOW_SECONDS - 600),
    validBefore: String(NOW_SECONDS + 50),
    nonce: `0x${"b".repeat(64)}`,
  },
});
const chain: ChainReader = {
  networkId: async () => 84532,
  block: async () => ({
    number: 100n,
    hash: `0x${"c".repeat(64)}`,
    timestamp: BigInt(NOW_SECONDS - 20),
  }),
  authorizationState: async () => false,
  blockReceipts: async () => [],
  receipt: async () => {
    throw new Error("no transaction");
  },
};
const recovery = new Eip3009Recovery(() => chain);
const facilitatorFor = (client: FacilitatorClient, evidence = recovery) =>
  new X402Facilitator(client, evidence);

const edge = new PaymentEdge({
  payment: {
    facilitatorUrl: "https://x402.org/facilitator",
    network: "eip155:84532",
    payTo: PAY_TO,
    cdpApiKeyId: null,
    cdpApiKeySecret: null,
  },
  publicBaseUrl: "https://agentify.example",
  deadlines: { quoteTtlMs: 30_000, syncResponseMs: 10_000 },
});

/** A facilitator that answers what a test tells it to, and records what it was asked. */
class Answering implements FacilitatorClient {
  readonly asked: { payload: PaymentPayload; requirements: PaymentRequirements }[] = [];

  constructor(
    private readonly verdicts: {
      verify?: VerifyResponse | Error;
      settle?: SettleResponse | Error;
    } = {},
  ) {}

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    this.asked.push({ payload, requirements });
    const answer = this.verdicts.verify ?? { isValid: true, payer: PAYER };
    if (answer instanceof Error) throw answer;
    return answer;
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.asked.push({ payload, requirements });
    const answer =
      this.verdicts.settle ??
      ({ success: true, transaction: "0xtx", network: "eip155:84532" } as SettleResponse);
    if (answer instanceof Error) throw answer;
    return answer;
  }

  async getSupported(): Promise<SupportedResponse> {
    return { kinds: [], extensions: [], signers: {} };
  }
}

const charge = (payment: string): Charge => ({
  orderId: "ord_1",
  requirements: edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", PAY_TO),
  amount: "80.00",
  currency: "USD",
  payment,
  payTo: PAY_TO,
});

/** A payment made against exactly what this gateway would have asked for. */
const honest = (overrides: Partial<PaymentRequirements> = {}): string =>
  encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: {
      ...edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", PAY_TO),
      ...overrides,
    },
    payload: signed(),
  });

/** A charge holding the trusted stamped offer, presenting `payment`. */
const againstStamp = (stamp: string, payment: string): Charge => ({
  orderId: "ord_1",
  requirements: edge.requirementsFor({ amount: "80.00", currency: "USD" }, stamp, PAY_TO),
  amount: "80.00",
  currency: "USD",
  payment,
  payTo: PAY_TO,
});

/** A payment whose unsigned extra fields are supplied by the caller. */
const paidNaming = (named: Record<string, unknown>): string =>
  encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: {
      ...edge.requirementsFor({ amount: "80.00", currency: "USD" }, null, PAY_TO),
      extra: { name: "USDC", version: "2", ...named },
    },
    payload: signed(),
  });

/**
 * A payment naming no offer at all. The decoder is a base64 JSON parse with no
 * schema behind it, so a header shaped like this really does arrive; the cast
 * is what it takes to write down a value the type forbids and the wire allows.
 */
const namesNoOffer = (): string =>
  encodePaymentSignatureHeader({
    x402Version: 2,
    payload: signed(),
  } as unknown as PaymentPayload);

describe("a refusal that does not say why, of a payment from a wallet that cannot pay", () => {
  // The live facilitator refuses an empty wallet's payment with a code that
  // names no cause. The payer's balance, read once, says whether funding the
  // wallet is the way through.
  const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

  /** The facilitator refusing with `code`, and a chain holding `held` for the payer. */
  const refusedHolding = async (code: string | undefined, held: bigint | Error) => {
    const read: (readonly [string, string])[] = [];
    const answered = await new X402Facilitator(
      new Answering({
        verify: { isValid: false, ...(code === undefined ? {} : { invalidReason: code }) },
      }),
      recovery,
      {
        balance: async (token, wallet) => {
          read.push([token, wallet]);
          if (held instanceof Error) throw held;
          return held;
        },
        payerState: async () => {
          throw new Error("not asked by the payment layer");
        },
      },
    ).verify(charge(honest()));
    return { answered, read };
  };

  it.each([
    "invalid_exact_evm_transaction_simulation_failed",
    "a_code_nobody_has_documented",
    undefined,
  ])("names insufficient funds where the payer holds less than the price (%s)", async (code) => {
    const { answered, read } = await refusedHolding(code, 79_999_999n);

    expect(answered).toMatchObject({ verified: false, reason: "insufficient_funds" });
    expect(read).toStrictEqual([[USDC_SEPOLIA, PAYER]]);
  });

  it("keeps the cause unknown where the payer holds the price", async () => {
    const { answered } = await refusedHolding(
      "invalid_exact_evm_transaction_simulation_failed",
      80_000_000n,
    );
    expect(answered).toMatchObject({ verified: false, reason: "unexplained" });
  });

  it("keeps the cause unknown where the balance could not be read", async () => {
    const { answered } = await refusedHolding(
      "invalid_exact_evm_transaction_simulation_failed",
      new Error("the chain endpoint did not answer"),
    );
    expect(answered).toMatchObject({ verified: false, reason: "unexplained" });
  });

  it.each([
    ["invalid_exact_evm_payload_signature", { reason: "signature" }],
    ["invalid_network", { verified: "unknown", cause: "refused_agentify" }],
  ] as const)(
    "reads no balance for a refusal whose code names its cause (%s)",
    async (code, kept) => {
      const { answered, read } = await refusedHolding(code, 0n);
      expect(answered).toMatchObject(kept);
      expect(read).toStrictEqual([]);
    },
  );
});

describe("verifying a payment", () => {
  it("saves the signed recovery profile and the time the chain search starts from", async () => {
    const client = new Answering();
    const answered = await facilitatorFor(client).verify(charge(honest()));
    expect(client.asked).toHaveLength(1);
    expect(client.asked[0]?.requirements.amount).toBe("80000000");
    expect(answered).toStrictEqual({
      verified: true,
      payer: PAYER,
      validUntil: (NOW_SECONDS + 50) * 1000,
      recovery: {
        kind: "evm-exact-eip3009",
        network: "eip155:84532",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payer: PAYER,
        payTo: PAY_TO,
        amount: "80000000",
        validAfter: String(NOW_SECONDS - 600),
        validBefore: String(NOW_SECONDS + 50),
        nonce: signed().authorization.nonce,
        notBefore: String(NOW_SECONDS - 30),
      },
    });
  });

  it.each(["from", "to", "value", "validAfter", "validBefore", "nonce"])(
    "refuses a payment without signed %s before asking the facilitator",
    async (field) => {
      const payment = signed();
      delete (payment.authorization as Record<string, unknown>)[field];
      const client = new Answering();
      const answered = await facilitatorFor(client).verify(
        charge(
          encodePaymentSignatureHeader({
            x402Version: 2,
            accepted: edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", PAY_TO),
            payload: payment,
          }),
        ),
      );
      expect(answered).toMatchObject({
        verified: false,
        message: expect.stringContaining("EIP-3009"),
      });
      expect(client.asked).toHaveLength(0);
    },
  );

  it("does not accept a payment whose facilitator names a payer other than the signer", async () => {
    const other = "0x00000000000000000000000000000000000000ff";
    const answered = await facilitatorFor(
      new Answering({ verify: { isValid: true, payer: other } }),
    ).verify(charge(honest()));
    expect(answered).toMatchObject({ verified: "unknown", cause: "payer_contradicted" });
  });

  it("refuses Permit2 before verification or settlement", async () => {
    const client = new Answering();
    const payment = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", PAY_TO),
      payload: { ...signed(), permit2Authorization: {} },
    });
    const facilitator = facilitatorFor(client);
    expect(await facilitator.verify(charge(payment))).toMatchObject({
      verified: false,
      message: expect.stringContaining("Permit2"),
    });
    expect(await facilitator.settle(charge(payment))).toMatchObject({ settled: false });
    expect(client.asked).toHaveLength(0);
  });

  it.each([
    ["remains usable beyond the offered timeout", NOW_SECONDS + 81],
    ["has already expired", NOW_SECONDS],
  ])(
    "allows backdated validAfter but asks for a new signature, naming the offered timeout, when the authorization %s",
    async (_case, validBefore) => {
      const payload = {
        ...signed(),
        authorization: { ...signed().authorization, validBefore: String(validBefore) },
      };
      const client = new Answering();
      const accepted = edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", PAY_TO);
      const answered = await facilitatorFor(client).verify(
        charge(encodePaymentSignatureHeader({ x402Version: 2, accepted, payload })),
      );
      expect(answered).toMatchObject({
        verified: false,
        reason: "signature",
        message: expect.stringMatching(/\b50\s+seconds\b/),
      });
      expect(client.asked).toHaveLength(0);
    },
  );

  it("accepts an authorization expiring at the end of the offered timeout and its clock allowance", async () => {
    const accepted = edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", PAY_TO);
    expect(accepted.maxTimeoutSeconds).toBe(50);
    const payload = {
      ...signed(),
      authorization: {
        ...signed().authorization,
        validBefore: "1800000080",
      },
    };
    expect(
      await facilitatorFor(new Answering()).verify(
        charge(encodePaymentSignatureHeader({ x402Version: 2, accepted, payload })),
      ),
    ).toMatchObject({ verified: true });
  });

  it.each(["0x", `0x${"cd".repeat(1024)}`])(
    "accepts contract wallet signature bytes %s",
    async (signature) => {
      const payment = encodePaymentSignatureHeader({
        x402Version: 2,
        accepted: edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", PAY_TO),
        payload: { ...signed(), signature },
      });
      expect(await facilitatorFor(new Answering()).verify(charge(payment))).toMatchObject({
        verified: true,
      });
    },
  );

  it.each(["value", "validAfter", "validBefore"] as const)(
    "refuses an unrepresentable signed %s or a start after its end, before contacting the provider",
    async (field) => {
      const overflow = (1n << 256n).toString();
      const payload = {
        ...signed(),
        authorization: { ...signed().authorization, [field]: overflow },
      };
      const requirements = {
        ...edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", PAY_TO),
        ...(field === "value" ? { amount: overflow } : {}),
      };
      expect(() =>
        authorizationOf({ x402Version: 2, accepted: requirements, payload }, requirements),
      ).toThrow();
      if (field !== "validAfter") {
        const maximum = ((1n << 256n) - 1n).toString();
        const bounded = {
          ...payload,
          authorization: { ...payload.authorization, [field]: maximum },
        };
        const matching = { ...requirements, ...(field === "value" ? { amount: maximum } : {}) };
        expect(() =>
          authorizationOf({ x402Version: 2, accepted: matching, payload: bounded }, matching),
        ).not.toThrow();
      }
      const client = new Answering();
      expect(
        await facilitatorFor(client).verify({
          ...charge(
            encodePaymentSignatureHeader({ x402Version: 2, accepted: requirements, payload }),
          ),
          requirements,
        }),
      ).toMatchObject({ verified: false });
      expect(client.asked).toEqual([]);
    },
  );

  it.each([
    { scheme: "upto" },
    { extra: { assetTransferMethod: "permit2", price_stamp: "ord_1" } },
  ])("refuses an incompatible accepted method %j", async (overrides) => {
    expect(await facilitatorFor(new Answering()).verify(charge(honest(overrides)))).toMatchObject({
      verified: false,
    });
  });

  it("refuses an unsigned timeout that differs from the offer before accepting goods", async () => {
    const client = new Answering();
    expect(
      await facilitatorFor(client).verify(charge(honest({ maxTimeoutSeconds: 1 }))),
    ).toMatchObject({ verified: false });
    expect(client.asked).toHaveLength(0);
  });

  it("does not read a configured chain during an ordinary successful payment", async () => {
    let chainCalls = 0;
    const fail = async () => {
      chainCalls += 1;
      throw new Error("https://secret:credential@rpc.invalid");
    };
    const configured = new Eip3009Recovery(() => ({
      networkId: fail,
      block: fail,
      authorizationState: fail,
      blockReceipts: fail,
      receipt: fail,
    }));
    const facilitator = facilitatorFor(new Answering(), configured);
    const outcome = await facilitator.verify(charge(honest()));
    expect(outcome).toMatchObject({
      verified: true,
      recovery: { notBefore: String(NOW_SECONDS - 30) },
    });
    expect(await facilitator.settle(charge(honest()))).toMatchObject({ settled: true });
    expect(chainCalls).toBe(0);
    expect(JSON.stringify(outcome)).not.toContain("credential");
  });

  it("verifies and settles through the facilitator without any RPC calls when none is configured", async () => {
    let chainCalls = 0;
    const fetch = globalThis.fetch;
    globalThis.fetch = async () => {
      chainCalls += 1;
      throw new Error("No chain calls allowed");
    };
    try {
      const client = new Answering();
      const facilitator = new X402Facilitator(client);
      expect(await facilitator.verify(charge(honest()))).toMatchObject({
        verified: true,
        recovery: { notBefore: String(NOW_SECONDS - 30) },
      });
      expect(await facilitator.settle(charge(honest()))).toMatchObject({ settled: true });
      expect(facilitator.reconcile).toBeUndefined();
      expect(chainCalls).toBe(0);
    } finally {
      globalThis.fetch = fetch;
    }
  });

  it("keeps an unobserved facilitator settlement unknown without RPC and retains recovery context", async () => {
    const facilitator = new X402Facilitator(
      new Answering({ settle: new Error("settlement reply was lost") }),
      undefined,
    );
    expect(await facilitator.verify(charge(honest()))).toMatchObject({
      verified: true,
      recovery: { notBefore: String(NOW_SECONDS - 30), nonce: signed().authorization.nonce },
    });
    expect(await facilitator.settle(charge(honest()))).toMatchObject({ settled: "unknown" });
  });

  it("checks it against the price this gateway issued, not the one the payment names", async () => {
    const client = new Answering();
    const facilitator = facilitatorFor(client);

    const answered = await facilitator.verify(charge(honest({ amount: "1" })));

    expect(answered).toStrictEqual({
      verified: false,
      reason: "price_stale",
      message: expect.stringMatching(/\b80000000\b.*\b1\b/),
    });
    expect(client.asked).toStrictEqual([]);
  });

  it.each([
    ["another address", "0x00000000000000000000000000000000000000ff", PAY_TO],
    [
      "the merchant wallet instead of its split",
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      payoutSplitFor(
        payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532"),
        "mch_a",
        "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      ).address,
    ],
    [
      "the previous payout split",
      payoutSplitFor(
        payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532"),
        "mch_a",
        "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      ).address,
      payoutSplitFor(
        payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532"),
        "mch_a",
        "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      ).address,
    ],
  ] as const)(
    "refuses a payment made out to %s before provider submission",
    async (_name, offered, destination) => {
      const client = new Answering();
      const payment = encodePaymentSignatureHeader({
        x402Version: 2,
        accepted: edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", offered),
        payload: signed(offered),
      });
      const answered = await facilitatorFor(client).verify({
        ...charge(payment),
        payTo: destination,
        requirements: edge.requirementsFor(
          { amount: "80.00", currency: "USD" },
          "ord_1",
          destination,
        ),
      });
      expect(answered).toMatchObject({
        verified: false,
        reason: "price_stale",
        message: expect.stringMatching(/address|recipient|payee/i),
      });
      expect(client.asked).toEqual([]);
    },
  );

  it.each([
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    payoutSplitFor(
      payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532"),
      "mch_a",
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    ).address,
  ])(
    "takes address %s in either spelling and submits our canonical spelling",
    async (checksummed) => {
      // An EVM address has two spellings and one value: the checksummed mixed case
      // a merchant's address is stored and offered in, and the same characters in
      // lower case. A client whose library normalises what it echoes back must not
      // have every payment refused as though it had paid a stranger.
      const inLowerCase = checksummed.toLowerCase();
      const client = new Answering();

      const answered = await facilitatorFor(client).verify({
        ...charge(
          encodePaymentSignatureHeader({
            x402Version: 2,
            accepted: edge.requirementsFor(
              { amount: "80.00", currency: "USD" },
              "ord_1",
              inLowerCase,
            ),
            payload: signed(inLowerCase),
          }),
        ),
        payTo: checksummed,
        requirements: edge.requirementsFor(
          { amount: "80.00", currency: "USD" },
          "ord_1",
          checksummed,
        ),
      });

      expect(answered).toMatchObject({ verified: true, payer: PAYER });
      // And what the facilitator is asked about is still our own spelling: the
      // agent's copy is evidence of nothing.
      expect(client.asked[0]?.requirements.payTo).toBe(checksummed);

      // The token's address is an address too, and arrives from the same
      // libraries. A payment echoing it in the other spelling is the same
      // payment.
      const ours = edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", PAY_TO);
      expect(
        await facilitatorFor(new Answering()).verify(
          charge(honest({ asset: ours.asset.toUpperCase().replace("0X", "0x") })),
        ),
      ).toMatchObject({ verified: true, payer: PAYER });
      // The rule is one address in two spellings, not "addresses need not match":
      // another address is still refused, whatever case it is written in.
      expect(
        await facilitatorFor(new Answering()).verify({
          ...charge(honest({ payTo: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359" })),
          payTo: checksummed,
          requirements: edge.requirementsFor(
            { amount: "80.00", currency: "USD" },
            "ord_1",
            checksummed,
          ),
        }),
      ).toMatchObject({
        verified: false,
        message: expect.stringMatching(/address|recipient|payee/i),
      });
    },
  );

  it("checks the payment against the merchant's address rather than the gateway's own", async () => {
    // The address in the requirements comes from the charge, which reads it off
    // the order's own merchant, and never from this gateway's configuration.
    // Read from the configuration, every sale on a deployment with several
    // merchants would be checked against one shared address instead of their own.
    const theirs = "0x27b1fdb04752bbc536007a920d24acb045561c26";
    const paidToThem = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", theirs),
      payload: signed(theirs),
    });
    const client = new Answering();

    const answered = await facilitatorFor(client).verify({
      orderId: "ord_1",
      requirements: edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", theirs),
      amount: "80.00",
      currency: "USD",
      payment: paidToThem,
      payTo: theirs,
    });

    expect(answered).toMatchObject({ verified: true, payer: PAYER });
    expect(client.asked[0]?.requirements.payTo).toBe(theirs);
    // And the same payment on a charge naming a different merchant's address is
    // refused, which is what makes the assertion above about this merchant
    // rather than about any address at all.
    expect(await facilitatorFor(new Answering()).verify(charge(paidToThem))).toMatchObject({
      verified: false,
      message: expect.stringMatching(/address|recipient|payee/i),
    });
  });

  it("refuses a payment made in another asset or on another chain", async () => {
    // The price matches to the digit and the money still goes somewhere else:
    // the same number of a token nobody agreed on, or the right token on a
    // chain we do not settle on.
    const wrongAsset = new Answering();
    const wrongChain = new Answering();
    const message = expect.stringMatching(/asset|chain|network/i);

    expect(
      await facilitatorFor(wrongAsset).verify(
        charge(honest({ asset: "0x00000000000000000000000000000000000000aa" })),
      ),
    ).toStrictEqual({ verified: false, reason: "price_stale", message });

    expect(
      await facilitatorFor(wrongChain).verify(charge(honest({ network: "eip155:1" }))),
    ).toStrictEqual({ verified: false, reason: "price_stale", message });

    expect(wrongAsset.asked).toStrictEqual([]);
    expect(wrongChain.asked).toStrictEqual([]);
  });

  it("refuses a payment naming another stamped price or omitting its stamp", async () => {
    const client = new Answering();
    const facilitator = facilitatorFor(client);

    for (const named of [{ price_stamp: "ord_2" }, { payment_ref: "ord_1" }, {}]) {
      expect(await facilitator.verify(againstStamp("ord_1", paidNaming(named)))).toStrictEqual({
        verified: false,
        reason: "price_stale",
        message: expect.stringMatching(/stamp|offer/i),
      });
    }
    expect(client.asked).toStrictEqual([]);
  });

  it("passes the saved stamped price to the facilitator at verification and settlement", async () => {
    const client = new Answering();
    const facilitator = facilitatorFor(client);
    const charge = againstStamp("ord_1", paidNaming({ price_stamp: "ord_1" }));

    expect(await facilitator.verify(charge)).toMatchObject({ verified: true });
    expect(await facilitator.settle(charge)).toStrictEqual({ settled: true, transaction: "0xtx" });
    expect(client.asked.map((asked) => asked.requirements.extra)).toStrictEqual([
      { name: "USDC", version: "2", price_stamp: "ord_1" },
      { name: "USDC", version: "2", price_stamp: "ord_1" },
    ]);
  });

  it("refuses a payment that names no offer to check against", async () => {
    const client = new Answering();
    const answered = await facilitatorFor(client).verify(charge(namesNoOffer()));

    expect(answered).toStrictEqual({
      verified: false,
      reason: "price_stale",
      message: expect.stringMatching(/no.*offer|offer.*(?:absent|missing)/i),
    });
    expect(client.asked).toStrictEqual([]);
  });

  /** What the gateway makes of the facilitator refusing an honest payment with `invalidReason`. */
  const refusedWith = (invalidReason: unknown, invalidMessage?: string) =>
    facilitatorFor(
      new Answering({
        verify: {
          isValid: false,
          ...(invalidReason === undefined ? {} : { invalidReason }),
          ...(invalidMessage === undefined ? {} : { invalidMessage }),
        } as VerifyResponse,
      }),
    ).verify(charge(honest()));

  it("tells a payer that the payment network will not carry an amount this small, not to buy again", async () => {
    // A payment of a millionth of a dollar was refused this way on the test
    // channel. Read as a moved price, it sent the buyer to a new purchase that
    // failed the same way.
    expect(await refusedWith("amount_too_low", "amount is below the minimum")).toStrictEqual({
      verified: false,
      reason: "amount_not_payable",
      message: "amount_too_low: amount is below the minimum",
      code: "amount_too_low",
    });
    expect(await refusedWith("invalid_amount")).toMatchObject({ reason: "amount_not_payable" });
    // The signed value is checked against the order's price before the
    // facilitator is asked, so a value too low is the price itself.
    expect(
      await refusedWith("invalid_exact_evm_payload_authorization_value_too_low"),
    ).toMatchObject({ reason: "amount_not_payable" });
  });

  it("reads a refusal by the facilitator's code as a whole, whatever words the code contains", async () => {
    // Each code below contains a word that once decided its meaning on its own.
    const cases: [string, string][] = [
      ["invalid_exact_evm_payload_signature", "signature"],
      ["invalid_exact_evm_payload_authorization_valid_before", "signature"],
      ["invalid_exact_evm_nonce_already_used", "signature"],
      ["insufficient_funds", "insufficient_funds"],
      ["invalid_exact_evm_insufficient_balance", "insufficient_funds"],
      ["invalid_payload", "unexplained"],
      ["invalid_exact_evm_transaction_simulation_failed", "unexplained"],
      ["invalid_exact_evm_payload_authorization_from_address_kyt", "wallet_refused"],
      ["self_send_not_allowed", "wallet_refused"],
      ["invalid_exact_evm_payload_undeployed_smart_wallet", "wallet_refused"],
      // Screening that names neither the payer's wallet nor the seller's.
      ["kyt_risk_detected", "unexplained"],
    ];

    for (const [code, expected] of cases) {
      expect(await refusedWith(code), code).toStrictEqual({
        verified: false,
        reason: expected,
        message: code,
        code,
      });
    }
  });

  it("reads a refusal of terms this gateway already checked the payment against as no verdict on the payment", async () => {
    // The signed value, the recipient, the chain, the scheme and the protocol
    // version are compared with the offer before the facilitator is asked. A
    // facilitator that refuses them disagrees with Agentify's own terms, and
    // a new signature would meet the same answer.
    for (const code of [
      "invalid_exact_evm_payload_authorization_value",
      "invalid_exact_evm_payload_authorization_value_mismatch",
      "invalid_exact_evm_authorization_value",
      "invalid_exact_evm_payload_recipient_mismatch",
      "invalid_exact_evm_recipient_mismatch",
      "invalid_network",
      "invalid_exact_evm_network_mismatch",
      "invalid_scheme",
      "invalid_exact_evm_unsupported_scheme",
      "invalid_x402_version",
    ]) {
      expect(await refusedWith(code), code).toMatchObject({
        verified: "unknown",
        cause: "refused_agentify",
      });
    }
  });

  it("keeps the facilitator's code for the operator as a machine word, never the words after it", async () => {
    expect(
      await refusedWith("invalid_exact_evm_transaction_failed: 0xpayer said this", "more words"),
    ).toMatchObject({ reason: "unrecognised", code: "invalid_exact_evm_transaction_failed" });
    expect(await refusedWith(`${"a".repeat(200)}`)).toMatchObject({ code: "a".repeat(80) });
    const unworded = await refusedWith("Not A Code");
    expect(unworded).toMatchObject({ reason: "unrecognised" });
    expect(unworded).not.toHaveProperty("code");
  });

  it("says a refusal code it does not recognise is unrecognised, quoting the code", async () => {
    for (const code of ["funds_frozen_by_issuer", "amount_expired_elsewhere", "constructor"]) {
      expect(await refusedWith(code, "the facilitator's own words"), code).toStrictEqual({
        verified: false,
        reason: "unrecognised",
        message: `${code}: the facilitator's own words`,
        code,
      });
    }
  });

  it("says a refusal that names no code names no fault it can act on, and passes on any words it has", async () => {
    expect(await refusedWith(undefined)).toStrictEqual({
      verified: false,
      reason: "unexplained",
      message: expect.stringMatching(/\S/),
    });
    expect(await refusedWith(undefined, "the wallet is frozen")).toStrictEqual({
      verified: false,
      reason: "unexplained",
      message: "the wallet is frozen",
    });
    // A code that is not even text is no code, and is never quoted as one.
    const shapeless = await refusedWith({ nested: true });
    expect(shapeless).toStrictEqual({
      verified: false,
      reason: "unexplained",
      message: expect.stringMatching(/\S/),
    });
  });

  it("reads a refusal that reports the facilitator's own failure as no verdict that asking again may cure", async () => {
    for (const code of [
      "invalid_exact_evm_failed_to_get_balance",
      "unknown_error",
      "invalid_exact_evm_eip3009_not_supported",
    ]) {
      const answered = await refusedWith(code, "the payer's words must not reach the log");
      if (answered.verified !== "unknown") throw new Error(`${code} became a verdict`);
      expect(answered.cause).toBe("no_answer");
      expect(answered.failure).toContain(code);
      expect(answered.failure).not.toContain("must not reach");
    }
  });

  it("reads a refusal of what Agentify asked, or of where the seller is paid, as no verdict on the payment", async () => {
    const cases: [string, string][] = [
      ["request_blocked_by_location", "refused_agentify"],
      ["invalid_payment_requirements", "refused_agentify"],
      ["invalid_exact_evm_payload_authorization_to_address_kyt", "seller_cannot_be_paid"],
    ];
    for (const [code, cause] of cases) {
      expect(await refusedWith(code), code).toMatchObject({ verified: "unknown", cause });
    }
  });

  it.each([
    ["invalid_exact_evm_signature_format", { verified: false, reason: "signature" }],
    ["invalid_exact_evm_failed_to_parse_signature", { verified: false, reason: "signature" }],
    ["invalid_exact_evm_insufficient_funds", { verified: false, reason: "insufficient_funds" }],
    ["invalid_exact_evm_required_amount", { verified: false, reason: "amount_not_payable" }],
    ["eip6492_factory_not_allowed", { verified: false, reason: "wallet_refused" }],
    ["smart_wallet_deployment_failed", { verified: false, reason: "wallet_refused" }],
    ["invalid_exact_evm_transfer_event_mismatch", { verified: false, reason: "unexplained" }],
    ["settlement_pending", { verified: false, reason: "unexplained" }],
    ["invalid_exact_evm_failed_to_get_receipt", { verified: "unknown", cause: "no_answer" }],
    ["invalid_exact_evm_failed_to_verify_signature", { verified: "unknown", cause: "no_answer" }],
    ["asset_not_deployed_contract", { verified: "unknown", cause: "refused_agentify" }],
    ["invalid_bazaar_extension", { verified: "unknown", cause: "refused_agentify" }],
    [
      "invalid_exact_evm_payload_authorization_to_address_kyt",
      { verified: "unknown", cause: "seller_cannot_be_paid" },
    ],
  ] as const)(
    "gives protocol refusal %s its actionable financial category",
    async (code, expected) => {
      expect(await refusedWith(code), code).toMatchObject(expected);
    },
  );

  it("says nobody knows when the facilitator could not be reached, naming the failure for the operator's log", async () => {
    // What fetch throws carries the address it could not reach in its cause's
    // message; the log keeps what kind of failure it was.
    const unreachable = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), {
        code: "ECONNREFUSED",
      }),
    });
    const answered = await facilitatorFor(new Answering({ verify: unreachable })).verify(
      charge(honest()),
    );

    if (answered.verified !== "unknown") throw new Error("the silence was taken for a verdict");
    expect(answered.cause).toBe("no_answer");
    expect(answered.failure).toContain("TypeError");
    expect(answered.failure).toContain("ECONNREFUSED");
  });

  it("refuses something that is not a payment at all", async () => {
    const answered = await facilitatorFor(new Answering()).verify(charge("not base64"));
    expect(answered).toMatchObject({ verified: false, reason: "signature" });
    await expect(facilitatorFor(new Answering()).settle(charge("not base64"))).rejects.toThrow(
      /payment.*(?:read|decode|invalid|malformed)/i,
    );
  });

  it("reads a verdict the facilitator sent with a refusing status as a verdict", async () => {
    // A facilitator may answer "this payment is invalid, and here is why" with
    // a 4xx rather than a 200, and the client turns that into a throw. Reported
    // as "nobody knows", a refusal the facilitator was perfectly clear about
    // becomes a purchase that hangs waiting for an answer that already came —
    // and the agent is never told the thing it could act on.
    const answered = await facilitatorFor(
      new Answering({
        verify: new VerifyError(400, {
          isValid: false,
          invalidReason: "invalid_exact_evm_payload_signature",
          invalidMessage: "the signature is not the payer's",
        } as VerifyResponse),
      }),
    ).verify(charge(honest()));

    expect(answered).toStrictEqual({
      verified: false,
      reason: "signature",
      message: "invalid_exact_evm_payload_signature: the signature is not the payer's",
      code: "invalid_exact_evm_payload_signature",
    });
  });

  it("keeps a verdict carried by a broken facilitator as no verdict at all", async () => {
    // The same shape arriving with a 500 is not the same news. A facilitator
    // answering out of its own failure has not judged the payment, and telling
    // an agent its payment is bad on that evidence costs it a sale it could
    // have made by asking again a moment later.
    const answered = await facilitatorFor(
      new Answering({
        verify: new VerifyError(500, {
          isValid: false,
          invalidReason: "internal_error",
        } as VerifyResponse),
      }),
    ).verify(charge(honest()));

    expect(answered).toMatchObject({ verified: "unknown", cause: "no_answer" });
    if (answered.verified === "unknown") expect(answered.failure).toContain("500");
  });
});

describe("a facilitator that answers a check with a failure status and no verdict", () => {
  // The real client, on a server on this machine: the status reaches the
  // gateway only in the shape the client raises it, and that is what is read.
  const closing: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closing.splice(0).map((close) => close()));
  });

  const answeringWith = async (status: number, body: string): Promise<FacilitatorClient> => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(body);
      });
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    closing.push(() => new Promise((resolve) => server.close(() => resolve())));
    return new HTTPFacilitatorClient({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
  };

  it("verifies and settles the exact saved stamped offer after deployment terms change", async () => {
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "80000000",
      payTo: PAY_TO,
      maxTimeoutSeconds: 75,
      extra: { name: "USDC", version: "2", price_stamp: "signed-offer-1" },
    };
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (part) => {
        body += part;
      });
      request.on("end", () => {
        const received = JSON.parse(body) as { paymentRequirements: unknown };
        const exact = JSON.stringify(received.paymentRequirements) === JSON.stringify(requirements);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            request.url === "/verify"
              ? { isValid: exact, payer: PAYER, invalidReason: "invalid_payment_requirements" }
              : {
                  success: exact,
                  transaction: exact ? "0xsaved-offer" : "",
                  network: "eip155:84532",
                },
          ),
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    closing.push(() => new Promise((resolve) => server.close(() => resolve())));
    const client = new HTTPFacilitatorClient({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
    const payment = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: requirements,
      payload: signed(),
    });
    const saved = { ...charge(payment), requirements };
    const facilitator = facilitatorFor(client);

    const verified = await facilitator.verify(saved);
    expect(verified).toMatchObject({
      verified: true,
      payer: PAYER,
      recovery: {
        network: "eip155:84532",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount: "80000000",
        payTo: PAY_TO,
        nonce: signed().authorization.nonce,
        notBefore: String(NOW_SECONDS - 30),
      },
    });
    expect(await facilitator.settle(saved)).toStrictEqual({
      settled: true,
      transaction: "0xsaved-offer",
    });
  });

  const NOT_A_VERDICT = JSON.stringify({ error: "a body the log must not carry" });

  it.each([401, 403, 404])(
    "reads %i as the check refusing Agentify, naming the status for the log and not the body",
    async (status) => {
      const answered = await facilitatorFor(await answeringWith(status, NOT_A_VERDICT)).verify(
        charge(honest()),
      );

      if (answered.verified !== "unknown")
        throw new Error("a refusal of Agentify became a verdict");
      expect(answered.cause).toBe("refused_agentify");
      expect(answered.failure).toContain(String(status));
      expect(answered.failure).not.toContain("must not carry");
    },
  );

  it("reads a refusal of Agentify the same way when its body is not even JSON", async () => {
    const answered = await facilitatorFor(await answeringWith(401, "Unauthorized")).verify(
      charge(honest()),
    );

    expect(answered).toMatchObject({ verified: "unknown", cause: "refused_agentify" });
  });

  it.each([200, 400])(
    "reads a refusal of an amount too small to carry, answered with %i, as one no new purchase can pass",
    async (status) => {
      const answered = await facilitatorFor(
        await answeringWith(
          status,
          JSON.stringify({
            isValid: false,
            invalidReason: "amount_too_low",
            invalidMessage: "payment amount is below the minimum",
            payer: PAYER,
          }),
        ),
      ).verify(charge(honest()));

      expect(answered).toStrictEqual({
        verified: false,
        reason: "amount_not_payable",
        message: "amount_too_low: payment amount is below the minimum",
        code: "amount_too_low",
      });
    },
  );

  it.each([429, 500, 503])(
    "reads %i as no answer that asking again may cure, naming the status for the log",
    async (status) => {
      const answered = await facilitatorFor(await answeringWith(status, NOT_A_VERDICT)).verify(
        charge(honest()),
      );

      if (answered.verified !== "unknown") throw new Error("a silence became a verdict");
      expect(answered.cause).toBe("no_answer");
      expect(answered.failure).toContain(String(status));
    },
  );
});

describe("executing a charge", () => {
  it.each([
    "invalid_exact_evm_payload_authorization_value_mismatch",
    "invalid_exact_evm_recipient_mismatch",
  ])("accepts %s as a refusal before broadcast", async (reason) => {
    const answered = await facilitatorFor(
      new Answering({
        settle: {
          success: false,
          transaction: "",
          network: "eip155:84532",
          errorReason: reason,
        } as SettleResponse,
      }),
    ).settle(charge(honest()));

    expect(answered).toStrictEqual({
      settled: false,
      reason,
    });
  });

  it.each(
    [200, 400, 503].flatMap((status) =>
      [
        "settlement_pending",
        "settle_exact_evm_transaction_confirmation_timed_out",
        "settle_exact_node_failure",
        "invalid_exact_evm_transfer_event_mismatch",
        "unfamiliar_settlement_outcome",
      ].map((reason) => ({ status, reason })),
    ),
  )("keeps $reason under HTTP $status unknown after broadcast", async ({ status, reason }) => {
    const response: SettleResponse = {
      success: false,
      transaction: `0x${"a".repeat(64)}`,
      network: "eip155:84532",
      errorReason: reason,
    };
    const answered = await facilitatorFor(
      new Answering({ settle: status === 200 ? response : new SettleError(status, response) }),
    ).settle(charge(honest()));

    expect(answered).toMatchObject({ settled: "unknown", transaction: response.transaction });
  });

  it("keeps an unfamiliar refusal unknown even when it carries no transaction", async () => {
    const answered = await facilitatorFor(
      new Answering({
        settle: {
          success: false,
          transaction: "",
          network: "eip155:84532",
          errorReason: "unfamiliar_settlement_outcome",
        },
      }),
    ).settle(charge(honest()));

    expect(answered).toMatchObject({ settled: "unknown" });
  });

  it("keeps a refusal with conflicting broadcast evidence unknown", async () => {
    const answered = await facilitatorFor(
      new Answering({
        settle: {
          success: false,
          transaction: `0x${"a".repeat(64)}`,
          network: "eip155:84532",
          errorReason: "invalid_exact_evm_payload_authorization_value_mismatch",
        },
      }),
    ).settle(charge(honest()));

    expect(answered).toMatchObject({ settled: "unknown" });
  });

  it("says nobody knows when the charge went out and nothing came back", async () => {
    // The protocol's own account: a timeout on settle is an indeterminate
    // outcome, because the facilitator may have completed it. Reporting that as
    // a failure is how a buyer gets told his purchase did not happen while his
    // money is on its way.
    const answered = await facilitatorFor(
      new Answering({ settle: new Error("the facilitator timed out") }),
    ).settle(charge(honest()));

    expect(answered).toStrictEqual({ settled: "unknown", reason: "the facilitator timed out" });
  });

  it("accepts a proven pre-broadcast refusal carried by an HTTP error", async () => {
    const answered = await facilitatorFor(
      new Answering({
        settle: new SettleError(400, {
          success: false,
          transaction: "",
          network: "eip155:84532",
          errorReason: "invalid_exact_evm_payload_authorization_value_mismatch",
        } as SettleResponse),
      }),
    ).settle(charge(honest()));

    expect(answered).toStrictEqual({
      settled: false,
      reason: "invalid_exact_evm_payload_authorization_value_mismatch",
    });
  });

  it("keeps a charge a broken facilitator could not report on as unknown", async () => {
    // This is the branch above with the one difference that decides money. A
    // facilitator failing inside itself may have moved the money before it
    // fell over, so the same body under a 500 is not a verdict, and a gateway
    // that read it as one would tell a buyer his purchase did not happen while
    // his money was on its way.
    const answered = await facilitatorFor(
      new Answering({
        settle: new SettleError(503, {
          success: false,
          transaction: "",
          network: "eip155:84532",
          errorReason: "unexpected_settle_error",
        } as SettleResponse),
      }),
    ).settle(charge(honest()));

    expect(answered).toMatchObject({ settled: "unknown" });
  });

  it("keeps a charge that ran out of time as unknown, however the clock reports it", async () => {
    // The protocol says this outright: a client-side timeout on settle is
    // indeterminate, because the facilitator may have completed the settlement
    // after the client stopped waiting. It is the one case the branch above
    // must never swallow, so it is pinned with the library's own timeout rather
    // than a plain error.
    const answered = await facilitatorFor(
      new Answering({ settle: new FacilitatorTimeoutError("settle", 30_000) }),
    ).settle(charge(honest()));

    expect(answered).toMatchObject({ settled: "unknown" });
  });
});
