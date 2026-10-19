import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import type { Card, MerchantCardList, Receipt } from "@nuanu-ai/agentify-contracts";
import { API_ROUTES, ERROR_CODES, mountableRoutes } from "@nuanu-ai/agentify-contracts";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { setSellerSite, setServiceName } from "../app/merchants.js";
import {
  buyOverHttp,
  type Harness,
  harness,
  type Served,
  serve,
  theMerchantKey,
  workUntilStopped,
} from "../testing/harness.js";
import { buildApp, refusal } from "./server.js";
import { ORDER_ID_IN_EXTRA, PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER } from "./x402.js";

/**
 * The files that hold every refusal this gateway sends, read as source text
 * because one case below asks which codes are written in them.
 */
const routesSource = readFileSync(new URL("./routes.ts", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
const merchantAnswersSource = readFileSync(
  new URL("./merchant-answers.ts", import.meta.url),
  "utf8",
);

/**
 * The seeded merchant's key, taken from the harness rather than spelled again,
 * so the two cannot drift apart.
 */
const KEY = theMerchantKey("test");
const PAY_TO = "0x0000000000000000000000000000000000000001";

const syncCard: Card = {
  merchant_item_id: "SKU 100/1",
  title: "A room for the night",
  description: "One night in room 101",
  price: { amount: "80.00", currency: "USD" },
  result: { access_code: { type: "string" } },
  fulfillment: "sync",
};

let open: { harnessed: Harness; served: Served } | null = null;

const started = async (overrides: Record<string, string> = {}) => {
  const harnessed = await harness({ PAY_TO_ADDRESS: PAY_TO, ...overrides });
  const served = await serve(harnessed);
  open = { harnessed, served };
  return open;
};

afterEach(async () => {
  await open?.served.close();
  await open?.harnessed.stop();
  open = null;
});

const asMerchant = { authorization: `Bearer ${KEY}` };

const publish = async (served: Served, card: Card): Promise<string> => {
  const answered = await served.call("POST", "/v0/catalog/publish", {
    body: card,
    headers: asMerchant,
  });
  expect(answered.status).toBe(200);
  return (answered.body as { id: string }).id;
};

describe("the surface is the table", () => {
  it("serves every call the contract says may be served", async () => {
    // Catches a route express mounts but does not match at its own literal path,
    // which would answer "no such call" at the address the contract publishes.
    // The poll window is a millisecond so the long-poll route does not hold the
    // test open.
    const { served } = await started({ WORKER_POLL_WAIT_MS: "1" });

    for (const [, route] of mountableRoutes()) {
      const path = route.path.replaceAll(/:([a-z_]+)/g, "placeholder");
      const answered = await served.call(route.method, path, {
        headers: asMerchant,
        ...(route.request === undefined ? {} : { body: {} }),
      });
      // "No such order" is fine; "no call at this address" is not.
      expect(
        (answered.body as { error?: { code?: string } })?.error?.code,
        `${route.method} ${route.path}`,
      ).not.toBe("no_such_route");
    }
  });

  it("puts the merchant's door on the merchant's calls and on no other", async () => {
    // Every call is made with no key: the merchant's are turned away and nothing
    // else is. It runs over the whole table because a key check attached to an
    // address prefix happens to line up with today's routes, and the next route
    // need not. Any turn-away counts, not just 401: a prefix check may be someone
    // else's middleware answering 403 or redirecting to a sign-in.
    const turnedAway = new Set([401, 403, 407, 302, 303, 307]);
    const { served } = await started({ WORKER_POLL_WAIT_MS: "1" });

    for (const [name, route] of mountableRoutes()) {
      const path = route.path.replaceAll(/:([a-z_]+)/g, "placeholder");
      const answered = await served.call(route.method, path, {
        ...(route.request === undefined ? {} : { body: {} }),
      });

      expect(
        turnedAway.has(answered.status),
        `${name} with no key answered ${answered.status}`,
      ).toBe(route.auth === "merchant_key");
    }
  });

  it("will not mount a route whose door nobody has chosen, whoever hands it over", async () => {
    // The mounted list already filters these out; this holds even when one is
    // handed over by name, so a door nobody chose cannot be opened by editing a
    // list.
    const { harnessed } = await started();

    expect(() =>
      buildApp(harnessed.gateway, [
        ["list_catalog" as never, { ...API_ROUTES.list_catalog, auth: "undecided" as const }],
      ]),
    ).toThrow(/undecided/);
  });

  it("will not start when the table names a call nothing serves", async () => {
    // The route below stands in for a call added to the contract and never
    // implemented; the same guard runs over the real table on every start.
    const { harnessed } = await started();

    expect(() =>
      buildApp(harnessed.gateway, [["a_call_nobody_serves" as never, API_ROUTES.list_catalog]]),
    ).toThrow(/nothing to serve it with/);
  });

  it("answers the health check while the process is up, with no key on it", async () => {
    // `compose.yaml` and whatever routes in front of the gateway health-check
    // this address, so a key check or a changed answer here takes a working
    // gateway out of rotation. It promises only that the process is up: a
    // gateway whose queue schema was dropped still answers 200 here.
    const { served } = await started();

    const answered = await served.call("GET", "/healthz");

    expect(answered.status).toBe(200);
    expect(answered.body).toStrictEqual({ ok: true });
  });

  it("leads an agent that asks the storefront's own root to the catalogue", async () => {
    // An agent given only the site tries the root first, and "no call here"
    // reads to it as nothing to buy.
    const { served } = await started();

    const answered = await served.call("GET", "/x402");

    expect(answered.status).toBe(200);
    expect(Array.isArray((answered.body as { items?: unknown }).items)).toBe(true);
  });

  it("has nothing at the versioned addresses the storefront used to answer at", async () => {
    // Removed, not redirected: a discovery catalog keys a listing on the address
    // it was given, so an old address that still answered would keep a second
    // identity listed for the same product.
    const { served } = await started();
    const itemId = await publish(served, syncCard);

    const gone = [
      ["GET", `/v0/items/${itemId}/purchase`],
      ["POST", `/v0/items/${itemId}/purchase`],
      ["GET", "/v0/catalog"],
      ["GET", "/v0/orders/ord_whatever/status"],
    ] as const;

    for (const [method, path] of gone) {
      const answered = await served.call(method, path, {
        ...(method === "POST" ? { body: { params: {} } } : {}),
      });
      expect(answered.status, `${method} ${path}`).toBe(404);
      expect(
        (answered.body as { error?: { code?: string } })?.error?.code,
        `${method} ${path}`,
      ).toBe("no_such_route");
    }
  });
});

describe("what a call answers with", () => {
  it("refuses to send a document the contract would not recognise", async () => {
    // Responses are held to the schema the SDK reads them with. The route below
    // names a different document for the catalog, as a drift between the two
    // sides would.
    const { harnessed } = await started();

    const app = buildApp(harnessed.gateway, [
      [
        "list_catalog" as never,
        {
          ...API_ROUTES.list_catalog,
          response: { document: z.strictObject({ nothing_like_a_catalog: z.string() }) },
        },
      ],
    ]);
    // On the address it is called at; `serve` in the harness says why.
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const answered = await fetch(`http://127.0.0.1:${port}/x402/catalog`);
      expect(answered.status).toBe(500);
      // The only retryable refusal on this surface: the call failed inside us,
      // so making it again is not repeating a mistake.
      expect((await answered.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "gateway_failed", retryable: true },
      });
    } finally {
      server.close();
    }
  });

  it("will not let a refusal's own detail take the place of its reason", () => {
    // Detail comes from elsewhere and often carries its own "message". The
    // parameter is typed unknown, so the compiler would let it overwrite the
    // refusal's own sentence.
    const refused = refusal("payment_not_verified", "the payment layer would not vouch for this", {
      message: "the facilitator's own words about its own call",
      retryable: true,
    });

    expect(refused.error.message).toBe("the payment layer would not vouch for this");
    expect(refused.error.code).toBe("payment_not_verified");
    expect(refused.error.retryable).toBe(true);
  });

  it("tells a caller a definitive refusal is definitive, on the wire", async () => {
    // A missing route will not appear between attempts, so a caller told
    // "retryable" would loop forever. Read off the body a client receives.
    const { served } = await started();

    const answered = await served.call("GET", "/v0/nothing-is-here");

    expect(answered.status).toBe(404);
    expect(answered.body).toStrictEqual({
      error: {
        code: "no_such_route",
        message: "there is no call at this address",
        retryable: false,
      },
    });
  });

  it("sends every code the contract publishes, and publishes every code it sends", () => {
    // The compiler already rejects a code the contract lacks, since refusal()
    // takes an ErrorCode. What it cannot see is a published code nothing sends,
    // which a consumer writes a branch for and never reaches.
    const written = [routesSource, serverSource, merchantAnswersSource].join("\n");
    const unsent = ERROR_CODES.filter((code) => !written.includes(`"${code}"`));

    expect(
      unsent,
      "the contract publishes these codes and this gateway sends none of them: a consumer switching over the list writes a branch it will never reach",
    ).toStrictEqual([]);
  });
});

describe("the merchant's door", () => {
  it("turns away a call with no key, a wrong key and a key of the wrong length alike", async () => {
    const { served } = await started();

    const attempts: Record<string, string>[] = [
      {},
      { authorization: "Bearer wrong-key-of-the-right-length" },
      { authorization: "Bearer x" },
      // The key with no scheme in front of it, which is the mistake a merchant
      // actually makes.
      { authorization: KEY },
    ];

    for (const headers of attempts) {
      const answered = await served.call("GET", "/v0/orders", { headers });
      expect(answered.status).toBe(401);
      // Nothing about which part was wrong, or whether a key arrived at all.
      expect(JSON.stringify(answered.body)).not.toContain(KEY);
    }
  });

  it("lets the merchant's own key through, however the scheme is spelled", async () => {
    const { served } = await started();

    expect((await served.call("GET", "/v0/orders", { headers: asMerchant })).status).toBe(200);
    expect(
      (await served.call("GET", "/v0/orders", { headers: { authorization: `bearer ${KEY}` } }))
        .status,
    ).toBe(200);
  });

  it("asks nobody for a key on the calls an agent makes", async () => {
    const { served } = await started();
    expect((await served.call("GET", "/x402/catalog")).status).toBe(200);
  });
});

describe("what a call may carry", () => {
  it("refuses a body that is not the document the table names, and says what is wrong", async () => {
    // Every body is held to its route's schema, so a wrong document is refused
    // at the door rather than misbehaving further in.
    const { served } = await started();

    const answered = await served.call("POST", "/v0/quotes/prc_1/answer", {
      body: { available: true },
      headers: asMerchant,
    });

    expect(answered.status).toBe(400);
    const { error } = answered.body as { error: { code: string; problems: { path: string[] }[] } };
    expect(error.code).toBe("malformed_body");
    expect(error.problems.length).toBeGreaterThan(0);
  });

  it("lets a card's own findings come back in the shape the contract designed for them", async () => {
    // Publishing is the one call whose answer has a place for what is wrong
    // with what arrived. A generic refusal would put the findings in the
    // gateway's own shape and the merchant would never see the branch the
    // contract wrote for them.
    const { served } = await started();

    const answered = await served.call("POST", "/v0/catalog/publish", {
      body: { merchant_item_id: 7 },
      headers: asMerchant,
    });

    expect(answered.status).toBe(422);
    const { problems } = (
      answered.body as { error: { problems: { path: string[]; message: string }[] } }
    ).error;
    expect(problems.length).toBeGreaterThan(1);
    expect(problems.map((finding) => finding.path.join("."))).toContain("merchant_item_id");
  });

  it("refuses a price answer it could not charge, in the words a merchant's worker prints", async () => {
    // A price answer is held to the rule a card's price is held to at
    // publication. The message names the bad value because it is the one line a
    // merchant's worker log shows.
    const { served } = await started();

    const refused: [price: unknown, field: string, found: string][] = [
      [{ amount: "0", currency: "USD" }, "amount", "0"],
      [{ amount: "0.00", currency: "USD" }, "amount", "0.00"],
      [{ amount: "0.000000", currency: "USD" }, "amount", "0.000000"],
      [{ amount: "500", currency: "USD" }, "amount", "500"],
      [{ amount: "5", currency: "USD" }, "amount", "5"],
      [{ amount: "5.0", currency: "USD" }, "amount", "5.0"],
      [{ amount: "0.0000001", currency: "USD" }, "amount", "0.0000001"],
      [{ amount: "5.00", currency: "EUR" }, "currency", "EUR"],
    ];

    for (const [price, field, found] of refused) {
      const answered = await served.call("POST", "/v0/quotes/prc_1/answer", {
        body: { available: true, price, as_of: "2026-08-26T10:15:00Z" },
        headers: asMerchant,
      });

      expect(answered.status, JSON.stringify(price)).toBe(400);
      const { error } = answered.body as {
        error: { code: string; message: string; problems: { path: string[] }[] };
      };
      expect(error.code).toBe("malformed_body");
      expect(error.message, JSON.stringify(price)).toContain(JSON.stringify(found));
      expect(error.problems.map((finding) => finding.path.join("."))).toContain(`price.${field}`);
    }
  });

  it("takes a price answer a payment can be taken at, the portal's own example among them", async () => {
    // Nothing is held under prc_1, so each answer is taken and prices nothing:
    // `used: false`, which is not a refusal.
    const { served } = await started();
    const portal: unknown = JSON.parse(
      readFileSync(
        new URL("../../../docs/examples/quote-response/available.json", import.meta.url),
        "utf8",
      ),
    );
    const answers = [
      portal,
      ...[
        { amount: "0.01", currency: "USD" },
        { amount: "0.001", currency: "USD" },
        { amount: "19.999", currency: "USD" },
        { amount: "0.000001", currency: "USD" },
        { amount: "5.00", currency: "USDC" },
      ].map((price) => ({ available: true, price, as_of: "2026-08-26T10:15:00Z" })),
    ];

    for (const body of answers) {
      const answered = await served.call("POST", "/v0/quotes/prc_1/answer", {
        body,
        headers: asMerchant,
      });

      expect(answered.status, JSON.stringify(body)).toBe(200);
      expect(answered.body).toStrictEqual({ used: false });
    }
  });

  it("reads back a card stored before the door refused its price", async () => {
    // The price rule lives at the door, not in the card schema. Responses are
    // validated on the way out, so a schema rule would fail the whole list of a
    // merchant holding a zero-priced card stored before the rule.
    const { harnessed, served } = await started();
    await harnessed.store.publishCard(
      harnessed.merchant.id,
      { ...syncCard, price: { amount: "0.00", currency: "USD" } },
      harnessed.now(),
    );

    const listed = await served.call("GET", "/v0/cards", { headers: asMerchant });

    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).toContain('"0.00"');
  });

  it("refuses a query the table does not describe", async () => {
    const { served } = await started();

    const answered = await served.call("GET", "/v0/orders?open=1", { headers: asMerchant });

    expect(answered.status).toBe(400);
    expect((answered.body as { error: { code: string } }).error.code).toBe("malformed_query");
  });

  it("answers a card that will not do with the contract's own findings", async () => {
    const { served } = await started();

    const answered = await served.call("POST", "/v0/catalog/publish", {
      body: { ...syncCard, fulfillment: "confirm" },
      headers: asMerchant,
    });

    expect(answered.status).toBe(422);
    expect(JSON.stringify(answered.body)).toContain("no shape on the wire yet");
  });

  it("carries an identifier with a slash in it through the address unharmed", async () => {
    // The contract accepts "SKU 100/1" as an identifier. Pasted into an address
    // unencoded it becomes two path segments and a different route.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);

    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;

    const answered = await served.call("GET", `/v0/orders/${encodeURIComponent(orderId)}`, {
      headers: asMerchant,
    });

    expect(answered.status).toBe(200);
    expect((answered.body as { merchant_item_id: string }).merchant_item_id).toBe("SKU 100/1");
  });
});

describe("the payment challenge", () => {
  it("answers a GET with a price and never with a purchase", async () => {
    // The validators and crawlers that list a paid resource ask for it with
    // GET. A paywall bound to one method makes the resource invisible to them,
    // and a GET carries no body, so it can produce a challenge and nothing else.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);

    const answered = await served.call("GET", `/x402/${itemId}/purchase`);

    expect(answered.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    expect(challenge.x402Version).toBe(2);
    expect(challenge.accepts[0]?.amount).toBe("80000000");
    // The seller's own split, recorded with their wallet, not the operator's
    // configured address; `payout-wallet.test.ts` covers this properly.
    const split = (await harnessed.store.merchantById(harnessed.merchant.id))?.payoutWallet.split;
    expect(split?.merchantWallet).toBe(harnessed.merchant.wallet);
    expect(challenge.accepts[0]?.payTo).toBe(split?.address);
    expect(challenge.accepts[0]?.network).toBe("eip155:84532");
    expect(await harnessed.store.orders(harnessed.merchant.id)).toStrictEqual([]);
  });

  it("asks for the smallest price the door takes, exactly", async () => {
    // The finest price publication accepts is one unit of the payment token,
    // and the challenge must ask for exactly that unit.
    const { served } = await started();
    const itemId = await publish(served, {
      ...syncCard,
      price: { amount: "0.000001", currency: "USD" },
    });

    const answered = await served.call("GET", `/x402/${itemId}/purchase`);

    expect(answered.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    expect(challenge.accepts[0]?.amount).toBe("1");
  });

  it("prices a POST against an order it opened, and says which order", async () => {
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);

    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });

    expect(answered.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    const named = challenge.accepts[0]?.extra?.[ORDER_ID_IN_EXTRA];
    const orders = await harnessed.store.orders(harnessed.merchant.id);
    expect(orders).toHaveLength(1);
    expect(named).toBe(orders[0]?.order.id);
  });

  it("names, on a GET, the method and body a purchase is made with", async () => {
    // An agent buys the way a GET's declaration says. One naming GET would send
    // it back to the probe, which reads no payment.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);

    const probed = await served.call("GET", `/x402/${itemId}/purchase`);
    const declared = decodePaymentRequiredHeader(probed.headers.get(PAYMENT_REQUIRED_HEADER) ?? "")
      .extensions?.bazaar as {
      info: { input: { method: string; bodyType?: string; body?: unknown } };
    };
    expect(declared.info.input.bodyType).toBe("json");

    const bought = await served.call(declared.info.input.method, `/x402/${itemId}/purchase`, {
      body: declared.info.input.body,
    });

    expect(bought.status).toBe(402);
    const named = decodePaymentRequiredHeader(bought.headers.get(PAYMENT_REQUIRED_HEADER) ?? "")
      .accepts[0]?.extra?.[ORDER_ID_IN_EXTRA];
    const orders = await harnessed.store.orders(harnessed.merchant.id);
    expect(orders).toHaveLength(1);
    expect(named).toBe(orders[0]?.order.id);
  });

  it("answers a POST that brought no document as it answers a GET: a price, and no order", async () => {
    // The catalog's validator, like everything built on the official x402
    // server, probes with an empty POST and expects the challenge before any
    // body is read. A 400 here keeps the product out of the catalog.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);

    const answered = await served.call("POST", `/x402/${itemId}/purchase`);

    expect(answered.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    expect(challenge.accepts[0]?.amount).toBe("80000000");
    expect(challenge.accepts[0]?.extra?.[ORDER_ID_IN_EXTRA]).toBeUndefined();
    expect(await harnessed.store.orders(harnessed.merchant.id)).toStrictEqual([]);
  });

  it("answers an unpaid POST that carries an empty document the same way", async () => {
    // The validator's own probe: a POST declaring a JSON body and carrying none,
    // which the parser hands over as an empty document. Unpaid, it is a probe
    // and not a purchase.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);

    const answered = await served.call("POST", `/x402/${itemId}/purchase`, { body: {} });

    expect(answered.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    expect(challenge.accepts[0]?.extra?.[ORDER_ID_IN_EXTRA]).toBeUndefined();
    expect(await harnessed.store.orders(harnessed.merchant.id)).toStrictEqual([]);
  });

  it("refuses an unpaid POST whose document is of some other shape, naming the fields", async () => {
    // A wrong document, unlike an empty one, is a mistake: the agent is told
    // which fields before it signs anything, as it would be for parameters that
    // do not fit the card.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);

    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { parameters: {} },
    });

    expect(answered.status).toBe(400);
    expect((answered.body as { error: { code: string } }).error.code).toBe("malformed_body");
    expect(JSON.stringify(answered.body)).toContain("params");
    expect(await harnessed.store.orders(harnessed.merchant.id)).toStrictEqual([]);
  });

  it("refuses a body it could not read as JSON by saying so, not by pricing it", async () => {
    // The parser leaves a body of another content-type unread, which looks like
    // an absent body, and an absent body is the probe. The refusal names the
    // content-type rather than a missing field.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);

    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
      headers: { "content-type": "text/plain" },
    });

    expect(answered.status).toBe(400);
    expect((answered.body as { error: { code: string } }).error.code).toBe("malformed_body");
    expect((answered.body as { error: { message: string } }).error.message).toMatch(/content-type/);
    expect(await harnessed.store.orders(harnessed.merchant.id)).toStrictEqual([]);
  });

  it("refuses a paid POST whose document is not the purchase, naming the fields", async () => {
    // With a payment on the call an order is about to open, so a document that
    // is not the purchase is refused with its fields named.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);

    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { nope: 1 },
      headers: { [PAYMENT_SIGNATURE_HEADER]: "this-is-not-a-payment" },
    });

    expect(answered.status).toBe(400);
    expect((answered.body as { error: { code: string } }).error.code).toBe("malformed_body");
    expect(JSON.stringify(answered.body)).toContain("params");
    expect(await harnessed.store.orders(harnessed.merchant.id)).toStrictEqual([]);
  });

  it("tells a GET that brought a payment that the purchase is a POST", async () => {
    // A GET is the probe and reads no payment. Without this line an agent that
    // paid it cannot tell its payment being ignored from its payment failing.
    // The unpaid probe's error line stays as it is.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);
    const probed = await served.call("GET", `/x402/${itemId}/purchase`);
    const offered = decodePaymentRequiredHeader(probed.headers.get(PAYMENT_REQUIRED_HEADER) ?? "");
    expect(offered.error).not.toMatch(/POST/);

    const paidProbe = await served.call("GET", `/x402/${itemId}/purchase`, {
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: offered.accepts[0] ?? {},
          payload: {
            signature: "0xsigned",
            authorization: {
              from: `0x${"a".repeat(40)}`,
              to: PAY_TO,
              value: "80000000",
              nonce: "0x01",
            },
          },
        } as never),
      },
    });

    expect(paidProbe.status).toBe(402);
    const told = decodePaymentRequiredHeader(paidProbe.headers.get(PAYMENT_REQUIRED_HEADER) ?? "");
    expect(told.error).toMatch(/GET/);
    expect(told.error).toMatch(/POST/);
    expect(told.error).toMatch(/body/);
    expect(await harnessed.store.orders(harnessed.merchant.id)).toStrictEqual([]);
  });

  it("prices a fresh order when a payment names one this gateway is not holding", async () => {
    // An agent that built its own requirements rather than accepting ours gets
    // a price we issued, which is the only kind we can check a payment against.
    const { served } = await started();
    const itemId = await publish(served, syncCard);
    const invented = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount: "1",
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { [ORDER_ID_IN_EXTRA]: "ord_from_nowhere" },
      },
      payload: {},
    });

    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: invented },
    });

    expect(answered.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    expect(challenge.error).toMatch(/did not name an order this gateway is holding/);
  });

  it("says so when a payment header could not be read at all", async () => {
    // Answered with a fresh price, like a header naming an order we are not
    // holding. Without a word about the payment the agent cannot tell that its
    // own encoding is at fault, and every retry fails the same way.
    const { served } = await started();
    const itemId = await publish(served, syncCard);

    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: "this-is-not-a-payment" },
    });

    expect(answered.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    expect(challenge.error).toMatch(/could not be read/);
  });

  it("says nothing about a payment when none was presented", async () => {
    // The negative control: a first call presents no payment, so a word about
    // one would be a claim about a payment that never existed.
    const { served } = await started();
    const itemId = await publish(served, syncCard);

    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });

    expect(answered.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    expect(challenge.error).toBeUndefined();
  });

  it("reads a payment that is not one without falling over", async () => {
    // The decoder is a base64 JSON parse with no schema, so a header naming a
    // real order and nothing else reaches every line that reads a payment. It
    // must get the ordinary refusal, not a failure that tells the agent the
    // route is broken.
    const { served, harnessed } = await started();
    harnessed.facilitator.willRefuseVerification("signature", "that is not a payment");
    const itemId = await publish(served, syncCard);
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");

    const nonsense = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: { extra: { order_id: offered.order.order.id } },
      }),
      "utf8",
    ).toString("base64");

    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: nonsense },
    });

    expect(answered.status).toBe(409);
    expect((answered.body as { error: { code: string } }).error.code).toBe("payment_not_verified");
    // The order it named was not closed by a payment that could not be read.
    expect((await harnessed.store.orderById(offered.order.order.id))?.order.state).toBe("quoted");
  });

  it("has nothing to sell under an identifier nobody published", async () => {
    const { served } = await started();
    expect((await served.call("GET", "/x402/item_nope/purchase")).status).toBe(404);
    expect(
      (await served.call("POST", "/x402/item_nope/purchase", { body: { params: {} } })).status,
    ).toBe(404);
  });
});

describe("a card whose payment challenge would be too large to read", () => {
  /** The most bytes a card's challenge header may take at publication. */
  const LIMIT = 8_192;

  const declaring = (count: number): Card => ({
    ...syncCard,
    merchant_item_id: `declaring-${count}`,
    params: Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`field_${index}`, { type: "string" }]),
    ),
  });

  it("is refused at publication, with how large its challenge would be and the limit it passes", async () => {
    const { served, harnessed } = await started();

    const answered = await served.call("POST", "/v0/catalog/publish", {
      body: declaring(256),
      headers: asMerchant,
    });

    expect(answered.status).toBe(422);
    const { error } = answered.body as {
      error: { code: string; problems: { path: string[]; code: string; message: string }[] };
    };
    expect(error.code).toBe("card_rejected");
    expect(error.problems).toEqual([
      expect.objectContaining({ path: [], code: "challenge_too_large" }),
    ]);
    const named = (error.problems[0]?.message.match(/\d+/g) ?? []).map(Number);
    expect(named).toContain(LIMIT);
    expect(Math.max(...named)).toBeGreaterThan(LIMIT);
    expect((await harnessed.gateway.catalog()).items).toEqual([]);
  });

  it("is published just under the limit, and still answered within it once its merchant takes the widest name", async () => {
    // The largest card the door takes, found by asking it; the merchant then
    // renames themselves to the widest listing name the rule admits, which a
    // card already published must survive. The harness's identifiers are
    // shorter than the stores', so the measure's own widths are held in the
    // edge's tests.
    const { served, harnessed } = await started();
    let accepted = { count: 1, id: await publish(served, declaring(1)) };
    let refused = 256;
    while (refused - accepted.count > 1) {
      const count = Math.floor((accepted.count + refused) / 2);
      const answered = await served.call("POST", "/v0/catalog/publish", {
        body: declaring(count),
        headers: asMerchant,
      });
      if (answered.status === 200) accepted = { count, id: (answered.body as { id: string }).id };
      else refused = count;
    }
    await setServiceName(harnessed.store, harnessed.merchant.id, "\\".repeat(32), Date.now());
    const namingNoHeldOrder = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount: "1",
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { [ORDER_ID_IN_EXTRA]: "ord_from_nowhere" },
      },
      payload: {},
    });
    const purchase = `/x402/${accepted.id}/purchase`;

    for (const answered of [
      await served.call("GET", purchase),
      await served.call("GET", purchase, {
        headers: { [PAYMENT_SIGNATURE_HEADER]: namingNoHeldOrder },
      }),
      await served.call("POST", purchase, {
        body: { params: {} },
        headers: { [PAYMENT_SIGNATURE_HEADER]: namingNoHeldOrder },
      }),
    ]) {
      expect(answered.status).toBe(402);
      expect(answered.headers.get(PAYMENT_REQUIRED_HEADER)?.length).toBeLessThanOrEqual(LIMIT);
    }
  });
});

describe("a purchase over HTTP, from the catalog to the goods", () => {
  it("names, on each product in the catalog, the address it is bought at", async () => {
    // An agent that holds only the catalog must be able to buy from it, so the
    // address comes whole from the gateway's configured address and is the one
    // the payment challenge then names as the resource paid for.
    const { served } = await started({ PUBLIC_BASE_URL: "https://agentify.ad" });
    const itemId = await publish(served, syncCard);

    const listed = await served.call("GET", "/x402/catalog");
    const [item] = (listed.body as { items: { id: string; purchase_url?: unknown }[] }).items;

    expect(item?.id).toBe(itemId);
    expect(item?.purchase_url).toBe(`https://agentify.ad/x402/${itemId}/purchase`);
    // The gateway under test listens on loopback, so only the path of the
    // address it named can be called here.
    const priced = await served.call("POST", new URL(String(item?.purchase_url)).pathname, {
      body: { params: {} },
    });
    expect(priced.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    expect(challenge.resource.url).toBe(item?.purchase_url);
  });

  it("tells the agent the purchase is over when the merchant refuses", async () => {
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);
    const priced = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });
    const requirements = decodePaymentRequiredHeader(
      priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    ).accepts[0];
    if (requirements === undefined) throw new Error("no payment option was offered");

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ refused: { code: "out_of_stock", message: "the room is taken" } }),
    });
    const refused = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: requirements,
          payload: { signature: "0xsigned" },
        }),
      },
    });
    await worker.stop();

    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ status: "rejected" });
    expect(harnessed.facilitator.settles).toHaveLength(0);
  });
});

describe("what an agent is told when the money is not settled", () => {
  it("does not answer a synchronous purchase with a success it has no goods for", async () => {
    // A charge that went out and never reported back. Answered as in progress,
    // an agent would wait on an order nothing is working on, not knowing whether
    // it was charged.
    const { served, harnessed } = await started({
      QUOTE_RESPONSE_MS: "50",
      SYNC_RESPONSE_MS: "200",
      SETTLE_RESPONSE_MS: "100",
      SYNC_BUDGET_MS: "300",
    });
    harnessed.facilitator.willSettle({ settled: "unknown", reason: "the facilitator timed out" });
    const itemId = await publish(served, syncCard);

    const priced = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });
    const requirements = decodePaymentRequiredHeader(
      priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    ).accepts[0];
    if (requirements === undefined) throw new Error("no payment option was offered");

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const answered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: requirements,
          payload: { signature: "0xsigned" },
        }),
      },
    });
    await worker.stop();

    expect(answered.status).toBe(409);
    expect(answered.body).toMatchObject({ status: "payment_unresolved" });
    expect(answered.body).not.toMatchObject({ status: "in_progress" });
  });

  it("says an order closed before it was priced is closed, not still waiting", async () => {
    // This document carries a sale price, and an order refused before pricing
    // never got one. "Still waiting for its price" would be false about a
    // purchase that is over.
    const { served, harnessed } = await started({ QUOTE_RESPONSE_MS: "10" });
    const itemId = await publish(served, {
      ...syncCard,
      merchant_item_id: "gone",
      fulfillment: "async",
      price_check: "handler",
    });

    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "settled") throw new Error("the silent async card sold anyway");

    const read = await served.call(
      "GET",
      `/v0/orders/${encodeURIComponent(offered.order.order.id)}`,
      { headers: asMerchant },
    );

    expect(read.status).toBe(409);
    expect(read.body).toMatchObject({
      error: { code: "order_closed_before_it_was_priced", status: "rejected" },
    });
  });

  it("leaves an order closed before it was priced out of the list, and still answers the list", async () => {
    // Each row carries a sale price. An order that never had one is left out,
    // rather than shown at the card's price or failing the whole list, and can
    // still be read by its identifier.
    const { served, harnessed } = await started({ QUOTE_RESPONSE_MS: "10" });
    const itemId = await publish(served, {
      ...syncCard,
      merchant_item_id: "gone",
      fulfillment: "async",
      price_check: "handler",
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "settled") throw new Error("the silent async card sold anyway");

    const listed = await served.call("GET", "/v0/orders", { headers: asMerchant });

    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(
      (listed.body as { orders: { id: string }[] }).orders.map((order) => order.id),
    ).not.toContain(offered.order.order.id);
  });
});

describe("whose purchase it is", () => {
  /** A payment signed by one address, against a challenge that was issued. */
  const paidBy = (challenge: string, from: string, nonce: string) => {
    const accepted = decodePaymentRequiredHeader(challenge).accepts[0];
    if (accepted === undefined) throw new Error("no payment option was offered");
    return encodePaymentSignatureHeader({
      x402Version: 2,
      accepted,
      payload: {
        signature: "0xsigned",
        authorization: { from, to: PAY_TO, value: "80000000", nonce },
      },
    });
  };

  const challengeFor = async (served: Served, itemId: string) => {
    const priced = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });
    expect(priced.status).toBe(402);
    return priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "";
  };

  const BUYER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const STRANGER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  // Both payments are held at verification and released together, so the
  // in-lock ownership guard decides and not scheduling. The tests must not
  // assert which one wins: that depends on the machine. The larger sync budget
  // keeps the parked calls alive across the hold.
  const RACE_TIMING = {
    QUOTE_RESPONSE_MS: "50",
    SYNC_RESPONSE_MS: "300",
    SETTLE_RESPONSE_MS: "100",
    SYNC_BUDGET_MS: "500",
  };

  const raceTwoPayments = async (served: Served, harnessed: Harness, itemId: string) => {
    const challenge = await challengeFor(served, itemId);
    const buyerHeader = paidBy(challenge, BUYER, "0x01");
    const strangerHeader = paidBy(challenge, STRANGER, "0x02");

    const release = harnessed.facilitator.holdVerification();
    const race = Promise.all([
      served.call("POST", `/x402/${itemId}/purchase`, {
        body: { params: {} },
        headers: { [PAYMENT_SIGNATURE_HEADER]: buyerHeader },
      }),
      served.call("POST", `/x402/${itemId}/purchase`, {
        body: { params: {} },
        headers: { [PAYMENT_SIGNATURE_HEADER]: strangerHeader },
      }),
    ]);
    // Yield to the event loop, not just the microtask queue: the two
    // presentations travel over a real socket, so their verifications only
    // arrive on I/O ticks. A microtask spin would never let them land.
    for (let i = 0; i < 2_000 && harnessed.facilitator.verifies.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(harnessed.facilitator.verifies).toHaveLength(2);
    release();
    return { race, buyerHeader, strangerHeader };
  };

  it("hands the goods to exactly one of two racing payments and refuses the other", async () => {
    // The order identifier is public: it is in the challenge. Synchronous goods
    // reach only the parked call, so a second call under the same order must not
    // take the first one's place.
    const { served, harnessed } = await started(RACE_TIMING);
    const itemId = await publish(served, syncCard);

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const { race } = await raceTwoPayments(served, harnessed, itemId);
    const [a, b] = await race;
    await worker.stop();

    const won = [a, b].filter((r) => r.status === 200);
    const refused = [a, b].filter((r) => r.status === 409);
    expect(won).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const winner = won[0];
    const loser = refused[0];
    if (winner === undefined || loser === undefined)
      throw new Error("the race had no single winner");
    expect(winner.body).toMatchObject({ delivered: { access_code: "SESAME" } });
    expect((loser.body as { error: { code: string } }).error.code).toBe("not_this_purchase");
    expect(JSON.stringify(loser.body)).not.toContain("SESAME");
  });

  it("charges exactly one payment, the one the winner owns", async () => {
    // A presentation landing between another's verification and its charge must
    // not replace the authorisation to be charged, or the goods are paid for
    // with somebody else's payment.
    const { served, harnessed } = await started(RACE_TIMING);
    const itemId = await publish(served, syncCard);

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const { race, buyerHeader, strangerHeader } = await raceTwoPayments(served, harnessed, itemId);
    const [buyerResult, strangerResult] = await race;
    await worker.stop();

    // Promise.all keeps the call order, so the first result is the buyer's call
    // and the second the stranger's; the winner's header is whichever returned
    // the goods.
    const winnerHeader = buyerResult.status === 200 ? buyerHeader : strangerHeader;
    expect([buyerResult.status, strangerResult.status].filter((s) => s === 200)).toHaveLength(1);

    const charged = harnessed.facilitator.settles.map((charge) => charge.payment);
    expect(charged).toHaveLength(1);
    expect(charged[0]).toBe(winnerHeader);
  });

  it("does not let a stranger close somebody else's open purchase", async () => {
    // A payment that fails its check closes the order it was presented for. A
    // stranger's payment is not that order's payment, so it closes nothing —
    // and the buyer is not told their purchase was refused for a payment they
    // never made.
    const { served, harnessed } = await started({
      QUOTE_RESPONSE_MS: "50",
      SYNC_RESPONSE_MS: "150",
      SETTLE_RESPONSE_MS: "100",
      SYNC_BUDGET_MS: "300",
      QUOTE_TTL_MS: "60000",
    });
    const itemId = await publish(served, syncCard);
    const challenge = await challengeFor(served, itemId);

    // The buyer takes the order first, and their own payment cannot be checked
    // yet because nothing is answering.
    harnessed.facilitator.willVerify({ verified: "unknown", message: "not asked yet" });
    await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: paidBy(challenge, BUYER, "0x01") },
    });

    harnessed.facilitator.willRefuseVerification("signature", "not a signature at all");
    const meddling = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: paidBy(challenge, STRANGER, "0x02") },
    });

    expect(meddling.status).toBe(409);
    const orders = await harnessed.store.orders(harnessed.merchant.id);
    expect(orders).toHaveLength(1);
    expect(orders[0]?.order.state).toBe("quoted");
    expect(orders[0]?.order.closure).toBeNull();
  });

  it("lets the buyer who owns an order drive the payment home with a second authorisation", async () => {
    // A repeat is a fresh authorisation with its own nonce and fingerprint. Only
    // the signing wallet makes it the same buyer's, and the gateway learns that
    // wallet from the payment layer.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);
    harnessed.facilitator.willSettle(
      { settled: false, reason: "the transfer reverted" },
      { settled: true, transaction: "0xsecond" },
    );
    const challenge = await challengeFor(served, itemId);
    const first = paidBy(challenge, BUYER, "0x01");
    const repeat = paidBy(challenge, BUYER, "0x02");

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const delivered = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: first },
    });
    // The merchant made the goods and the charge failed, so the goods are not
    // the buyer's yet and the agent is not told the purchase went through.
    expect(delivered.status).toBe(409);
    expect(delivered.body).toMatchObject({ status: "delivered_unpaid" });

    // The worker is stopped before the repeat: the merchant is asked for
    // nothing a second time, and a repeat that needed him would hang here.
    await worker.stop();

    const paid = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: repeat },
    });

    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ delivered: { access_code: "SESAME" } });
    // And it was the authorisation the agent actually sent that was charged.
    expect(harnessed.facilitator.settles.map((charge) => charge.payment)).toStrictEqual([
      first,
      repeat,
    ]);
  });

  it("refuses a second wallet's payment for an order that is already somebody's", async () => {
    // An order's identifier travels in challenges, on the merchant's stream and
    // in receipts, so holding one does not make a wallet the buyer.
    const { served, harnessed } = await started();
    const itemId = await publish(served, {
      ...syncCard,
      merchant_item_id: "esim-owned",
      fulfillment: "async",
    });
    const challenge = await challengeFor(served, itemId);

    const bought = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: paidBy(challenge, BUYER, "0x01") },
    });
    expect(bought.status).toBe(200);

    const stranger = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
      headers: { [PAYMENT_SIGNATURE_HEADER]: paidBy(challenge, STRANGER, "0x02") },
    });

    expect(stranger.status).toBe(409);
    expect(stranger.body).toStrictEqual({
      error: {
        code: "not_this_purchase",
        message: "this order already belongs to another payment",
        // The order stays somebody else's, so this answer never changes.
        retryable: false,
      },
    });
    // The stranger was never charged, and the order is still the buyer's.
    expect(harnessed.facilitator.settles).toHaveLength(1);
  });
});

describe("the worker's calls over HTTP", () => {
  it("hands nothing to a poll whose worker has gone, and keeps it for the next", async () => {
    // A poll the worker abandoned must take nothing off the stream: an event is
    // sent once, and one drawn for nobody is lost.
    const { served, harnessed } = await started();
    const itemId = await publish(served, {
      ...syncCard,
      merchant_item_id: "esim",
      fulfillment: "async",
    });

    const leaving = new AbortController();
    const abandoned = fetch(`${served.url}/v0/worker/poll`, {
      method: "POST",
      headers: { ...asMerchant, "content-type": "application/json" },
      body: JSON.stringify({ wait_seconds: 20 }),
      signal: leaving.signal,
    }).catch(() => "left");
    await new Promise((resolve) => setTimeout(resolve, 100));
    leaving.abort();
    expect(await abandoned).toBe("left");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    const next = await served.call("POST", "/v0/worker/poll", {
      body: { wait_seconds: 0 },
      headers: asMerchant,
    });
    const { envelopes } = next.body as { envelopes: { payload: { id: string } }[] };

    expect(envelopes.map((envelope) => envelope.payload.id)).toStrictEqual([
      offered.order.order.id,
    ]);
  });

  it("takes nothing into a poll whose key is revoked while it waits", async () => {
    // Revoking a key cuts that code off from the merchant's orders, including
    // a poll it already holds open: otherwise the next order to arrive would
    // go to the code the merchant had just cut off. The order waits for a key
    // that still works.
    const { served, harnessed } = await started();
    const itemId = await publish(served, {
      ...syncCard,
      merchant_item_id: "esim",
      fulfillment: "async",
    });
    const kept = await harnessed.addKey(harnessed.merchant.id);

    const holding = served.call("POST", "/v0/worker/poll", {
      body: { wait_seconds: 20 },
      headers: asMerchant,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const revoked = await harnessed.gateway.disableMerchantKey(
      harnessed.merchant.id,
      harnessed.merchant.keyId,
      { kind: "signed_in", email: "owner@example.com" },
    );
    expect(revoked).not.toBeNull();

    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    await harnessed.gateway.payPurchase(offered.order.order.id, "PAYMENT", "PAYMENT");

    expect((await holding).body).toMatchObject({ envelopes: [] });
    const next = await served.call("POST", "/v0/worker/poll", {
      body: { wait_seconds: 0 },
      headers: { authorization: `Bearer ${kept}` },
    });
    const { envelopes } = next.body as { envelopes: { payload: { id: string } }[] };
    expect(envelopes.map((envelope) => envelope.payload.id)).toStrictEqual([
      offered.order.order.id,
    ]);
  });

  it("refuses the code's poll while its merchant sells through a shop, for good", async () => {
    // Answered empty, a worker whose merchant connected a shop would look
    // healthy and idle for as long as anybody let it run; the refusal is what
    // its log shows.
    const { served, harnessed } = await started();
    await harnessed.gateway.sellThrough(harnessed.merchant.id, "woocommerce");

    const refused = await served.call("POST", "/v0/worker/poll", {
      body: { wait_seconds: 0 },
      headers: asMerchant,
    });

    expect(refused.status).toBe(409);
    const { error } = refused.body as {
      error: { code: string; message: string; retryable: boolean };
    };
    expect(error.code).toBe("call_refused");
    expect(error.retryable).toBe(false);

    await harnessed.gateway.sellThrough(harnessed.merchant.id, "api");
    const working = await served.call("POST", "/v0/worker/poll", {
      body: { wait_seconds: 0 },
      headers: asMerchant,
    });
    expect(working.status).toBe(200);
  });

  it("draws the stream and answers an order through the routes the SDK uses", async () => {
    const { served, harnessed } = await started();
    const itemId = await publish(served, {
      ...syncCard,
      merchant_item_id: "esim",
      fulfillment: "async",
    });

    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const drawn = await served.call("POST", "/v0/worker/poll", {
      body: { wait_seconds: 0 },
      headers: asMerchant,
    });
    expect(drawn.status).toBe(200);
    const { envelopes, contract_version } = drawn.body as {
      envelopes: { kind: string; payload: { id: string } }[];
      contract_version: string;
    };
    expect(contract_version).toBe("2");
    expect(envelopes.map((envelope) => envelope.kind)).toStrictEqual(["order"]);

    const answered = await served.call(`POST`, `/v0/orders/${orderId}/answer`, {
      body: { delivered: { access_code: "A" } },
      headers: asMerchant,
    });

    expect(answered.status).toBe(200);
    expect(answered.body).toStrictEqual({ ok: true, result: "delivered" });
  });

  it("answers a poll with one envelope, whatever the worker asks for", async () => {
    // The answer wait starts at hand-over and a worker handles orders one at a
    // time, so handing out several would run the clock on orders queued behind
    // others. The contract lets the gateway return fewer than asked.
    const { served, harnessed } = await started();
    const itemId = await publish(served, {
      ...syncCard,
      merchant_item_id: "esim-burst",
      fulfillment: "async",
    });
    for (const nth of [0, 1, 2]) {
      const offered = await harnessed.gateway.beginPurchase(itemId, {});
      if (offered.step !== "pay") throw new Error("no price was offered");
      // One payment buys one order, so each purchase brings its own; reusing
      // one would leave two orders unpaid and nothing on the stream for them.
      await harnessed.gateway.payPurchase(
        offered.order.order.id,
        `PAYMENT-${nth}`,
        `PAYMENT-${nth}`,
      );
    }

    const sizes: number[] = [];
    for (const _ of [0, 1, 2, 3]) {
      const drawn = await served.call("POST", "/v0/worker/poll", {
        body: { wait_seconds: 0, max: 1_000 },
        headers: asMerchant,
      });
      sizes.push((drawn.body as { envelopes: unknown[] }).envelopes.length);
    }

    expect(sizes).toStrictEqual([1, 1, 1, 0]);
  });

  it("answers a recorded acceptance as a success, in the body and in the status", async () => {
    // An SDK reads the body and a client library reads the status. An
    // acceptance that says no in either becomes a false problem in the
    // merchant's log, or a retry loop.
    const { served, harnessed } = await started();
    const itemId = await publish(served, {
      ...syncCard,
      merchant_item_id: "esim-accept",
      fulfillment: "async",
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");
    const orderId = offered.order.order.id;
    await harnessed.gateway.payPurchase(orderId, "PAYMENT", "PAYMENT");

    const answered = await served.call("POST", `/v0/orders/${orderId}/answer`, {
      body: { accepted: {} },
      headers: asMerchant,
    });

    expect(answered.status).toBe(200);
    expect(answered.body).toStrictEqual({ ok: true, result: "accepted" });
    expect((await harnessed.store.orderById(orderId))?.order.dispatch.accepted).toBe(true);
  });

  it("still says no in the status when the answer route refuses one", async () => {
    // The negative control: the order is unpaid, so the acceptance is refused,
    // and a client that reads only the status has to see that.
    const { served, harnessed } = await started();
    const itemId = await publish(served, {
      ...syncCard,
      merchant_item_id: "esim-unpaid",
      fulfillment: "async",
    });
    const offered = await harnessed.gateway.beginPurchase(itemId, {});
    if (offered.step !== "pay") throw new Error("no price was offered");

    const early = await served.call("POST", `/v0/orders/${offered.order.order.id}/answer`, {
      body: { accepted: {} },
      headers: asMerchant,
    });

    expect(early.status).toBe(409);
    // Neither the code nor `retryable` is pinned. The code is the machine's own,
    // which the contract leaves free to change, and neither value of `retryable`
    // is right for an order that is merely unpaid.
    expect(early.body).toMatchObject({ ok: false });
    expect((await harnessed.store.orderById(offered.order.order.id))?.order.dispatch.accepted).toBe(
      false,
    );
  });

  it("refuses a body that is not JSON in the shape everything else refuses in", async () => {
    // The parser rejects it before any route runs; without our own handler
    // express answers with an HTML page.
    const { served } = await started();

    const answered = await served.call("POST", "/v0/quotes/prc_1/answer", {
      headers: { ...asMerchant, "content-type": "application/json" },
      body: undefined,
    });
    const raw = await fetch(`${served.url}/v0/quotes/prc_1/answer`, {
      method: "POST",
      headers: { ...asMerchant, "content-type": "application/json" },
      body: "{ this is not json",
    });

    expect(raw.status).toBe(400);
    expect((await raw.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "malformed_body" },
    });
    expect(answered.status).toBe(400);
  });

  it("says a body was too large rather than that it could not be read", async () => {
    // Good JSON over the limit, answered "could not be read as JSON", sends an
    // agent to re-encode a document it got right. The parser throws both as one
    // error, and only the fork tells them apart.
    const { served } = await started();

    const answered = await served.call("POST", "/v0/quotes/prc_1/answer", {
      body: { available: true, note: "x".repeat(300_000) },
      headers: asMerchant,
    });

    expect(answered.status).toBe(413);
    const { error } = answered.body as { error: { code: string; message: string } };
    expect(error.code).toBe("body_too_large");
    // The limit itself, because "too large" without a number leaves the caller
    // to find the edge by bisection against a live gateway.
    expect(error.message).toContain("256kb");
  });

  it("tells the refusals at the door apart, and says the true one about each", async () => {
    // The parser throws all of these as one error and the fork is the only
    // place they are told apart; an agent given another case's words repairs
    // what was never broken. They are checked together so that a branch widened
    // to swallow its neighbours fails too.
    const { served } = await started();

    // Real gzip cut in half, as a dropped upload would be: the caller's mishap,
    // not a false header.
    const wholeGzip = gzipSync(JSON.stringify({ available: true }));
    const halfGzip = wholeGzip.subarray(0, Math.floor(wholeGzip.length / 2));

    const refusedFor = async (
      headers: Record<string, string>,
      body: string | Uint8Array,
      path = "/v0/quotes/prc_1/answer",
    ) => {
      const answered = await fetch(`${served.url}${path}`, {
        method: "POST",
        headers: { ...asMerchant, "content-type": "application/json", ...headers },
        body,
      });
      const { error } = (await answered.json()) as {
        error: { code: string; message: string };
      };
      return { status: answered.status, ...error };
    };

    // None of these is our failure, so none may be logged as one: an operator
    // grepping for it would hunt a defect that is not there.
    const complaints: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      complaints.push(String(args[0]));
    };

    let notJson: Awaited<ReturnType<typeof refusedFor>>;
    let tooLarge: typeof notJson;
    let encodingRefused: typeof notJson;
    let encodingBroken: typeof notJson;
    let charsetRefused: typeof notJson;
    let goodGzipBadJson: typeof notJson;
    let brokenPath: typeof notJson;
    try {
      notJson = await refusedFor({}, "{ this is not json");
      tooLarge = await refusedFor({}, JSON.stringify({ note: "x".repeat(300_000) }));
      // `compress` is a registered coding the parser cannot inflate; a body
      // under gzip, deflate or brotli never reaches this branch.
      encodingRefused = await refusedFor({ "content-encoding": "compress" }, "{}");
      encodingBroken = await refusedFor({ "content-encoding": "gzip" }, halfGzip);
      // The charset on the content-type rather than the content coding: a
      // refusal of its own, and the bytes are never decoded.
      charsetRefused = await refusedFor(
        { "content-type": "application/json; charset=utf-77" },
        "{}",
      );
      // Negative control for the broken gzip: same header, decompresses fine,
      // bad JSON inside. A fork reading the header instead of the failure would
      // call this undecodable.
      goodGzipBadJson = await refusedFor(
        { "content-encoding": "gzip" },
        gzipSync("{ this is not json"),
      );
      // Express refuses a path it cannot percent-decode with a bare 4xx. With no
      // encoding and a good body, this must get neither the encoding answer nor
      // a 500, only the generic refusal.
      brokenPath = await refusedFor({}, "{}", "/v0/quotes/%ZZ/answer");
    } finally {
      console.error = realError;
    }

    expect({ status: notJson.status, code: notJson.code }).toEqual({
      status: 400,
      code: "malformed_body",
    });
    expect({ status: tooLarge.status, code: tooLarge.code }).toEqual({
      status: 413,
      code: "body_too_large",
    });
    expect({ status: goodGzipBadJson.status, code: goodGzipBadJson.code }).toEqual({
      status: 400,
      code: "malformed_body",
    });

    expect({ status: encodingRefused.status, code: encodingRefused.code }).toEqual({
      status: 415,
      code: "encoding_unsupported",
    });
    // Names the header, since the body was fine, and the way out: send it
    // uncompressed.
    expect(encodingRefused.message).toContain("content-encoding");
    expect(encodingRefused.message).toContain("uncompressed");
    expect(encodingRefused.message).not.toContain("could not be read as JSON");

    expect({ status: charsetRefused.status, code: charsetRefused.code }).toEqual({
      status: 415,
      code: "charset_unsupported",
    });
    // Which of the two headers was the trouble, since the caller sent both and
    // the answer is otherwise indistinguishable from the encoding one.
    expect(charsetRefused.message).toContain("charset");
    expect(charsetRefused.message).not.toContain("could not be read as JSON");

    expect({ status: encodingBroken.status, code: encodingBroken.code }).toEqual({
      status: 400,
      code: "body_undecodable",
    });
    // The header and the bytes disagree and we cannot tell which is wrong. Not
    // a 5xx: an agent would retry it with the same broken bytes.
    expect(encodingBroken.message).toContain("content-encoding");
    expect(encodingBroken.message).not.toContain("nothing was decided");

    expect({ status: brokenPath.status, code: brokenPath.code }).toEqual({
      status: 400,
      code: "call_refused",
    });
    // No cause is named: it would be a guess the caller then acts on.
    expect(brokenPath.message).not.toContain("nothing was decided");

    expect(complaints.filter((line) => line.includes("failed before it reached a route"))).toEqual(
      [],
    );
  });

  it("answers a call about an order nobody made with a plain not found", async () => {
    const { served } = await started();

    const answered = await served.call("POST", "/v0/orders/ord_nope/deliver", {
      body: { access_code: "A" },
      headers: asMerchant,
    });

    expect(answered.status).toBe(404);
    expect((answered.body as { error: { code: string } }).error.code).toBe("no_such_order");
  });
});

describe("the merchant's own catalog and the pause switch", () => {
  // A pause stops new orders and leaves open ones alone. Answers report state
  // as the machine keeps it, so a screen never disagrees with it about
  // whether a product is on sale.
  const vpnCard: Card = {
    merchant_item_id: "vpn-monthly",
    title: "VPN, one month",
    description: "Thirty days from the moment it is delivered",
    price: { amount: "5.00", currency: "USD" },
    result: { access_url: { type: "string" } },
    fulfillment: "sync",
  };

  const cardsOf = (body: unknown) => (body as MerchantCardList).cards;

  const stateOf = (body: unknown, id: string) => cardsOf(body).find((card) => card.id === id);

  const buy = (served: Served, itemId: string) =>
    served.call("POST", `/x402/${itemId}/purchase`, { body: { params: {} } });

  it("shows the merchant the cards they published, whole, and refuses a caller with no key", async () => {
    const { served } = await started();
    const itemId = await publish(served, syncCard);

    const mine = await served.call("GET", "/v0/cards", { headers: asMerchant });
    const stranger = await served.call("GET", "/v0/cards");

    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ selling: "open" });
    expect(stateOf(mine.body, itemId)).toMatchObject({ selling: "open", paused: false });
    // The card itself, not a projection of it: the merchant's own key is here,
    // which the public catalog deliberately never carries.
    expect(cardsOf(mine.body)[0]?.card).toStrictEqual(syncCard);
    expect(stranger.status).toBe(401);
  });

  it("stops new orders for a paused card and leaves the others selling", async () => {
    const { served } = await started();
    const paused = await publish(served, syncCard);
    const selling = await publish(served, vpnCard);

    const answered = await served.call("POST", `/v0/cards/${paused}/pause`, {
      headers: asMerchant,
    });

    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ id: paused, selling: "paused", paused: true });
    expect((await buy(served, paused)).status).toBe(409);
    expect((await buy(served, paused)).body).toMatchObject({ error: { code: "not_selling" } });
    // The negative control: the switch is per card, so the other one is
    // untouched and still answers a purchase with a price.
    expect((await buy(served, selling)).status).toBe(402);
  });

  it("takes a paused card out of the catalog rather than offering what it will refuse", async () => {
    // A catalog is an offer. An entry every purchase of which comes back
    // "not selling" is an offer we would not honour, and the agent finds out
    // after it has chosen this product over somebody else's.
    const { served } = await started();
    const itemId = await publish(served, syncCard);

    await served.call("POST", `/v0/cards/${itemId}/pause`, { headers: asMerchant });
    const listed = await served.call("GET", "/x402/catalog");

    expect((listed.body as { items: unknown[] }).items).toStrictEqual([]);
  });

  it("does not touch an order that was already open when the pause began", async () => {
    // The pause guards the birth of an order and nothing after it, so a sale
    // already under way completes as it would have.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);
    const priced = await buy(served, itemId);
    const requirements = decodePaymentRequiredHeader(
      priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    ).accepts[0];
    if (requirements === undefined) throw new Error("no payment option was offered");

    await served.call("POST", "/v0/selling/pause", { headers: asMerchant });

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const bought = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: requirements,
          payload: { signature: "0xsigned" },
        }),
      },
    });
    await worker.stop();

    expect(bought.status).toBe(200);
    expect(bought.body).toMatchObject({ delivered: { access_code: "SESAME" } });
  });

  it("stops every card at once and says which pause each one is under", async () => {
    const { served } = await started();
    const ownPause = await publish(served, syncCard);
    const swept = await publish(served, vpnCard);
    await served.call("POST", `/v0/cards/${ownPause}/pause`, { headers: asMerchant });

    const stopped = await served.call("POST", "/v0/selling/pause", { headers: asMerchant });

    expect(stopped.body).toMatchObject({ selling: "paused" });
    // Both refuse a purchase, and the two are still told apart: one is paused
    // in its own right and one is only swept up by the merchant's switch.
    expect(stateOf(stopped.body, ownPause)).toMatchObject({ selling: "paused", paused: true });
    expect(stateOf(stopped.body, swept)).toMatchObject({ selling: "paused", paused: false });
    expect((await buy(served, swept)).status).toBe(409);
  });

  it("puts back only the cards the merchant did not take off themselves", async () => {
    // Resuming everything must not sell a product its merchant took off sale.
    // The card that was paused in its own right is still paused, and the one
    // that was only swept up is selling again.
    const { served } = await started();
    const ownPause = await publish(served, syncCard);
    const swept = await publish(served, vpnCard);
    await served.call("POST", `/v0/cards/${ownPause}/pause`, { headers: asMerchant });
    await served.call("POST", "/v0/selling/pause", { headers: asMerchant });

    const resumed = await served.call("POST", "/v0/selling/resume", { headers: asMerchant });

    expect(resumed.body).toMatchObject({ selling: "open" });
    expect(stateOf(resumed.body, ownPause)).toMatchObject({ selling: "paused", paused: true });
    expect(stateOf(resumed.body, swept)).toMatchObject({ selling: "open", paused: false });
    expect((await buy(served, ownPause)).status).toBe(409);
    expect((await buy(served, swept)).status).toBe(402);
  });

  it("tells a merchant resuming one card that the catalog is still stopped", async () => {
    // The case a merchant is most likely to misread: they press resume on a
    // card while all selling is stopped, and nothing appears to happen. The
    // answer says both facts, so the screen can say which switch is holding it.
    const { served } = await started();
    const itemId = await publish(served, syncCard);
    await served.call("POST", `/v0/cards/${itemId}/pause`, { headers: asMerchant });
    await served.call("POST", "/v0/selling/pause", { headers: asMerchant });

    const answered = await served.call("POST", `/v0/cards/${itemId}/resume`, {
      headers: asMerchant,
    });

    expect(answered.body).toMatchObject({ selling: "paused", paused: false });
    expect((await buy(served, itemId)).status).toBe(409);
  });

  it("leaves a card paused when its merchant republishes it", async () => {
    // Republishing is how a card is changed. A merchant editing a price is not
    // asking for a product they took off sale to go back on it, and a pause
    // that evaporated on the next publish would put stock they do not have in
    // front of an agent.
    const { served } = await started();
    const itemId = await publish(served, syncCard);
    await served.call("POST", `/v0/cards/${itemId}/pause`, { headers: asMerchant });

    await publish(served, { ...syncCard, price: { amount: "90.00", currency: "USD" } });
    const mine = await served.call("GET", "/v0/cards", { headers: asMerchant });

    expect(stateOf(mine.body, itemId)).toMatchObject({ selling: "paused", paused: true });
    expect(cardsOf(mine.body)[0]?.card.price).toStrictEqual({ amount: "90.00", currency: "USD" });
  });

  it("answers the same way when the same switch is pressed twice", async () => {
    // The call says what the merchant wants to be true rather than asking for a
    // change, so a retry after a dropped connection is safe.
    const { served } = await started();
    const itemId = await publish(served, syncCard);

    const first = await served.call("POST", `/v0/cards/${itemId}/pause`, { headers: asMerchant });
    const again = await served.call("POST", `/v0/cards/${itemId}/pause`, { headers: asMerchant });

    expect(again.status).toBe(200);
    expect(again.body).toStrictEqual(first.body);
  });

  it("does not put a merchant who has left back on sale", async () => {
    // A departure closed the open orders and left refunds owed; resuming would
    // put the merchant back on sale with none of it unwound. No route sets
    // "departed", so the store sets it here.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);
    await harnessed.store.setSelling(harnessed.merchant.id, "departed");

    const resumed = await served.call("POST", "/v0/selling/resume", { headers: asMerchant });

    expect(resumed.status).toBe(409);
    expect((resumed.body as { error: { code: string } }).error.code).toBe("merchant_departed");
    expect(await harnessed.store.selling(harnessed.merchant.id)).toBe("departed");
    // And the merchant is still gone as far as an agent is concerned.
    expect(
      (await served.call("POST", `/x402/${itemId}/purchase`, { body: { params: {} } })).status,
    ).toBe(409);
  });

  it("does not describe a departure as a pause either", async () => {
    // The other direction of the same rule. Pausing a merchant who has left
    // would say their open orders are playing out, which they are not.
    const { served, harnessed } = await started();
    await publish(served, syncCard);
    await harnessed.store.setSelling(harnessed.merchant.id, "departed");

    const paused = await served.call("POST", "/v0/selling/pause", { headers: asMerchant });

    expect(paused.status).toBe(409);
    expect(await harnessed.store.selling(harnessed.merchant.id)).toBe("departed");
  });

  it("says there is no such product rather than pausing nothing quietly", async () => {
    const { served } = await started();

    const answered = await served.call("POST", "/v0/cards/itm_nope/pause", {
      headers: asMerchant,
    });

    expect(answered.status).toBe(404);
    expect((answered.body as { error: { code: string } }).error.code).toBe("no_such_item");
  });
});

describe("the merchant's receipts", () => {
  it("lists the receipt of a sale that went through, and nothing before one does", async () => {
    // The promise: a merchant reconciles their wallet against this list. A
    // receipt exists from the moment the money moves, so an empty list before
    // any sale is the true answer and not a broken call.
    const { served, harnessed } = await started();
    const itemId = await publish(served, syncCard);

    const before = await served.call("GET", "/v0/receipts", { headers: asMerchant });
    expect(before.body).toStrictEqual({ receipts: [] });

    const priced = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
    });
    const requirements = decodePaymentRequiredHeader(
      priced.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    ).accepts[0];
    if (requirements === undefined) throw new Error("no payment option was offered");

    const worker = workUntilStopped(harnessed, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });
    const bought = await served.call("POST", `/x402/${itemId}/purchase`, {
      body: { params: {} },
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
          x402Version: 2,
          accepted: requirements,
          payload: { signature: "0xsigned" },
        }),
      },
    });
    await worker.stop();

    const after = await served.call("GET", "/v0/receipts", { headers: asMerchant });
    const receipts = (after.body as { receipts: Receipt[] }).receipts;

    expect(after.status).toBe(200);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      order_id: (bought.body as { order_id: string }).order_id,
      outcome: "delivered",
      item_id: itemId,
    });
    // Both moments, which is what the price on a receipt is for: when the
    // purchase happened, and the instant the price behind it was true.
    expect(receipts[0]?.price).toMatchObject({ amount: "80.00", currency: "USD" });
    expect(receipts[0]?.price.at).toBeTruthy();
    expect(receipts[0]?.price.as_of).toBeTruthy();
  });

  it("refuses a caller with no key", async () => {
    const { served } = await started();

    expect((await served.call("GET", "/v0/receipts")).status).toBe(401);
  });
});

describe("what a declaration says the purchase answers with", () => {
  // The promise: an agent built from the declaration a challenge carries looks
  // for the goods where the purchase puts them. Every leaf of the example
  // stands for its type, so what is compared is the shape: the same fields at
  // every depth, the same status word, and goods or none in the same place.
  const shapeOf = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value === null ? null : typeof value;
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, held]) => [name, name === "status" ? held : shapeOf(held)]),
    );
  };

  /** A seller with a site, so the site is a string in the answer as in the example. */
  const sited = async (harnessed: Harness) =>
    setSellerSite(harnessed.store, harnessed.merchant.id, "https://shop.example", Date.now());

  const declaredOutput = async (served: Served, itemId: string): Promise<unknown> => {
    const probed = await served.call("GET", `/x402/${itemId}/purchase`);
    const declared = decodePaymentRequiredHeader(probed.headers.get(PAYMENT_REQUIRED_HEADER) ?? "")
      .extensions?.bazaar as { info: { output?: { example?: unknown } } };
    return declared.info.output?.example;
  };

  it("declares the order with its goods, for a card delivered in the answer", async () => {
    const { served, harnessed } = await started();
    await sited(harnessed);
    const itemId = await publish(served, syncCard);

    const bought = await buyOverHttp(harnessed, served, itemId, {
      onOrder: () => ({ delivered: { access_code: "SESAME" } }),
    });

    expect(bought.status).toBe(200);
    expect((bought.body as { status: string }).status).toBe("delivered");
    expect(shapeOf(await declaredOutput(served, itemId))).toStrictEqual(shapeOf(bought.body));
  });

  it("declares the order under way and no goods, for a card whose goods come later", async () => {
    // The money moves at the purchase and the goods arrive at status_url; an
    // agent that looked for them in this answer would think it paid for nothing.
    const { served, harnessed } = await started();
    await sited(harnessed);
    const itemId = await publish(served, {
      ...syncCard,
      fulfillment: "async",
      fulfill_deadline_seconds: 3_600,
    });

    const bought = await buyOverHttp(harnessed, served, itemId, {
      onOrder: () => ({ accepted: {} }),
    });

    expect(bought.status).toBe(200);
    expect((bought.body as { delivered: unknown }).delivered).toBeNull();
    expect(shapeOf(await declaredOutput(served, itemId))).toStrictEqual(shapeOf(bought.body));
  });
});

describe("a product that is declared and a product that is not", () => {
  // The promise: everything a challenge tells a catalog about is something an
  // agent can then buy. A declared resource that answers every purchase with a
  // refusal is worse than an unlisted one — the agent budgets for it, picks it
  // over a competitor, and finds out at the till.
  const paused = async (served: Served, itemId: string) => {
    const answered = await served.call("POST", `/v0/cards/${itemId}/pause`, {
      headers: asMerchant,
    });
    expect(answered.status).toBe(200);
  };

  it("declares a card that is for sale", async () => {
    const { served } = await started();
    const itemId = await publish(served, syncCard);

    const answered = await served.call("GET", `/x402/${itemId}/purchase`);

    expect(answered.status).toBe(402);
    const challenge = decodePaymentRequiredHeader(
      answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
    );
    expect(challenge.extensions?.bazaar).toBeTypeOf("object");
    // The product's identity in every catalog, so pinned exactly. It carries no
    // version segment: a listing outlives the protocol version, which the
    // challenge states instead.
    expect(challenge.resource.url).toBe(`http://localhost:3000/x402/${itemId}/purchase`);
  });

  it("stops answering a challenge for a card its merchant took off sale", async () => {
    // The catalog lists a resource that answers 402 and drops one that stops.
    // A paused card that kept answering would stay listed and refuse every
    // purchase behind the listing.
    const { served } = await started();
    const itemId = await publish(served, syncCard);
    await paused(served, itemId);

    const answered = await served.call("GET", `/x402/${itemId}/purchase`);

    expect(answered.status).toBe(409);
    expect(answered.headers.get(PAYMENT_REQUIRED_HEADER)).toBeNull();
    expect((answered.body as { error: { code: string } }).error.code).toBe("not_selling");
  });

  it("stops answering a challenge when the merchant stopped selling everything", async () => {
    const { served } = await started();
    const itemId = await publish(served, syncCard);
    const stopped = await served.call("POST", "/v0/selling/pause", { headers: asMerchant });
    expect(stopped.status).toBe(200);

    const answered = await served.call("GET", `/x402/${itemId}/purchase`);

    expect(answered.status).toBe(409);
    expect(answered.headers.get(PAYMENT_REQUIRED_HEADER)).toBeNull();
  });

  it("answers again once the card is back on sale", async () => {
    const { served } = await started();
    const itemId = await publish(served, syncCard);
    await paused(served, itemId);
    const resumed = await served.call("POST", `/v0/cards/${itemId}/resume`, {
      headers: asMerchant,
    });
    expect(resumed.status).toBe(200);

    expect((await served.call("GET", `/x402/${itemId}/purchase`)).status).toBe(402);
  });

  it("says who is selling, reading the name off the merchant who published it", async () => {
    // The name comes from the merchants table and from nowhere else. Nothing
    // else on the wire carries a seller's name, so a challenge that lost it on
    // the way out would list every product of ours under nobody.
    const { served, harnessed } = await started();
    await setServiceName(harnessed.store, harnessed.merchant.id, "The pilot merchant", Date.now());
    const itemId = await publish(served, syncCard);

    const answered = await served.call("GET", `/x402/${itemId}/purchase`);

    expect(
      decodePaymentRequiredHeader(answered.headers.get(PAYMENT_REQUIRED_HEADER) ?? "").resource
        .serviceName,
    ).toBe("The pilot merchant");
  });

  it("names the same resource however the address was typed", async () => {
    // The resource identity is what a listing is keyed on, and a query string
    // or a second method must not change it. Read off the request it would:
    // the address the process sees is not the address an agent called.
    const { served } = await started();
    const itemId = await publish(served, syncCard);

    const urlOf = async (method: "GET" | "POST", path: string) =>
      decodePaymentRequiredHeader(
        (
          await served.call(method, path, method === "POST" ? { body: { params: {} } } : {})
        ).headers.get(PAYMENT_REQUIRED_HEADER) ?? "",
      ).resource.url;

    const plain = await urlOf("GET", `/x402/${itemId}/purchase`);

    expect(await urlOf("GET", `/x402/${itemId}/purchase?utm=abc`)).toBe(plain);
    expect(await urlOf("POST", `/x402/${itemId}/purchase`)).toBe(plain);
  });
});
