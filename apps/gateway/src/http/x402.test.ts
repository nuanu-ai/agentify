import { LIVE_CHAINS, TESTNET_CHAINS } from "@agentify/core";
import { AmountSchema, CardSchema, PAYABLE_DECIMALS } from "@nuanu-ai/agentify-contracts";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { getDefaultAsset } from "@x402/evm";
import type { DiscoveryExtension } from "@x402/extensions/bazaar";
import {
  sanitizeResourceServiceMetadata,
  validateDiscoveryExtension,
  validateDiscoveryExtensionSpec,
} from "@x402/extensions/bazaar";
import { describe, expect, it } from "vitest";
import { SANDBOX_FACILITATOR } from "../config.js";
import { randomIds } from "../ports/clock.js";
import { atomicUnits, CHALLENGE_REASONS, PaymentEdge, paymentFingerprint } from "./x402.js";

describe("a price in the token's own units", () => {
  it("writes an exact amount, whatever the price looked like", async () => {
    // Money never becomes a float on the way through.
    expect(atomicUnits("80.00", 6)).toBe("80000000");
    expect(atomicUnits("0.001", 6)).toBe("1000");
    expect(atomicUnits("12", 6)).toBe("12000000");
    expect(atomicUnits("0", 6)).toBe("0");
    expect(atomicUnits("0.000001", 6)).toBe("1");
    expect(atomicUnits("1234567890.123456", 6)).toBe("1234567890123456");
  });

  it("charges in the places the door lets a price be written to, on every chain it can charge on", () => {
    // The publish door reads its limit from the contract and this edge reads
    // the token's places from the payment library, so the two are held equal
    // for every chain that has a token to charge in.
    const charged = [...TESTNET_CHAINS, ...LIVE_CHAINS].flatMap((chain) => {
      try {
        return [[chain, getDefaultAsset(chain as `${string}:${string}`).decimals]];
      } catch {
        return [];
      }
    });

    expect(charged.length).toBeGreaterThan(0);
    for (const [chain, decimals] of charged) {
      expect(decimals, String(chain)).toBe(PAYABLE_DECIMALS);
    }
  });

  it("refuses a price the token cannot hold, rather than rounding it", async () => {
    // Which way it was rounded is the difference between shorting the buyer and
    // shorting the merchant, and neither is a decision this code gets to take.
    expect(() => atomicUnits("0.0000001", 6)).toThrowError(
      /written to 7 places and this token carries 6/,
    );
  });
});

/**
 * The address the seller is paid at: their payout split, as recorded and
 * handed to the edge. It differs from the gateway's own wherever both are in
 * play, so a challenge that used the wrong one shows. Mixed case, the form the
 * store hands the edge.
 */
const SELLERS_SPLIT = "0xEf9b422C5c07D99dB578ADF48Db2441b3049F410";

/**
 * A wallet itself, as the address on an order verified before payments went to
 * splits, whose charge still goes where it was signed for.
 */
const A_WALLET = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

describe("what an agent is asked to pay", () => {
  /** A gateway with an address of its own configured, and a facilitator that settles for real. */
  const edge = (payTo: string | null, facilitatorUrl = "https://x402.org/facilitator") =>
    new PaymentEdge({
      payment: {
        facilitatorUrl,
        network: "eip155:84532",
        payTo,
        cdpApiKeyId: null,
        cdpApiKeySecret: null,
      },
      publicBaseUrl: "https://agentify.example",
      deadlines: { quoteTtlMs: 30_000, syncResponseMs: 10_000 },
    });

  it("names the network's own asset, the seller's address and the order it is for", () => {
    const asked = edge(null).requirementsFor(
      { amount: "80.00", currency: "USD" },
      "ord_1",
      SELLERS_SPLIT,
    );

    expect(asked).toStrictEqual({
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "80000000",
      payTo: SELLERS_SPLIT,
      maxTimeoutSeconds: 50,
      extra: { name: "USDC", version: "2", order_id: "ord_1" },
    });
  });

  it("asks to be paid at the address it is given and nowhere else", () => {
    // The configured address is the operator's; naming it would invite an
    // agent to pay the operator for somebody else's product. The address is
    // the order's own at verification and at the charge, so the edge maps it
    // through nothing: a split as recorded, or the wallet an order from before
    // splits was signed for.
    const ours = "0x0000000000000000000000000000000000000001";

    for (const given of [SELLERS_SPLIT, A_WALLET]) {
      const asked = edge(ours).requirementsFor(
        { amount: "80.00", currency: "USD" },
        "ord_1",
        given,
      );
      expect(asked.payTo).toBe(given);
      expect(asked.payTo).not.toBe(ours);
    }
  });

  it("says nothing about an order when there is no order behind the price", () => {
    // A crawler asking what a resource costs is not a purchase, so there is no
    // order to name and none is invented.
    const asked = edge(null).requirementsFor(
      { amount: "80.00", currency: "USD" },
      null,
      SELLERS_SPLIT,
    );
    expect(asked.extra).toStrictEqual({ name: "USDC", version: "2" });
  });

  it("will not stand its own address in for a seller who has set none", () => {
    // A sale paid into the operator's address is a merchant's takings gone to
    // somebody else, on chain, with nobody the wiser.
    const ours = "0x0000000000000000000000000000000000000001";

    expect(() =>
      edge(ours).requirementsFor({ amount: "1.00", currency: "USD" }, null, null),
    ).toThrowError(/nowhere to send the money/);
  });

  it("will not ask for money with no address in any mode, the sandbox included", () => {
    // The sandbox's placeholder is a split computed for the merchant before
    // the edge is asked, never the configured address itself: a challenge
    // naming it would show a sale paid somewhere no split stands.
    const ours = "0x0000000000000000000000000000000000000001";

    for (const configured of [ours, null]) {
      expect(() =>
        edge(configured, SANDBOX_FACILITATOR).requirementsFor(
          { amount: "1.00", currency: "USD" },
          null,
          null,
        ),
      ).toThrowError(/nowhere to send the money/);
    }
  });

  it("will not invent an exchange rate for a currency it cannot charge in", () => {
    // Nobody has decided where a rate would come from, and a charge based on one
    // we made up would be the clearest possible claim beyond the evidence.
    expect(() =>
      edge(null).requirementsFor({ amount: "80.00", currency: "EUR" }, "ord_1", SELLERS_SPLIT),
    ).toThrowError(/will not invent a rate/);
  });
});

describe("one payment, one fingerprint", () => {
  const token = { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" };

  const signed = (payload: Record<string, unknown>) => ({
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:84532" as const,
      asset: "0x0",
      amount: "1",
      payTo: "0x0",
      maxTimeoutSeconds: 300,
      extra: {},
    },
    payload,
  });

  const fingerprintOf = (payload: Parameters<typeof paymentFingerprint>[0]) =>
    paymentFingerprint(payload, token);

  const authorised = (fields: { from?: string; nonce?: string; value?: string | number } = {}) => ({
    signature: "0xdeadBEEF",
    authorization: {
      from: fields.from ?? "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa",
      to: "0xbbbb",
      value: fields.value ?? "1000000",
      validAfter: "0",
      validBefore: "999",
      nonce: fields.nonce ?? "0xABCDEF0123456789",
    },
  });

  it("is one fingerprint however the hex is spelled", () => {
    // The signature is over decoded bytes, so 0xABCD and 0xabcd are one nonce.
    // Two fingerprints would let one authorisation pay for two orders by
    // flipping a case bit.
    const shouted = fingerprintOf(signed(authorised()));
    const whispered = fingerprintOf(
      signed(
        authorised({
          from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          nonce: "0xabcdef0123456789",
        }),
      ),
    );

    expect(whispered).toBe(shouted);
  });

  it("is one fingerprint however the amounts are written, and whatever they are called", () => {
    // The branch where the whole payload is the key, with neither an
    // authorisation pair nor a signature. 1000000, "1000000" and "0xF4240" are
    // one number to the chain; two fingerprints for them is one authorisation
    // buying two orders.
    //
    // The names are written out rather than read from the code's set, so a
    // name dropped from the set fails here. A name added only merges more
    // spellings, which never lets one payment buy twice.
    const names = ["value", "amount", "validAfter", "validBefore", "maxAmount"];

    // Leading zeros, so the decimal text is not already in its normalised form
    // and the decimal arm of asAmount can fail.
    for (const name of names) {
      const asText = fingerprintOf(signed({ proof: { [name]: "0001000000" } }));

      expect(fingerprintOf(signed({ proof: { [name]: "1000000" } })), name).toBe(asText);
      expect(fingerprintOf(signed({ proof: { [name]: 1_000_000 } })), name).toBe(asText);
      expect(fingerprintOf(signed({ proof: { [name]: "0xF4240" } })), name).toBe(asText);
    }
  });

  it("merges a number and its text only as far as a JSON number is exact", () => {
    // Past 2^53 a JSON number is no longer the integer it was written as, so
    // merging it with its text would assert an equality nobody can check. The
    // cost is pinned here: such an amount, one token of an eighteen-decimal
    // asset, and its own text are two fingerprints. No scheme this gateway
    // speaks reaches this branch; an EIP-3009 payload is keyed on its payer
    // and nonce first.
    const exact = String(Number.MAX_SAFE_INTEGER);
    const beyond = "1000000000000000000";

    expect(fingerprintOf(signed({ proof: { value: Number.MAX_SAFE_INTEGER } }))).toBe(
      fingerprintOf(signed({ proof: { value: exact } })),
    );
    expect(fingerprintOf(signed({ proof: { value: 1e18 } }))).not.toBe(
      fingerprintOf(signed({ proof: { value: beyond } })),
    );
  });

  it("merges two spellings of one number and not two different values", () => {
    // No token records a negative amount, so -5 and "-5" are two pieces of
    // junk rather than one number; merging them would refuse the second
    // payment as a replay of the first.
    expect(fingerprintOf(signed({ proof: { value: -5 } }))).not.toBe(
      fingerprintOf(signed({ proof: { value: "-5" } })),
    );
  });

  it("survives an amount that is not a whole number", () => {
    // The decoder guarantees nothing about the payload, and BigInt throws on a
    // fraction: a crash where a refusal belongs.
    expect(() => fingerprintOf(signed({ proof: { value: 1.5 } }))).not.toThrow();
  });

  it("keys on the payer as well as the nonce, the way the token does", () => {
    // A token records authorizationState[authorizer][nonce]. Keyed on the nonce
    // alone, the first payer to use one would block every other payer who ever
    // picked the same — and a client that counts from one picks exactly those.
    const mine = fingerprintOf(signed(authorised()));
    const yours = fingerprintOf(
      signed(authorised({ from: "0xcccccccccccccccccccccccccccccccccccccccc" })),
    );

    expect(yours).not.toBe(mine);
  });

  it("changes when the nonce does", () => {
    expect(fingerprintOf(signed(authorised({ nonce: "0x02" })))).not.toBe(
      fingerprintOf(signed(authorised({ nonce: "0x01" }))),
    );
  });

  it("does not key on a nonce that has no payer beside it", () => {
    // The chain keys on payer and nonce together, so a nonce with no `from`
    // beside it falls through to the signature and changes nothing.
    const withNonce = (nonce: string) =>
      signed({ signature: "0xdeadbeef", authorization: { to: "0xbbbb", value: "1", nonce } });
    const bareSignature = signed({ signature: "0xdeadbeef" });

    expect(fingerprintOf(withNonce("0x01"))).toBe(fingerprintOf(withNonce("0x02")));
    expect(fingerprintOf(withNonce("0x01"))).toBe(fingerprintOf(bareSignature));
  });

  it("does not key on a payer that has no nonce beside it", () => {
    // Keyed on the payer alone, one payer could spend once and never again, so
    // a payer with no nonce falls through to the signature too.
    const withPayer = (from: string) =>
      signed({ signature: "0xdeadbeef", authorization: { from, to: "0xbbbb", value: "1" } });
    const bareSignature = signed({ signature: "0xdeadbeef" });

    expect(fingerprintOf(withPayer("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))).toBe(
      fingerprintOf(withPayer("0xcccccccccccccccccccccccccccccccccccccccc")),
    );
    expect(fingerprintOf(withPayer("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))).toBe(
      fingerprintOf(bareSignature),
    );
  });

  it("does not change when the agent rewrites everything it is allowed to rewrite", () => {
    // The requirements beside the payload are the agent's own unsigned copy of
    // what we asked for. If the fingerprint moved with them, one signature
    // would buy as many orders as the agent cared to relabel it for.
    const first = fingerprintOf(signed(authorised()));
    const relabelled = {
      ...signed(authorised()),
      accepted: {
        scheme: "exact",
        network: "eip155:84532" as const,
        asset: "0xdifferent",
        amount: "999",
        payTo: "0xsomebody-else",
        maxTimeoutSeconds: 1,
        extra: { order_id: "another_order" },
      },
    };

    expect(fingerprintOf(relabelled)).toBe(first);
  });

  it("does not change when a field is added beside the signed authorisation", () => {
    const first = fingerprintOf(signed(authorised()));
    const padded = signed({ ...authorised(), padding: "anything at all" });

    expect(fingerprintOf(padded)).toBe(first);
  });

  it("does not move with the protocol version the agent types", () => {
    // Nothing checks that field: the decoder is a base64 JSON parse with no
    // schema behind it. Digested, it would let one authorisation make a new
    // fingerprint, and buy a new order, for every number an agent typed.
    const two = fingerprintOf(signed(authorised()));
    for (const version of [1, 3, 0, 99]) {
      expect(fingerprintOf({ ...signed(authorised()), x402Version: version })).toBe(two);
    }
  });

  it("is a different payment on a different token", () => {
    // A token records authorizationState[authorizer][nonce] in its own
    // contract, so one payer and one nonce on two assets are two payments. The
    // token comes from our configuration and never from the payment, or the
    // agent would have its variation back.
    const here = fingerprintOf(signed(authorised()));
    const elsewhere = paymentFingerprint(signed(authorised()), {
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    });

    expect(elsewhere).not.toBe(here);
  });

  it("reads a payment that is not one without falling over", () => {
    // The decoder guarantees nothing about the payload, so a header naming a
    // known order and carrying nothing else reaches this function.
    expect(() =>
      paymentFingerprint(
        { x402Version: 2 } as unknown as Parameters<typeof paymentFingerprint>[0],
        token,
      ),
    ).not.toThrow();
  });

  it("does not mistake something that is not hex for a canonical key", () => {
    // The pair is a key only when it is written the way the chain writes one.
    // Taken loosely, a scheme whose authorisation fields are words rather than
    // hex would have those words used as the key — and two genuinely different
    // payments, with different signatures, would come out as one.
    const worded = (signature: string) => ({
      ...signed({
        signature,
        authorization: { from: "alice", to: "bob", value: "1", nonce: "the-first-one" },
      }),
    });

    expect(fingerprintOf(worded("0xaaaa"))).not.toBe(fingerprintOf(worded("0xbbbb")));
  });

  it("falls back to the signature, canonicalised, and then to the whole payload", () => {
    // Not every scheme carries an authorisation under that name; whatever it
    // does carry, two spellings of one payment have to agree.
    const shouted = fingerprintOf(signed({ signature: "0xDEADbeef" }));
    expect(fingerprintOf(signed({ signature: "0xdeadBEEF" }))).toBe(shouted);
    expect(fingerprintOf(signed({ signature: "0xdeadbeee" }))).not.toBe(shouted);

    const byPayload = fingerprintOf(signed({ proof: { b: "0xFF", a: 1 } }));
    expect(fingerprintOf(signed({ proof: { a: 1, b: "0xff" } }))).toBe(byPayload);
    expect(fingerprintOf(signed({ proof: { a: 2, b: "0xff" } }))).not.toBe(byPayload);
  });
});

describe("the discovery declaration a challenge carries", () => {
  // Whether the catalog accepts the declaration is a live call, made by
  // `pnpm smoke:listing`. Here the catalog's own code checks that the
  // declaration holds against its schema and drops nothing about the seller.
  const card = CardSchema.parse({
    merchant_item_id: "access-monthly",
    title: "Доступ к сервису на один месяц",
    description: "Доступ на 30 дней с момента выдачи, продление не входит.",
    price: { amount: "5.00", currency: "USD" },
    params: { email: { type: "string", required: true, title: "Куда прислать доступ" } },
    result: { access_url: { type: "string", title: "Ссылка для входа" } },
    fulfillment: "sync",
    tags: ["access", "subscription"],
  });

  const edge = () =>
    new PaymentEdge({
      payment: {
        facilitatorUrl: "https://x402.org/facilitator",
        network: "eip155:84532",
        payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        cdpApiKeyId: null,
        cdpApiKeySecret: null,
      },
      publicBaseUrl: "https://agentify.example",
      deadlines: { quoteTtlMs: 30_000, syncResponseMs: 10_000 },
    });

  const challenge = (listed: { serviceName: string | null }) =>
    decodePaymentRequiredHeader(
      edge().challengeFor({ amount: "5.00", currency: "USD" }, null, {
        itemId: "itm_4d21bb",
        card,
        serviceName: listed.serviceName,
        payTo: SELLERS_SPLIT,
      }),
    );

  const declaration = () =>
    challenge({ serviceName: "The pilot merchant" }).extensions?.bazaar as DiscoveryExtension;

  it("names the resource at the address this gateway was configured with", () => {
    // Not the address the request arrived at: behind a TLS terminator that is
    // http:// with the caller's query string, and a listing is keyed on the
    // resource, so two spellings would be two listings.
    expect(challenge({ serviceName: null }).resource.url).toBe(
      "https://agentify.example/x402/itm_4d21bb/purchase",
    );
  });

  it("says who is selling and what the product is filed under", () => {
    const { resource } = challenge({ serviceName: "The pilot merchant" });

    expect(resource.serviceName).toBe("The pilot merchant");
    expect(resource.tags).toStrictEqual(["access", "subscription"]);
    expect(resource.description).toBe(card.description);
  });

  it("loses nothing about the seller to the catalog's own sanitiser", () => {
    // The catalog's own sanitiser: whatever it drops would silently vanish
    // from the listing.
    const { resource } = challenge({ serviceName: "The pilot merchant" });

    expect(sanitizeResourceServiceMetadata(resource)).toStrictEqual({
      serviceName: "The pilot merchant",
      tags: ["access", "subscription"],
    });
  });

  it("loses nothing at the edge of what our own schemas allow", () => {
    // The largest values our schemas accept. Anything the sanitiser hands back
    // short of what went in is a rule of the catalog's that our schemas lack.
    const wide = CardSchema.parse({
      ...JSON.parse(JSON.stringify(card)),
      tags: ["a", "b", "c", "d", "e"].map((letter) => letter.repeat(32)),
    });
    const { resource } = decodePaymentRequiredHeader(
      edge().challengeFor({ amount: "5.00", currency: "USD" }, null, {
        itemId: "itm_4d21bb",
        card: wide,
        serviceName: "n".repeat(32),
        payTo: SELLERS_SPLIT,
      }),
    );

    expect(sanitizeResourceServiceMetadata(resource)).toStrictEqual({
      serviceName: resource.serviceName,
      tags: resource.tags,
    });
  });

  it("says nothing about a seller nobody has named", () => {
    const { resource } = challenge({ serviceName: null });

    expect("serviceName" in resource).toBe(false);
  });

  it("describes the purchase an agent actually makes, and never the probe", () => {
    // The probe is a GET, and what it returns is what an agent reads before it
    // buys. A declaration naming GET would say paying the probe delivers the
    // product, and agents take that literally; the GET branch reads no payment.
    const info = declaration().info as unknown as {
      input: Record<string, unknown>;
      output?: { example?: unknown };
    };

    expect(info.input.method).toBe("POST");
    expect(info.input.bodyType).toBe("json");
    expect(info.input.body).toStrictEqual({ params: { email: "string" } });
    expect((info.output?.example as { delivered?: unknown } | undefined)?.delivered).toStrictEqual({
      access_url: "string",
    });
  });

  it("holds together against its own schema", () => {
    // The catalog validates the declaration against the schema shipped beside
    // it, with this very function. A declaration that failed here is one the
    // catalog would refuse.
    expect(validateDiscoveryExtension(declaration())).toStrictEqual({ valid: true });
    expect(
      validateDiscoveryExtensionSpec(declaration() as unknown as Record<string, unknown>),
    ).toStrictEqual({ valid: true });
  });

  it("gives two requests for one product the same declaration", () => {
    // Two edges over a card parsed twice, so this is not one object read twice.
    // Anything that varied between challenges for one card, such as an instant
    // or a counter, would split or flicker its listing.
    const twice = () => {
      const parsed = CardSchema.parse(JSON.parse(JSON.stringify(card)));
      return JSON.stringify(
        decodePaymentRequiredHeader(
          edge().challengeFor({ amount: "5.00", currency: "USD" }, null, {
            itemId: "itm_4d21bb",
            card: parsed,
            serviceName: "A seller",
            payTo: SELLERS_SPLIT,
          }),
        ),
      );
    };

    expect(twice()).toBe(twice());
  });

  it("still says which order it is for", () => {
    // The order identifier travels in `extra` beside the declaration; it is
    // what a payment names.
    const forOrder = decodePaymentRequiredHeader(
      edge().challengeFor({ amount: "5.00", currency: "USD" }, "ord_1", {
        itemId: "itm_4d21bb",
        card,
        serviceName: null,
        payTo: SELLERS_SPLIT,
      }),
    );

    expect(forOrder.accepts[0]?.extra?.order_id).toBe("ord_1");
  });
});

describe("a parcel's challenge", () => {
  // A parcel's card price is the goods alone; the purchase adds shipping to the
  // address it names. The challenge says which the agent is reading, in the
  // gateway's own words rather than the merchant's description.
  const parcel = CardSchema.parse({
    merchant_item_id: "coffee-1kg",
    title: "Coffee beans, one kilogram",
    description: "Single-origin beans, roasted to order.",
    price: { amount: "18.00", currency: "USD" },
    fulfillment: "ship",
    ship_within_seconds: 172_800,
    price_check: "handler",
  });
  const edge = new PaymentEdge({
    payment: {
      facilitatorUrl: "https://x402.org/facilitator",
      network: "eip155:84532",
      payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      cdpApiKeyId: null,
      cdpApiKeySecret: null,
    },
    publicBaseUrl: "https://agentify.example",
    deadlines: { quoteTtlMs: 30_000, syncResponseMs: 10_000 },
  });
  const listed = {
    itemId: "itm_parcel",
    card: parcel,
    serviceName: null,
    payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  };

  it("says the listed price is the goods alone before any address is named", () => {
    const { error, resource } = decodePaymentRequiredHeader(
      edge.challengeFor({ amount: "18.00", currency: "USD" }, null, listed, "payment required"),
    );

    expect(error).toContain("goods alone");
    expect(resource.description).toBe(parcel.description);
  });

  it("says the amount asked includes shipping once the purchase names an address", () => {
    const { error } = decodePaymentRequiredHeader(
      edge.challengeFor({ amount: "21.00", currency: "USD" }, "ord_1", listed, "payment required"),
    );

    expect(error).toContain("includes shipping");
  });
});

describe("a card's challenge at its widest", () => {
  // Publishing refuses a card by this measure, so it must never fall short of a
  // challenge the card is answered with later, whatever its merchant is renamed
  // to, its order is priced at, or the reason the challenge gives.
  const edge = new PaymentEdge({
    payment: {
      facilitatorUrl: "https://x402.org/facilitator",
      network: "eip155:84532",
      payTo: null,
      cdpApiKeyId: null,
      cdpApiKeySecret: null,
    },
    publicBaseUrl: "https://agentify.example",
    deadlines: { quoteTtlMs: 30_000, syncResponseMs: 10_000 },
  });
  const cards = [
    CardSchema.parse({
      merchant_item_id: "room-101",
      title: "A room for the night",
      description: "One night in room 101",
      price: { amount: "80.00", currency: "USD" },
      params: { nights: { type: "integer", required: true } },
      result: { access_code: { type: "string" } },
    }),
    CardSchema.parse({
      merchant_item_id: "coffee-1kg",
      title: "Coffee beans, one kilogram",
      description: "Single-origin beans, roasted to order.",
      price: { amount: "18.00", currency: "USD" },
      fulfillment: "ship",
      ship_within_seconds: 172_800,
      price_check: "handler",
    }),
  ];

  /** The widest amount an order can be priced at: every whole digit an amount may carry. */
  const WIDEST_AMOUNT = `${"9".repeat(18)}.${"9".repeat(PAYABLE_DECIMALS)}`;

  it("is exactly as wide as the widest challenge the card can be answered with", () => {
    // Narrower would let a card past the bound that is later answered over it;
    // wider would refuse cards whose every challenge fits.
    expect(AmountSchema.safeParse(WIDEST_AMOUNT).success).toBe(true);
    expect(AmountSchema.safeParse(`9${WIDEST_AMOUNT}`).success).toBe(false);
    for (const card of cards) {
      const answered = Object.values(CHALLENGE_REASONS).flatMap((why) =>
        [null, randomIds("ord")].map(
          (orderId) =>
            edge.challengeFor(
              { amount: WIDEST_AMOUNT, currency: "USD" },
              orderId,
              {
                itemId: randomIds("item"),
                card,
                serviceName: '"'.repeat(32),
                payTo: SELLERS_SPLIT,
              },
              why,
            ).length,
        ),
      );

      expect(edge.widestChallengeFor(card), card.fulfillment).toBe(Math.max(...answered));
    }
  });
});

describe("the shape a live validation once accepted", () => {
  /**
   * The schema half of a declaration the CDP validation endpoint once accepted
   * for a POST resource whose paid address also answers GET, as ours does.
   * Comparing shapes against it is not a validation; `pnpm smoke:listing`
   * makes the live call. It is kept for one fact: the dialect is named once, at
   * the root. The rest legitimately differs, since that body schema was written
   * by hand and ours is rendered from the card.
   */
  const acceptedSchemaOnPost = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    properties: {
      input: {
        additionalProperties: false,
        properties: {
          body: {
            properties: {
              country: { description: "ISO 3166-1 alpha-2 country code", type: "string" },
            },
            required: ["country"],
          },
          bodyType: { enum: ["json", "form-data", "text"], type: "string" },
          method: { enum: ["POST"], type: "string" },
          type: { const: "http", type: "string" },
        },
        required: ["type", "method", "bodyType", "body"],
        type: "object",
      },
      output: {
        properties: { example: { type: "object" }, type: { type: "string" } },
        required: ["type"],
        type: "object",
      },
    },
    required: ["input"],
    type: "object",
  };

  /** Every path through an object, with the leaves replaced by their types. */
  const skeleton = (value: unknown, at = ""): string[] => {
    if (Array.isArray(value)) {
      return value.length === 0
        ? [`${at}: []`]
        : value.flatMap((held, index) => skeleton(held, `${at}[${index}]`));
    }
    if (typeof value === "object" && value !== null) {
      const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
      // An empty object is a fact about the shape and has no paths under it, so
      // it is written out rather than vanishing.
      return entries.length === 0
        ? [`${at}: {}`]
        : entries.flatMap(([name, held]) => skeleton(held, at === "" ? name : `${at}.${name}`));
    }
    return [`${at}: ${typeof value}`];
  };

  const ourDeclaration = () => {
    const card = CardSchema.parse({
      merchant_item_id: "numbers-rent",
      title: "A virtual number",
      description: "Rent a virtual phone number for inbound SMS in the given country.",
      price: { amount: "2.00", currency: "USD" },
      params: { country: { type: "string", required: true } },
      result: {
        number: { type: "string" },
        messages_url: { type: "string" },
        expires_at: { type: "string" },
      },
      fulfillment: "sync",
    });
    const edge = new PaymentEdge({
      payment: {
        facilitatorUrl: "https://x402.org/facilitator",
        network: "eip155:84532",
        payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        cdpApiKeyId: null,
        cdpApiKeySecret: null,
      },
      publicBaseUrl: "https://agentify.example",
      deadlines: { quoteTtlMs: 30_000, syncResponseMs: 10_000 },
    });
    const decoded = decodePaymentRequiredHeader(
      edge.challengeFor({ amount: "2.00", currency: "USD" }, null, {
        itemId: "itm_1",
        card,
        serviceName: "Freeland",
        payTo: SELLERS_SPLIT,
      }),
    );
    const declared = decoded.extensions?.bazaar as DiscoveryExtension | undefined;
    if (declared === undefined) throw new Error("the challenge carried no declaration");
    return declared;
  };

  it("names the schema dialect where the accepted shape names it, and nowhere else", () => {
    // The purchase body schema is rendered on its own and names its dialect;
    // nested, that would be a second declaration where the accepted shape has
    // none, so it is dropped.
    const dialectsIn = (schema: unknown) =>
      skeleton(schema).filter((path) => path.includes("$schema"));

    expect(dialectsIn(ourDeclaration().schema)).toStrictEqual(["$schema: string"]);
    expect(dialectsIn(acceptedSchemaOnPost)).toStrictEqual(dialectsIn(ourDeclaration().schema));
  });
});
