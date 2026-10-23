import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
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
import { describe, expect, it } from "vitest";
import { PaymentEdge } from "../../http/x402.js";
import type { Charge } from "../../ports/facilitator.js";
import { PAYOUT_SPLIT_NETWORKS, payoutSplitNetworkOf } from "../../split/networks.js";
import { payoutSplitFor } from "../../split/parameters.js";
import { X402Facilitator } from "./facilitator.js";
import { type ChainReader, Eip3009Recovery } from "./recovery.js";

/** The address the merchant behind these charges is paid at. */
const PAY_TO = "0x0000000000000000000000000000000000000001";
const PAYER = "0x0000000000000000000000000000000000000002";
const NOW_SECONDS = 1_800_000_000;
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
const facilitatorFor = (client: FacilitatorClient, paymentEdge: PaymentEdge, evidence = recovery) =>
  new X402Facilitator(client, paymentEdge, evidence, () => NOW_SECONDS * 1000);

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

/** A charge for the order `orderId`, presenting `payment`. */
const againstOrder = (orderId: string, payment: string): Charge => ({
  orderId,
  amount: "80.00",
  currency: "USD",
  payment,
  payTo: PAY_TO,
});

/** A payment right in every respect but how its offer names the order, which `named` says. */
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

describe("verifying a payment", () => {
  it("saves the signed recovery profile and the time the chain search starts from", async () => {
    const answered = await facilitatorFor(new Answering(), edge).verify(charge(honest()));
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
      const answered = await facilitatorFor(client, edge).verify(
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
      edge,
    ).verify(charge(honest()));
    expect(answered).toMatchObject({ verified: "unknown" });
  });

  it("refuses Permit2 before verification or settlement", async () => {
    const client = new Answering();
    const payment = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", PAY_TO),
      payload: { signature: "0x12", permit2Authorization: {} },
    });
    const facilitator = facilitatorFor(client, edge);
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
      const answered = await facilitatorFor(client, edge).verify(
        charge(encodePaymentSignatureHeader({ x402Version: 2, accepted, payload })),
      );
      expect(answered).toMatchObject({
        verified: false,
        reason: "signature",
        message: expect.stringContaining(`${accepted.maxTimeoutSeconds} seconds`),
      });
      expect(client.asked).toHaveLength(0);
    },
  );

  it("accepts an authorization expiring at the end of the offered timeout and its clock allowance", async () => {
    const accepted = edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", PAY_TO);
    const payload = {
      ...signed(),
      authorization: {
        ...signed().authorization,
        validBefore: String(NOW_SECONDS + accepted.maxTimeoutSeconds + 30),
      },
    };
    expect(
      await facilitatorFor(new Answering(), edge).verify(
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
      expect(await facilitatorFor(new Answering(), edge).verify(charge(payment))).toMatchObject({
        verified: true,
      });
    },
  );

  it.each(["value", "validAfter", "validBefore"])(
    "refuses signed %s outside uint256",
    async (field) => {
      const payload = {
        ...signed(),
        authorization: { ...signed().authorization, [field]: (1n << 256n).toString() },
      };
      const payment = encodePaymentSignatureHeader({
        x402Version: 2,
        accepted: edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", PAY_TO),
        payload,
      });
      expect(await facilitatorFor(new Answering(), edge).verify(charge(payment))).toMatchObject({
        verified: false,
      });
    },
  );

  it.each([{ scheme: "upto" }, { extra: { assetTransferMethod: "permit2", order_id: "ord_1" } }])(
    "refuses an incompatible accepted method %j",
    async (overrides) => {
      expect(
        await facilitatorFor(new Answering(), edge).verify(charge(honest(overrides))),
      ).toMatchObject({ verified: false });
    },
  );

  it("refuses an unsigned timeout that differs from the offer before accepting goods", async () => {
    const client = new Answering();
    expect(
      await facilitatorFor(client, edge).verify(charge(honest({ maxTimeoutSeconds: 1 }))),
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
    const facilitator = facilitatorFor(new Answering(), edge, configured);
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
      const facilitator = new X402Facilitator(client, edge, undefined, () => NOW_SECONDS * 1000);
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
      edge,
      undefined,
      () => NOW_SECONDS * 1000,
    );
    expect(await facilitator.verify(charge(honest()))).toMatchObject({
      verified: true,
      recovery: { notBefore: String(NOW_SECONDS - 30), nonce: signed().authorization.nonce },
    });
    expect(await facilitator.settle(charge(honest()))).toMatchObject({ settled: "unknown" });
    expect(await facilitator.recoveryFor(charge(honest()), NOW_SECONDS * 1000)).toMatchObject({
      notBefore: String(NOW_SECONDS - 30),
      nonce: signed().authorization.nonce,
    });
  });

  it("reconstructs an old payment from its saved offer rather than the deployment's current chain", async () => {
    const different = new PaymentEdge({
      payment: {
        facilitatorUrl: "https://x402.org/facilitator",
        network: "eip155:8453",
        payTo: PAY_TO,
        cdpApiKeyId: null,
        cdpApiKeySecret: null,
      },
      publicBaseUrl: "https://agentify.example",
      deadlines: { quoteTtlMs: 30_000, syncResponseMs: 10_000 },
    });
    expect(
      await facilitatorFor(new Answering(), different).recoveryFor(
        charge(honest()),
        NOW_SECONDS * 1000,
      ),
    ).toMatchObject({
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      notBefore: String(NOW_SECONDS - 30),
    });
  });

  it("recovers historical signed terms without accepting an obsolete unsigned order identifier", async () => {
    const payment = honest({
      extra: { name: "USDC", version: "2", order_id: "old_secret_order_id" },
    });
    const client = new Answering();
    const facilitator = facilitatorFor(client, edge);
    expect(await facilitator.verify(charge(payment))).toMatchObject({ verified: false });
    expect(await facilitator.recoveryFor(charge(payment), NOW_SECONDS * 1000)).toMatchObject({
      payer: PAYER,
      payTo: PAY_TO,
      amount: "80000000",
      nonce: signed().authorization.nonce,
      notBefore: String(NOW_SECONDS - 30),
    });
    expect(client.asked).toHaveLength(0);
    expect(
      await facilitator.recoveryFor({ ...charge(payment), amount: "81.00" }, NOW_SECONDS * 1000),
    ).toBeNull();
  });

  it.each([
    { asset: "0x00000000000000000000000000000000000000ff" },
    { amount: "81000000" },
    { payTo: "0x00000000000000000000000000000000000000ff" },
    { network: "eip155:8453" as const },
  ])(
    "does not reconstruct a historical payment whose saved financial offer contradicts its sale: %j",
    async (overrides) => {
      const payment = honest({ ...overrides, extra: { order_id: "old_secret_order_id" } });
      expect(
        await facilitatorFor(new Answering(), edge).recoveryFor(
          charge(payment),
          NOW_SECONDS * 1000,
        ),
      ).toBeNull();
    },
  );

  it.each([{}, { name: "wrong token", version: "999" }])(
    "settles an accepted payment with its canonical domain despite unsigned extra %j",
    async (extra) => {
      const payment = honest({ extra: { ...extra, order_id: "ord_1" } });
      const client = new Answering();
      const originalSettle = client.settle.bind(client);
      client.settle = async (payload, requirements) => {
        if (requirements.extra?.name !== "USDC" || requirements.extra?.version !== "2") {
          return {
            success: false,
            transaction: "",
            network: requirements.network,
            errorReason: "invalid_domain",
          };
        }
        return originalSettle(payload, requirements);
      };
      const facilitator = facilitatorFor(client, edge);
      expect(await facilitator.verify(charge(payment))).toMatchObject({ verified: true });
      expect(await facilitator.settle(charge(payment))).toMatchObject({ settled: true });
    },
  );

  it("checks it against the price this gateway issued, not the one the payment names", async () => {
    // The requirements handed to the facilitator are rebuilt from our own
    // order. A payment made against a price the agent chose is checked against
    // ours and never reaches the facilitator at all.
    const client = new Answering();
    const facilitator = facilitatorFor(client, edge);

    const answered = await facilitator.verify(charge(honest({ amount: "1" })));

    expect(answered).toStrictEqual({
      verified: false,
      reason: "price_stale",
      message: "this order is priced at 80000000 and the payment was made for 1",
    });
    expect(client.asked).toStrictEqual([]);
  });

  it("refuses a payment made out to somebody else", async () => {
    const client = new Answering();
    const answered = await facilitatorFor(client, edge).verify(
      charge(honest({ payTo: "0x00000000000000000000000000000000000000ff" })),
    );

    // All five of these refusals carry the same coarse reason, because the
    // machine has three of them and none is a better fit. The message is the
    // only place that says which offer was wrong, so it is what the test reads.
    expect(answered).toStrictEqual({
      verified: false,
      reason: "price_stale",
      message: "the payment was made out to a different address from the one asked for",
    });
    expect(client.asked).toStrictEqual([]);
  });

  it("takes one address in either spelling it may be written in", async () => {
    // An EVM address has two spellings and one value: the checksummed mixed case
    // a merchant's address is stored and offered in, and the same characters in
    // lower case. A client whose library normalises what it echoes back must not
    // have every payment refused as though it had paid a stranger.
    const checksummed = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const inLowerCase = checksummed.toLowerCase();
    const client = new Answering();

    const answered = await facilitatorFor(client, edge).verify({
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
    });

    expect(answered).toMatchObject({ verified: true, payer: PAYER });
    // And what the facilitator is asked about is still our own spelling: the
    // agent's copy is evidence of nothing, and the requirements are rebuilt.
    expect(client.asked[0]?.requirements.payTo).toBe(checksummed);

    // The token's address is an address too, and arrives from the same
    // libraries. A payment echoing it in the other spelling is the same
    // payment.
    const ours = edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", PAY_TO);
    expect(
      await facilitatorFor(new Answering(), edge).verify(
        charge(honest({ asset: ours.asset.toUpperCase().replace("0X", "0x") })),
      ),
    ).toMatchObject({ verified: true, payer: PAYER });
    // The rule is one address in two spellings, not "addresses need not match":
    // another address is still refused, whatever case it is written in.
    expect(
      await facilitatorFor(new Answering(), edge).verify({
        ...charge(honest({ payTo: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359" })),
        payTo: checksummed,
      }),
    ).toMatchObject({
      verified: false,
      message: "the payment was made out to a different address from the one asked for",
    });
  });

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

    const answered = await facilitatorFor(client, edge).verify({
      orderId: "ord_1",
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
    expect(await facilitatorFor(new Answering(), edge).verify(charge(paidToThem))).toMatchObject({
      verified: false,
      message: "the payment was made out to a different address from the one asked for",
    });
  });

  describe("against the order's payout split", () => {
    const network = payoutSplitNetworkOf(PAYOUT_SPLIT_NETWORKS, "eip155:84532");
    const LEFT = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const NOW = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
    const leftSplit = payoutSplitFor(network, "mch_a", LEFT).address;
    const nowSplit = payoutSplitFor(network, "mch_a", NOW).address;
    const paidTo = (payTo: string): string =>
      encodePaymentSignatureHeader({
        x402Version: 2,
        accepted: edge.requirementsFor({ amount: "80.00", currency: "USD" }, "ord_1", payTo),
        payload: signed(payTo),
      });
    const against = (payment: string, payTo: string): Charge => ({ ...charge(payment), payTo });

    it("refuses a payment made out to the merchant's wallet itself, as a challenge from before splits would name it", async () => {
      // Agents and catalogs keep challenges; paying one issued before the
      // split must cost nothing and must not be charged.
      const client = new Answering();

      const answered = await facilitatorFor(client, edge).verify(against(paidTo(NOW), nowSplit));

      expect(answered).toStrictEqual({
        verified: false,
        reason: "price_stale",
        message: "the payment was made out to a different address from the one asked for",
      });
      expect(client.asked).toStrictEqual([]);
    });

    it("refuses a payment made out to a split the merchant has since left, before the facilitator is asked", async () => {
      // Between the challenge and the payment the split can change; a
      // payment to the old one is a different purchase and costs the buyer
      // nothing.
      const client = new Answering();

      const answered = await facilitatorFor(client, edge).verify(
        against(paidTo(leftSplit), nowSplit),
      );

      expect(answered).toMatchObject({
        verified: false,
        reason: "price_stale",
        message: "the payment was made out to a different address from the one asked for",
      });
      expect(client.asked).toStrictEqual([]);
    });

    it("takes the order's split in either spelling an agent writes it, and asks about our own", async () => {
      const client = new Answering();

      const answered = await facilitatorFor(client, edge).verify(
        against(paidTo(nowSplit.toLowerCase()), nowSplit),
      );

      expect(answered).toMatchObject({ verified: true, payer: PAYER });
      expect(client.asked[0]?.requirements.payTo).toBe(nowSplit);
    });
  });

  it("refuses a payment made in another asset or on another chain", async () => {
    // The price matches to the digit and the money still goes somewhere else:
    // the same number of a token nobody agreed on, or the right token on a
    // chain we do not settle on.
    const wrongAsset = new Answering();
    const wrongChain = new Answering();
    const message =
      "the payment was made in a different asset or on a different chain from the one asked for";

    expect(
      await facilitatorFor(wrongAsset, edge).verify(
        charge(honest({ asset: "0x00000000000000000000000000000000000000aa" })),
      ),
    ).toStrictEqual({ verified: false, reason: "price_stale", message });

    expect(
      await facilitatorFor(wrongChain, edge).verify(charge(honest({ network: "eip155:1" }))),
    ).toStrictEqual({ verified: false, reason: "price_stale", message });

    expect(wrongAsset.asked).toStrictEqual([]);
    expect(wrongChain.asked).toStrictEqual([]);
  });

  it("refuses a payment made against another order, or naming its order any other way", async () => {
    // Two orders of ours at the same price make one offer indistinguishable
    // from the other everywhere except in the order it names. What stops one
    // signed authorisation from buying both is the claim taken on the payment
    // before any of this runs, not this branch; what this branch stops is a
    // payment for somebody else's order being carried to the facilitator as
    // though it were for this one. A payment naming this order under another
    // field names no order, so it is not this order's either.
    const client = new Answering();
    const facilitator = facilitatorFor(client, edge);

    for (const named of [{ order_id: "ord_2" }, { payment_ref: "ord_1" }, {}]) {
      expect(await facilitator.verify(againstOrder("ord_1", paidNaming(named)))).toStrictEqual({
        verified: false,
        reason: "price_stale",
        message: "the payment was made against a different order from the one it was presented for",
      });
    }
    expect(client.asked).toStrictEqual([]);
  });

  it("names the order to the facilitator by its identifier alone, at the check and the charge", async () => {
    const client = new Answering();
    const facilitator = facilitatorFor(client, edge);
    const charge = againstOrder("ord_1", paidNaming({ order_id: "ord_1" }));

    expect(await facilitator.verify(charge)).toMatchObject({ verified: true });
    expect(await facilitator.settle(charge)).toStrictEqual({ settled: true, transaction: "0xtx" });
    expect(client.asked.map((asked) => asked.requirements.extra)).toStrictEqual([
      { name: "USDC", version: "2", order_id: "ord_1" },
      { name: "USDC", version: "2", order_id: "ord_1" },
    ]);
  });

  it("refuses a payment that names no offer to check against", async () => {
    const client = new Answering();
    const answered = await facilitatorFor(client, edge).verify(charge(namesNoOffer()));

    expect(answered).toStrictEqual({
      verified: false,
      reason: "price_stale",
      message: "the payment names no offer, so there is nothing to check it against",
    });
    expect(client.asked).toStrictEqual([]);
  });

  it("passes an honest payment through and reports who paid", async () => {
    const client = new Answering();
    const answered = await facilitatorFor(client, edge).verify(charge(honest()));

    expect(answered).toMatchObject({ verified: true, payer: PAYER });
    expect(client.asked[0]?.requirements.amount).toBe("80000000");
  });

  it("keeps what the facilitator actually said, and picks the nearest of the machine's three reasons", async () => {
    // The facilitator's set of reasons is open and grows; the machine's is
    // three. The record is a little coarser than what happened and never wrong
    // about whether the payment was refused.
    const cases: [string, string][] = [
      ["invalid_exact_evm_payload_signature", "signature"],
      ["invalid_payload: contract call failed / execution reverted", "insufficient_funds"],
      ["invalid_exact_evm_payload_authorization_value", "price_stale"],
      ["something nobody has seen before", "signature"],
    ];

    for (const [said, expected] of cases) {
      const answered = await facilitatorFor(
        new Answering({ verify: { isValid: false, invalidReason: said } }),
        edge,
      ).verify(charge(honest()));

      expect(answered).toStrictEqual({ verified: false, reason: expected, message: said });
    }
  });

  it("says nobody knows when the facilitator could not be asked", async () => {
    const answered = await facilitatorFor(
      new Answering({ verify: new Error("the facilitator timed out") }),
      edge,
    ).verify(charge(honest()));

    expect(answered).toStrictEqual({ verified: "unknown", message: "the facilitator timed out" });
  });

  it("refuses something that is not a payment at all", async () => {
    const answered = await facilitatorFor(new Answering(), edge).verify(charge("not base64"));
    expect(answered).toMatchObject({ verified: false, reason: "signature" });
  });

  it("tells a payment it could not read from a sale it cannot ask about", async () => {
    // Two different facts, and everything about what happens next turns on
    // which one it is. A payment that will not decode is the payer's to fix and
    // is refused for good. A charge this gateway cannot even put a question
    // about — a merchant with nowhere to be paid, a currency it cannot charge
    // in — is ours, and the payment presented for it may be perfectly good. Told
    // it "could not be read as a payment at all", an agent goes looking through
    // a payment with nothing wrong with it.
    const client = new Answering();

    const answered = await facilitatorFor(client, edge).verify({
      ...charge(honest()),
      payTo: null,
    });

    expect(answered.verified).toBe("unknown");
    expect(answered).toMatchObject({
      message: expect.stringContaining("nowhere to send the money"),
    });
    // And nothing reached the facilitator, because there was no question to put
    // to it: what is missing is on our side of the call.
    expect(client.asked).toHaveLength(0);
  });

  it("says what is actually wrong when a charge cannot be built at all", async () => {
    // The same seam on the executing side. Whoever reads this out of a log is
    // looking at an order whose money never moved, and "the payment cannot be
    // read" would send them to the payment rather than to the merchant's
    // settings.
    const facilitator = facilitatorFor(new Answering(), edge);

    await expect(facilitator.settle({ ...charge(honest()), payTo: null })).rejects.toThrow(
      /nowhere to send the money/,
    );
    // And a payment that really cannot be read still says so.
    await expect(facilitator.settle(charge("not base64"))).rejects.toThrow(/cannot be read/);
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
          invalidReason: "invalid_exact_evm_payload_authorization_value",
          invalidMessage: "the authorised amount is not the amount asked for",
        } as VerifyResponse),
      }),
      edge,
    ).verify(charge(honest()));

    expect(answered).toStrictEqual({
      verified: false,
      reason: "price_stale",
      message: "the authorised amount is not the amount asked for",
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
      edge,
    ).verify(charge(honest()));

    expect(answered).toMatchObject({ verified: "unknown" });
  });
});

describe("executing a charge", () => {
  it("hands back the transaction the payment layer named", async () => {
    const answered = await facilitatorFor(new Answering(), edge).settle(charge(honest()));
    expect(answered).toStrictEqual({ settled: true, transaction: "0xtx" });
  });

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
      edge,
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
      edge,
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
      edge,
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
      edge,
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
      edge,
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
      edge,
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
      edge,
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
      edge,
    ).settle(charge(honest()));

    expect(answered).toMatchObject({ settled: "unknown" });
  });
});
