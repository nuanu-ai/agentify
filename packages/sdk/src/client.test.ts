import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { CardInput, Order } from "@nuanu-ai/agentify-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentifyClient,
  AgentifyError,
  ANSWER_NOT_UNDERSTOOD,
  CALL_DID_NOT_REACH_US,
  CARD_REJECTED,
  createClient,
  OUTCOME_UNKNOWN,
  WORKER_PROBLEM_KINDS,
  type WorkerProblem,
} from "./index.js";
import { type FakeGateway, startFakeGateway } from "./testing/fake-gateway.js";
import { REACH, type Reach, reachOf, type TransportFailure, whatIsKnown } from "./transport.js";

const API_KEY = "merchant-key-for-the-tests";

const card: CardInput = {
  merchant_item_id: "access-monthly",
  title: "Доступ к сервису на один месяц",
  description: "Что покупатель получает, для какой задачи это годится и что в это не входит.",
  price: { amount: "5.00", currency: "USD" },
  params: { email: { type: "string", required: true, title: "Куда прислать доступ" } },
  result: { access_url: { type: "string", title: "Ссылка для входа" } },
  fulfillment: "sync",
};

const order: Order = {
  id: "order-1",
  merchant_item_id: "access-monthly",
  params: { email: "buyer@example.com" },
  price: {
    amount: "5.00",
    currency: "USD",
    at: "2026-08-26T10:20:00Z",
    as_of: "2026-08-26T10:15:00Z",
  },
  test: false,
};

let gateway: FakeGateway | undefined;

const gatewayServing = async (routes: Parameters<typeof startFakeGateway>[0]["routes"]) => {
  gateway = await startFakeGateway({ apiKey: API_KEY, routes });
  return createClient({ apiKey: API_KEY, baseUrl: gateway.url });
};

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
});

describe("creating a client", () => {
  it("refuses to be built without a key rather than failing on the first call", () => {
    // The promise: a merchant whose environment variable is not set is told so
    // at the line that is wrong, not by an authorisation failure much later.
    expect(() => createClient({ apiKey: undefined, baseUrl: "https://gateway.invalid" })).toThrow(
      /api key/i,
    );
    expect(() => createClient({ apiKey: "  ", baseUrl: "https://gateway.invalid" })).toThrow(
      /api key/i,
    );
  });

  it("is built without an address, and says so at the first call that needs one", async () => {
    // The quickstart builds a client from a key alone, so building has to
    // work; the first call is what finds out whether the gateway can be
    // reached, and it says where none was named rather than picking one.
    const agentify = createClient({ apiKey: API_KEY });

    await expect(agentify.catalog.publish(card)).rejects.toThrow(/baseUrl/);
    await expect(agentify.orders.get("order-1")).rejects.toThrow(/baseUrl/);
    await expect(
      agentify.orders.forId("order-1").deliver({ access_url: "https://a.example" }),
    ).rejects.toThrow(/baseUrl/);

    // Registering is not a call and does not need one; starting the loop is.
    agentify.on("order", (arrived) => arrived.accepted());
    await expect(agentify.start()).rejects.toThrow(/baseUrl/);
  });

  it("refuses an address that is not one", () => {
    expect(() => createClient({ apiKey: API_KEY, baseUrl: "gateway.invalid" })).toThrow(/address/i);
  });
});

describe("publishing a card", () => {
  it("hands back the catalog identifier", async () => {
    const agentify = await gatewayServing({
      publish_card: () => ({ body: { ok: true, id: "cat-1" } }),
    });

    const published = await agentify.catalog.publish(card);

    expect(published).toStrictEqual({ ok: true, id: "cat-1" });
    expect(published.ok === true && published.id).toBe("cat-1");
    expect(gateway?.callsTo("publish_card")[0]?.body).toStrictEqual(card);
    expect(gateway?.callsTo("publish_card")[0]?.apiKey).toBe(API_KEY);
  });

  it("returns what is wrong with the card instead of throwing", async () => {
    // An invalid card does not throw: it comes back with its findings under
    // `problems`, the word every refusal on this surface uses.
    const problems = [{ path: ["price", "currency"], code: "unsupported", message: "not settled" }];
    const error = {
      code: CARD_REJECTED,
      message: "this card was not published",
      retryable: false,
      problems,
    };
    const agentify = await gatewayServing({
      publish_card: () => ({ status: 400, body: { ok: false, error } }),
    });

    const published = await agentify.catalog.publish(card);

    expect(published.ok).toBe(false);
    expect(published.ok === false && published.error.problems).toStrictEqual(problems);
    expect(published.ok === false && published.error.code).toBe("card_rejected");
    // Never retryable: the same card gets the same answer until it is edited.
    expect(published.ok === false && published.error.retryable).toBe(false);
  });

  it("throws when the answer is not an answer at all", async () => {
    // A card neither accepted nor faulted is a case a merchant cannot branch
    // on, so it throws.
    const agentify = await gatewayServing({
      publish_card: () => ({ status: 502, text: "<html>gateway timeout</html>" }),
    });

    await expect(agentify.catalog.publish(card)).rejects.toThrow(/publish_card/);
  });

  it("treats a well-formed answer that is not the document as no answer at all", async () => {
    // The dangerous shape is valid JSON under a 200 that is not the route's
    // document; read unchecked, it would be a card published that never was.
    const agentify = await gatewayServing({
      publish_card: () => ({ status: 200, text: JSON.stringify({ accepted: true }) }),
    });

    await expect(agentify.catalog.publish(card)).rejects.toThrow(/document it promises/);
  });
});

/**
 * The cards the compiler refuses, so that a card publishing would refuse is a
 * type error where it is written rather than a refusal after the call. None
 * of this runs: every `@ts-expect-error` fails the build the day the line
 * under it starts compiling, and every line without one fails the day it
 * stops.
 */
const compilerRefusesWhatPublishingRefuses = (agentify: AgentifyClient): void => {
  const { catalog } = agentify;
  const named = {
    merchant_item_id: "access-monthly",
    title: "One month of access to the service",
    description: "Access for 30 days from delivery, renewal not included",
    price: "5.00 USD",
  };
  const result = { access_url: "string" } as const;
  const parcel = { ...named, price_check: "handler", ship_within_seconds: 172_800 } as const;
  // A mode chosen while the program runs, as by a caller that sells two kinds of card.
  const either = <Mode extends string>(one: Mode, other: Mode): Mode =>
    Math.random() < 0.5 ? one : other;

  // Each mode with what it needs, the mode left out being "sync".
  void catalog.publish({ ...named, result });
  void catalog.publish({ ...named, result, fulfillment: "async" });
  void catalog.publish({ ...named, result, fulfillment: "async", fulfill_deadline_seconds: 60 });
  void catalog.publish({ ...parcel, fulfillment: "ship" });

  // Each mode with every optional field it takes, so that a type refusing what
  // publishing accepts fails here too.
  const params = { email: "string" } as const;
  const tags = ["access"];
  void catalog.publish({ ...named, result, params, tags, price_check: "handler" });
  void catalog.publish({
    ...named,
    result,
    params,
    tags,
    price_check: "handler",
    fulfillment: "async",
    fulfill_deadline_seconds: 60,
  });
  void catalog.publish({ ...parcel, params, tags, fulfillment: "ship" });

  // A card in the canonical form, every short form written out, compiles too.
  void catalog.publish({
    ...named,
    price: { amount: "5.00", currency: "USD" },
    result: { access_url: { type: "string" } },
    fulfillment: "sync",
  });

  // A card whose mode is decided at run time compiles as long as every mode it may take does.
  void catalog.publish({ ...named, result, fulfillment: either("sync", "async") });

  // @ts-expect-error a card delivered in the answer to the purchase declares what arrives
  void catalog.publish({ ...named });

  // @ts-expect-error so does a card delivered later
  void catalog.publish({ ...named, fulfillment: "async" });

  // @ts-expect-error a parcel declares no result, since what the agent receives is its shipment
  void catalog.publish({ ...parcel, result, fulfillment: "ship" });

  // @ts-expect-error a parcel names the time it is handed to a carrier
  void catalog.publish({ ...named, price_check: "handler", fulfillment: "ship" });

  // @ts-expect-error a parcel's price is asked of the merchant's price handler
  void catalog.publish({ ...named, ship_within_seconds: 60, fulfillment: "ship" });

  // @ts-expect-error a parcel names no delivery deadline, which would read as when it arrives
  void catalog.publish({ ...parcel, fulfill_deadline_seconds: 60, fulfillment: "ship" });

  // @ts-expect-error a card delivered in the answer names no delivery deadline
  void catalog.publish({ ...named, result, fulfill_deadline_seconds: 60 });

  // @ts-expect-error only a parcel names a time to ship
  void catalog.publish({ ...named, result, fulfillment: "async", ship_within_seconds: 60 });

  // @ts-expect-error no card that can be published is asked to confirm, so none names a time for it
  void catalog.publish({ ...named, result, fulfillment: "async", confirm_deadline_seconds: 60 });

  // @ts-expect-error a card cannot be published as "confirm" yet
  void catalog.publish({ ...named, result, fulfillment: "confirm" });

  // @ts-expect-error and a mode decided at run time is held to every mode it may take
  void catalog.publish({ ...named, result, fulfillment: either("sync", "ship") });

  // A card built before the call is held to the same rules, where a field its
  // mode refuses is no longer caught as a stray property of the literal.
  const builtLater = { ...named, result, fulfillment: "async" } as const;
  const builtToShip = { ...builtLater, ship_within_seconds: 60 };
  const builtToConfirm = { ...builtLater, confirm_deadline_seconds: 60 };
  const builtParcel = { ...parcel, fulfillment: "ship" } as const;
  const builtParcelWithResult = { ...builtParcel, result };
  const builtParcelWithDeadline = { ...builtParcel, fulfill_deadline_seconds: 60 };

  void catalog.publish(builtLater);
  void catalog.publish(builtParcel);

  // @ts-expect-error only a parcel names a time to ship, however the card was built
  void catalog.publish(builtToShip);

  // @ts-expect-error no card that can be published names a time to confirm, however it was built
  void catalog.publish(builtToConfirm);

  // @ts-expect-error a parcel declares no result, however it was built
  void catalog.publish(builtParcelWithResult);

  // @ts-expect-error a parcel names no delivery deadline, however it was built
  void catalog.publish(builtParcelWithDeadline);
};

void compilerRefusesWhatPublishingRefuses;

describe("reading orders back", () => {
  it("reads one order and the state it is in", async () => {
    const agentify = await gatewayServing({
      get_order: () => ({ body: { ...order, status: "in_progress", payment_status: "paid" } }),
    });

    const read = await agentify.orders.get("order-1");

    expect(read.status).toBe("in_progress");
    expect(gateway?.callsTo("get_order")[0]?.params).toStrictEqual({ order_id: "order-1" });
  });

  it("encodes an identifier that carries a slash or a space", async () => {
    // "SKU 100/1" is a valid identifier; unencoded it is a different route.
    const agentify = await gatewayServing({
      get_order: (call) => ({
        body: {
          ...order,
          id: call.params.order_id ?? "",
          status: "delivered",
          payment_status: "paid",
        },
      }),
    });

    await agentify.orders.get("SKU 100/1");

    expect(gateway?.callsTo("get_order")[0]?.params).toStrictEqual({ order_id: "SKU 100/1" });
  });

  it("asks for the open orders in the words the query string carries", async () => {
    // The merchant writes a boolean and the wire carries the contract's two
    // words; `open=1` by hand would silently return every order.
    const agentify = await gatewayServing({ list_orders: () => ({ body: { orders: [] } }) });

    await agentify.orders.list({ open: true });
    await agentify.orders.list({ open: false });
    await agentify.orders.list();

    expect(gateway?.callsTo("list_orders").map((call) => call.query)).toStrictEqual([
      { open: "true" },
      { open: "false" },
      {},
    ]);
  });
});

describe("closing an order the merchant took on", () => {
  it("delivers and hands back the word the gateway used", async () => {
    const agentify = await gatewayServing({
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
    });

    const result = await agentify.orders.forId("order-1").deliver({
      access_url: "https://example.com/a",
    });

    expect(result).toStrictEqual({ ok: true, result: "delivered" });
    expect(gateway?.callsTo("deliver_order")[0]?.body).toStrictEqual({
      access_url: "https://example.com/a",
    });
  });

  it("says when a delivered field will be dropped, on this road as well", async () => {
    // The asynchronous delivery is the other road to the gateway, besides the
    // worker answering for a handler, and a dropped `__proto__` field must be
    // reported on it too.
    const problems: WorkerProblem[] = [];
    const agentify = await gatewayServing({
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
    });

    agentify.on("problem", (problem) => problems.push(problem));

    const result = await agentify.orders
      .forId("order-1")
      .deliver(JSON.parse('{"access_url": "https://a.example", "__proto__": "gone"}'));

    expect(problems[0]?.kind).toBe(WORKER_PROBLEM_KINDS.DELIVERY_FIELD_DROPPED);
    expect(problems[0]?.subject).toBe("order-1");
    expect(problems[0]?.fatal).toBe(false);
    // A warning, not a refusal: the call goes through, as on the worker's
    // road.
    expect(result).toStrictEqual({ ok: true, result: "delivered" });
  });

  it("says when an acceptance is given something it does not carry, on both roads", async () => {
    // An acceptance carries nothing; TypeScript refuses an argument, but a
    // merchant writing JavaScript can still pass one, the removed eta_seconds
    // above all, and it went nowhere without a word. The order is still taken
    // on, since refusing to would strand an order its buyer has paid for.
    const problems: WorkerProblem[] = [];
    const agentify = await gatewayServing({
      accept_order: () => ({ body: { ok: true } }),
    });
    agentify.on("problem", (problem) => problems.push(problem));
    const order = agentify.orders.forId("order-1") as unknown as {
      accepted: (given: unknown) => unknown;
      accept: (given: unknown) => Promise<unknown>;
    };

    const answered = order.accepted({ eta_seconds: 60 });
    const called = await order.accept({ eta_seconds: 60 });

    expect(answered).toStrictEqual({ accepted: {} });
    expect(called).toStrictEqual({ ok: true });
    expect(gateway?.callsTo("accept_order")[0]?.body).toStrictEqual({});
    expect(problems.map((problem) => [problem.kind, problem.subject, problem.fatal])).toStrictEqual(
      [
        [WORKER_PROBLEM_KINDS.ACCEPTANCE_ARGUMENT_IGNORED, "order-1", false],
        [WORKER_PROBLEM_KINDS.ACCEPTANCE_ARGUMENT_IGNORED, "order-1", false],
      ],
    );
    // An acceptance with nothing in it, the ordinary one, says nothing.
    (agentify.orders.forId("order-2") as unknown as { accepted: () => unknown }).accepted();
    expect(problems).toHaveLength(2);
  });

  it("says nothing about an ordinary delivery", async () => {
    // The negative control: a warning on every delivery would be noise.
    const problems: WorkerProblem[] = [];
    const agentify = await gatewayServing({
      deliver_order: () => ({ body: { ok: true, result: "delivered" } }),
      refuse_order: () => ({ body: { ok: true, result: "refused" } }),
    });

    agentify.on("problem", (problem) => problems.push(problem));

    await agentify.orders.forId("order-1").deliver({ access_url: "https://a.example" });
    await agentify.orders.forId("order-1").refuse({ code: "out_of_stock", message: "none left" });

    expect(problems).toStrictEqual([]);
  });

  it("returns a refusal of the call rather than throwing it", async () => {
    // These errors are returned with whether a repeat could help, so a
    // merchant never wraps a retry loop around a case no repeat changes.
    const error = {
      code: "fulfillment_closed",
      message: "the merchant closed future fulfillment through Agentify",
      retryable: false,
    };
    const agentify = await gatewayServing({
      deliver_order: () => ({ status: 409, body: { ok: false, error } }),
    });

    const result = await agentify.orders.forId("order-1").deliver({
      access_url: "https://example.com/a",
    });

    expect(result).toStrictEqual({ ok: false, error });
  });

  it("turns a gateway that did not answer into a retryable error, not an exception", async () => {
    // A dropped connection is the case the retryable flag exists for, and it
    // arrives through the same branch.
    const agentify = await gatewayServing({
      refuse_order: () => ({ status: 502, text: "bad gateway" }),
    });

    const result = await agentify.orders.forId("order-1").refuse({
      code: "out_of_stock",
      message: "Поставщик не подтвердил номер",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.retryable).toBe(true);
    expect(result.ok === false && result.error.message).toMatch(/refuse_order/);
  });

  it("does not read an order call's answer out of a document that is not one", async () => {
    // A body that parses and is not the answer must not become a delivery the
    // merchant believes went through.
    const agentify = await gatewayServing({
      deliver_order: () => ({ text: JSON.stringify({ ok: "yes", result: "delivered" }) }),
    });

    const result = await agentify.orders.forId("order-1").deliver({
      access_url: "https://a.example",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.retryable).toBe(true);
    // The gateway did answer: an unreadable body, not a call that never
    // arrived.
    expect(result.ok === false && result.error.code).toBe(ANSWER_NOT_UNDERSTOOD);
  });

  it("keeps three different facts about a failed call apart", async () => {
    // A refused connection certainly delivered nothing; an unreadable answer
    // reached the gateway and may have done its work; a call sent into silence
    // is neither, and saying it never arrived would invent the one fact the
    // merchant needs.
    const answering = await gatewayServing({
      deliver_order: () => ({ text: "<html>gateway timeout</html>" }),
    });
    const answered = await answering.orders.forId("order-1").deliver({
      access_url: "https://a.example",
    });

    expect(answered.ok === false && answered.error.code).toBe(ANSWER_NOT_UNDERSTOOD);
    expect(answered.ok === false && answered.error.message).toMatch(/reached us/);

    // Listening a moment ago and not now: the connection is refused, so
    // nothing was handed over.
    const closed = await startFakeGateway({ apiKey: API_KEY, routes: {} });
    await closed.close();

    const gone = createClient({ apiKey: API_KEY, baseUrl: closed.url });
    const never = await gone.orders.forId("order-1").deliver({ access_url: "https://a.example" });

    expect(never.ok === false && never.error.code).toBe(CALL_DID_NOT_REACH_US);
    expect(never.ok === false && never.error.retryable).toBe(true);
    expect(never.ok === false && never.error.message).toMatch(/did not reach us/);
  });

  it("carries the third fact under its own code when nothing came back", async () => {
    // A request taken and dropped mid-flight; filed as never arrived, it would
    // tell a merchant their delivery certainly did not happen.
    const takenAndDropped = createServer((_request, response) => {
      response.socket?.destroy();
    });

    await new Promise<void>((resolve) => takenAndDropped.listen(0, "127.0.0.1", resolve));

    const port = (takenAndDropped.address() as AddressInfo).port;
    const agentify = createClient({ apiKey: API_KEY, baseUrl: `http://127.0.0.1:${port}` });

    try {
      const result = await agentify.orders.forId("order-1").deliver({
        access_url: "https://a.example",
      });

      expect(result.ok === false && result.error.code).toBe(OUTCOME_UNKNOWN);
      expect(result.ok === false && result.error.retryable).toBe(true);
      expect(result.ok === false && result.error.message).toMatch(/not known here/);
      expect(result.ok === false && result.error.message).not.toMatch(/did not reach us/);
    } finally {
      takenAndDropped.closeAllConnections();
      await new Promise<void>((resolve) => takenAndDropped.close(() => resolve()));
    }
  });

  it("does not blame the gateway for an answer that died halfway through", async () => {
    // The gateway answered with a status and part of a body, and then the
    // connection broke. Calling that "not JSON" would blame the gateway for a
    // broken wire; what is known is that the call arrived and its outcome is
    // not.
    const diedMidSentence = createServer((_request, response) => {
      // A length longer than what is written, so the reader waits for bytes
      // that never arrive.
      response.writeHead(200, { "content-type": "application/json", "content-length": "512" });
      response.write('{"order_id":"order-1","st', () => response.socket?.destroy());
    });

    await new Promise<void>((resolve) => diedMidSentence.listen(0, "127.0.0.1", resolve));

    const port = (diedMidSentence.address() as AddressInfo).port;
    const agentify = createClient({ apiKey: API_KEY, baseUrl: `http://127.0.0.1:${port}` });

    try {
      const result = await agentify.orders.forId("order-1").deliver({
        access_url: "https://a.example",
      });

      // Not the unreadable-answer fact, which would blame the gateway.
      expect(result.ok === false && result.error.code).toBe(OUTCOME_UNKNOWN);
      expect(result.ok === false && result.error.code).not.toBe(ANSWER_NOT_UNDERSTOOD);
      expect(result.ok === false && result.error.retryable).toBe(true);
      // And not the never-arrived fact, which would claim it did nothing.
      expect(result.ok === false && result.error.message).not.toMatch(/did not reach us/);
      // The sentence carries the status the gateway got as far as, which tells
      // the two broken-wire cases apart.
      expect(result.ok === false && result.error.message).toMatch(
        /began answering 200 and the answer could not be read to the end/,
      );
      expect(result.ok === false && result.error.message).not.toMatch(/is not JSON/);
      // A status and part of a body did come back, so "nothing came back"
      // would contradict the sentence it introduces.
      expect(result.ok === false && result.error.message).not.toMatch(/nothing came back/);
    } finally {
      diedMidSentence.closeAllConnections();
      await new Promise<void>((resolve) => diedMidSentence.close(() => resolve()));
    }
  });

  it("promises a safe repeat only where the contract promises one", async () => {
    // Delivering and accepting may be repeated; refusing is documented as
    // neither, and retrying it on this package's say-so could apply a refusal after fulfillment.
    const agentify = await gatewayServing({
      deliver_order: () => ({ text: "not an answer" }),
      refuse_order: () => ({ text: "not an answer" }),
      accept_order: () => ({ text: "not an answer" }),
    });

    const held = agentify.orders.forId("order-1");
    const delivered = await held.deliver({ access_url: "https://a.example" });
    const refused = await held.refuse({ code: "out_of_stock", message: "no" });
    const accepted = await held.accept();

    expect(delivered.ok === false && delivered.error.message).toMatch(/may be made again/);
    expect(accepted.ok === false && accepted.error.message).toMatch(/may be made again/);
    expect(refused.ok === false && refused.error.message).not.toMatch(/may be made again/);
  });

  it("takes an order on, with and without an expected time", async () => {
    const agentify = await gatewayServing({ accept_order: () => ({ body: { ok: true } }) });

    const held = agentify.orders.forId("order-1");

    expect(await held.accept()).toStrictEqual({ ok: true });

    expect(gateway?.callsTo("accept_order").map((call) => call.body)).toStrictEqual([{}]);
  });
});

describe("a refusal the gateway put into words", () => {
  /**
   * The refusal the real gateway answers `get_order` with for an order that
   * closed before a price was named, as `apps/gateway/src/http/routes.ts`
   * writes it. Scripted as text, because it is not the route's document.
   */
  const closedBeforePriced = JSON.stringify({
    error: {
      code: "order_closed_before_it_was_priced",
      message:
        "this order ended as rejected before anybody named a price for it, so there is no sale to describe",
      retryable: false,
      status: "rejected",
    },
  });

  it("tells the merchant what the gateway said, not that we could not parse it", async () => {
    // The promise: a refusal reaches the caller in the gateway's own words,
    // not as "not the document it promises" about an order that is over.
    const agentify = await gatewayServing({
      get_order: () => ({ status: 409, text: closedBeforePriced }),
    });

    const refused = await agentify.orders.get("order-1").then(
      () => null,
      (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)),
    );

    expect(refused).toContain("order_closed_before_it_was_priced");
    expect(refused).toContain("no sale to describe");
    expect(refused).not.toContain("is not the document it promises");
  });

  it("hands an order call the gateway's own refusal instead of a word we invented", async () => {
    // An order call does not throw, so the refusal arrives as the failure it
    // is, and the clause before it must not say the answer was unreadable.
    const agentify = await gatewayServing({
      deliver_order: () => ({
        status: 404,
        text: JSON.stringify({
          error: { code: "no_such_order", message: "there is no such order", retryable: false },
        }),
      }),
    });

    const result = await agentify.orders.forId("order-1").deliver({
      access_url: "https://a.example",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toContain("no_such_order");
    expect(result.ok === false && result.error.message).toContain("there is no such order");
    expect(result.ok === false && result.error.message).not.toMatch(/could not be read/);
    // The code is what a program reads, so it must say what the message says:
    // the gateway named the refusal, and its name travels.
    expect(result.ok === false && result.error.code).toBe("no_such_order");
    expect(result.ok === false && result.error.code).not.toBe(ANSWER_NOT_UNDERSTOOD);
  });

  it("gives a thrown call and a returned one the same word for one refusal", async () => {
    // One vocabulary: `publish_card` throws and `deliver_order` returns, and
    // the same refusal must have the same name on both.
    const answer = {
      status: 401,
      text: JSON.stringify({
        error: {
          code: "not_authorised",
          message: "this call is behind the merchant's key",
          retryable: false,
        },
      }),
    };
    const agentify = await gatewayServing({
      deliver_order: () => answer,
      publish_card: () => answer,
    });

    const returned = await agentify.orders.forId("order-1").deliver({
      access_url: "https://a.example",
    });
    const thrown = await agentify.catalog.publish(card).then(
      () => null,
      (raised: unknown) => raised,
    );

    expect(returned.ok === false && returned.error.code).toBe("not_authorised");
    expect(thrown instanceof AgentifyError && thrown.code).toBe("not_authorised");
    // And the same retry answer on both roads.
    expect(returned.ok === false && returned.error.retryable).toBe(false);
    expect(thrown instanceof AgentifyError && thrown.retryable).toBe(false);
  });

  it("takes the gateway's word about calling again rather than deciding for it", async () => {
    // Only the side that refused knows whether its door is shut for good; the
    // two refusals below share shape and status and give opposite advice, so
    // deciding from either would be a guess.
    const said = (retryable: boolean) => ({
      status: 500,
      text: JSON.stringify({
        error: { code: "gateway_failed", message: "nothing was decided", retryable },
      }),
    });

    const willing = await gatewayServing({ deliver_order: () => said(true) });
    const definite = await gatewayServing({ deliver_order: () => said(false) });

    const first = await willing.orders
      .forId("order-1")
      .deliver({ access_url: "https://a.example" });
    const second = await definite.orders
      .forId("order-1")
      .deliver({ access_url: "https://a.example" });

    expect(first.ok === false && first.error.retryable).toBe(true);
    expect(second.ok === false && second.error.retryable).toBe(false);

    // The invitation to repeat rides with the flag, not with the route.
    expect(first.ok === false && first.error.message).toMatch(/may be made again/);
    expect(second.ok === false && second.error.message).not.toMatch(/may be made again/);
  });

  it("says a call it could not read may be worth making again", async () => {
    // Nothing readable came back, so there is no gateway answer to defer to,
    // and "do not call again" would be invented from a failure to parse.
    const agentify = await gatewayServing({
      deliver_order: () => ({ status: 502, text: "<html>a proxy, not a gateway</html>" }),
    });

    const result = await agentify.orders.forId("order-1").deliver({
      access_url: "https://a.example",
    });

    expect(result.ok === false && result.error.code).toBe(ANSWER_NOT_UNDERSTOOD);
    expect(result.ok === false && result.error.retryable).toBe(true);
  });

  it("still says what came back when the answer is not a refusal either", async () => {
    // The negative control: JSON that is neither the document nor a refusal
    // comes back quoted, so a person can see what was sent.
    const agentify = await gatewayServing({
      get_order: () => ({ status: 409, text: JSON.stringify({ trouble: "no code, no words" }) }),
    });

    const refused = await agentify.orders.get("order-1").then(
      () => null,
      (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)),
    );

    expect(refused).toContain("is not the document it promises");
    expect(refused).toContain("no code, no words");
  });

  it("does not read a half-written refusal as a refusal", async () => {
    // A code with no words is not a refusal a caller can act on, so the body
    // is quoted instead.
    const agentify = await gatewayServing({
      get_order: () => ({ status: 409, text: JSON.stringify({ error: { code: "no_message" } }) }),
    });

    const refused = await agentify.orders.get("order-1").then(
      () => null,
      (thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)),
    );

    expect(refused).toContain("is not the document it promises");
    expect(refused).toContain("no_message");
  });
});

describe("what is thrown where a route has no failure branch", () => {
  // Publishing, reading one order and listing orders have no failure branch,
  // so they throw, carrying a code to branch on and the route it happened on.

  it("carries the gateway's own code when the gateway is the one refusing", async () => {
    // The gateway said what it would not do and why; filing that under one of
    // this package's codes would lose the word the merchant can act on.
    const agentify = await gatewayServing({
      publish_card: () => ({
        status: 401,
        text: JSON.stringify({
          error: {
            code: "not_authorised",
            message: "this key does not open this call",
            retryable: false,
          },
        }),
      }),
    });

    const thrown = await agentify.catalog.publish(card).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(thrown).toBeInstanceOf(AgentifyError);
    expect(thrown instanceof AgentifyError && thrown.code).toBe("not_authorised");
    expect(thrown instanceof AgentifyError && thrown.route).toBe("publish_card");
    expect(thrown instanceof Error && thrown.message).toContain("this key does not open this call");
  });

  it("carries the code for a call that never arrived", async () => {
    // The same codes the order calls return. This one claims nothing was
    // handed over: an address listening a moment ago and not now.
    const closed = await startFakeGateway({ apiKey: API_KEY, routes: {} });
    await closed.close();

    const agentify = createClient({ apiKey: API_KEY, baseUrl: closed.url });

    const thrown = await agentify.orders.get("order-1").then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(thrown).toBeInstanceOf(AgentifyError);
    expect(thrown instanceof AgentifyError && thrown.code).toBe(CALL_DID_NOT_REACH_US);
    expect(thrown instanceof AgentifyError && thrown.route).toBe("get_order");
  });

  it("carries the code for an answer that reached us and could not be read", async () => {
    // This call did reach the gateway, so it must not wear the never-arrived
    // code.
    const agentify = await gatewayServing({
      list_orders: () => ({ status: 502, text: "<html>gateway timeout</html>" }),
    });

    const thrown = await agentify.orders.list().then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(thrown instanceof AgentifyError && thrown.code).toBe(ANSWER_NOT_UNDERSTOOD);
    expect(thrown instanceof AgentifyError && thrown.route).toBe("list_orders");
  });

  it("leaves a client built wrong as a TypeError, which is a different thing", async () => {
    // The negative control: a missing address is a mistake in the merchant's
    // code before any call left, so it is a `TypeError`, not this class.
    const agentify = createClient({ apiKey: API_KEY });

    const thrown = await agentify.catalog.publish(card).then(
      () => null,
      (failure: unknown) => failure,
    );

    expect(thrown).toBeInstanceOf(TypeError);
    expect(thrown).not.toBeInstanceOf(AgentifyError);
  });

  it("names both addresses when it is the address that is missing", async () => {
    // The fix has to be in the sentence: there is no default, because
    // choosing an environment is the merchant's to do on purpose.
    const agentify = createClient({ apiKey: API_KEY });

    await expect(agentify.catalog.publish(card)).rejects.toThrow(/https:\/\/test\.agentify\.ad/);
    await expect(agentify.catalog.publish(card)).rejects.toThrow(/https:\/\/agentify\.ad/);
  });
});

describe("the door on every call", () => {
  it("presents the merchant's key on the calls that are behind it", async () => {
    // The fake gateway refuses a merchant-door call without the key, so
    // passing is the assertion.
    const agentify = await gatewayServing({ list_orders: () => ({ body: { orders: [] } }) });

    await agentify.orders.list();

    expect(gateway?.callsTo("list_orders")[0]?.apiKey).toBe(API_KEY);
  });
});

describe("what a failed call says about whether it arrived", () => {
  it("claims nothing was sent only when every address tried says so", () => {
    // A name resolving to several addresses fails with one error holding the
    // others; if any attempt connected, nothing was refused outright and the
    // answer is unknown.
    const failing = (...codes: string[]): unknown => ({
      cause: codes.length === 1 ? { code: codes[0] } : { errors: codes.map((code) => ({ code })) },
    });

    expect(reachOf(failing("ECONNREFUSED"))).toBe(REACH.NOT_RECEIVED);
    expect(reachOf(failing("ECONNREFUSED", "ENOTFOUND"))).toBe(REACH.NOT_RECEIVED);
    expect(reachOf(failing("ECONNREFUSED", "ECONNRESET"))).toBe(REACH.UNKNOWN);
    expect(reachOf(failing("ECONNRESET"))).toBe(REACH.UNKNOWN);
    expect(reachOf(failing())).toBe(REACH.UNKNOWN);
    expect(reachOf(new Error("something with no cause at all"))).toBe(REACH.UNKNOWN);
    expect(reachOf(undefined)).toBe(REACH.UNKNOWN);
  });
});

describe("what a failed call is told to the merchant as", () => {
  const failing = (reach: Reach): TransportFailure => ({
    route: "deliver_order",
    reason: "the reason, whatever it was",
    reach,
  });

  it("says a different thing for each of the three, and never the wrong one", () => {
    // Each sentence is a claim about a merchant's books: "your delivery did
    // not happen" versus "we cannot tell whether it did".
    const said = {
      [REACH.NOT_RECEIVED]: whatIsKnown(failing(REACH.NOT_RECEIVED)),
      [REACH.ANSWERED]: whatIsKnown(failing(REACH.ANSWERED)),
      [REACH.UNKNOWN]: whatIsKnown(failing(REACH.UNKNOWN)),
    };

    expect(new Set(Object.values(said)).size).toBe(3);

    // Only the first is allowed to say the call did not arrive.
    expect(said[REACH.NOT_RECEIVED]).toMatch(/did not reach us/);
    expect(said[REACH.ANSWERED]).not.toMatch(/did not reach us/);
    expect(said[REACH.UNKNOWN]).not.toMatch(/did not reach us/);

    // The other two say plainly that this side cannot tell, and which silence
    // it was.
    expect(said[REACH.ANSWERED]).toMatch(/reached us/);
    expect(said[REACH.ANSWERED]).toMatch(/not known here/);
    expect(said[REACH.UNKNOWN]).toMatch(/not known here/);

    // The third must be true of every road into it: an abort that may not
    // have sent anything, a connection broken after sending, and an answer cut
    // off mid-way, which certainly arrived. So it claims neither that the call
    // was sent nor that nothing came back.
    expect(said[REACH.UNKNOWN]).not.toMatch(/it was sent/);
    expect(said[REACH.UNKNOWN]).not.toMatch(/nothing came back/);
    expect(said[REACH.UNKNOWN]).not.toMatch(/whether it arrived/);

    // What all three share is pinned too, so the clause keeps saying the
    // exchange was cut short.
    expect(said[REACH.UNKNOWN]).toMatch(/did not finish/);
  });
});
