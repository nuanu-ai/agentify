/**
 * The client a merchant's engineer holds: a catalog, an order desk, and one
 * place to say what this process answers. Every method here is one a page of
 * the documentation tells a merchant to call, and the documentation's examples
 * are compiled against these types by a test.
 *
 * One stream carries orders, price questions and order events, so there is one
 * way to register a handler, `on(kind, handler)`, and one lifecycle, `start`
 * and `stop`.
 *
 * Two families of calls on an order look alike and are not. `delivered`,
 * `refused` and `accepted` build the answer a handler returns and send
 * nothing; returning it is what makes forgetting to answer, or answering
 * twice, impossible. `deliver`, `refuse` and `accept` send: they are the
 * asynchronous merchant's calls, made later from anywhere in their code, and
 * they are on every order this client hands back, including `orders.forId`
 * for a process that kept only the identifier.
 *
 * What the contract gives a failure branch is returned, never thrown, in one
 * envelope whose `ok` says which it was. What has no branch is thrown: a client
 * built wrong is a `TypeError` before anything leaves the process, and a call
 * that went out and produced no answer its route can carry is an
 * `AgentifyError` under the same codes.
 */

import type {
  CallError,
  CardInput,
  Delivery,
  HandlerAnswer,
  Money,
  Order,
  OrderAcceptResponse,
  OrderCallResponse,
  OrderCloseRequest,
  OrderCloseResponse,
  OrderWithStatus,
  PublishResult,
  QuoteRequest,
  QuoteResponse,
  Refusal,
} from "@nuanu-ai/agentify-contracts";
import {
  callRoute,
  type Gateway,
  REACH,
  type Reach,
  type TransportFailure,
  whatIsKnown,
} from "./transport.js";
import {
  acceptanceArgumentWarning,
  droppedFieldWarning,
  type EventHandler,
  type HandlerRegistry,
  type ProblemReporter,
  REGISTERED_AS,
  type RunningWorker,
  reportSafely,
  type StreamHandlerKind,
  startWorker,
  type WorkerProblem,
} from "./worker.js";

export interface ClientOptions {
  /**
   * The merchant's API key. `undefined` is accepted by the type, since that is
   * what `process.env.AGENTIFY_API_KEY` is, and refused when the client is
   * built with a `TypeError` naming what is missing.
   */
  readonly apiKey: string | undefined;

  /**
   * Where the gateway is: `https://test.agentify.ad` while the merchant is
   * building, `https://agentify.ad` once they are live.
   *
   * There is no default on purpose: which of the two a process talks to is the
   * difference between a sale and a rehearsal, and every answer from the wrong
   * one parses perfectly. Left out, the client is still built, and every call
   * that has to reach the gateway throws a `TypeError` naming both addresses.
   * A value that is not an http or https address is refused when the client
   * is built.
   */
  readonly baseUrl?: string | undefined;
}

/**
 * The calls every order carries, wherever the merchant got it from.
 *
 * `delivered`, `refused` and `accepted` build an answer and send nothing: they
 * are what a handler returns, and the SDK posts the return. `deliver`,
 * `refuse` and `accept` send, and are what an asynchronous merchant calls
 * later, from another part of their code or another process.
 */
export interface OrderCalls {
  /** The goods, as the handler's answer. Building one sends nothing. */
  delivered(delivery: Delivery): HandlerAnswer;

  /** A final "this cannot be delivered", as the handler's answer. */
  refused(refusal: Refusal): HandlerAnswer;

  /**
   * Taking the order on without delivering yet, as the handler's answer. It
   * carries nothing: what the merchant is held to is the delivery deadline on
   * the card.
   */
  accepted(): HandlerAnswer;

  /**
   * The goods for an order taken on earlier. Idempotent by the order's
   * identifier, so repeating it after a dropped connection delivers nothing
   * twice and charges nothing twice.
   */
  deliver(delivery: Delivery): Promise<OrderCallResponse>;

  /**
   * A final "this cannot be delivered" for an order already taken on. Unlike
   * `deliver`, it is not promised to be safe to repeat: when it fails, and
   * above all with `outcome_unknown`, read the order back with `orders.get`
   * before sending it again.
   */
  refuse(refusal: Refusal): Promise<OrderCallResponse>;

  /** Takes the order on from outside a handler. Repeating it is harmless. */
  accept(): Promise<OrderAcceptResponse>;

  /**
   * Stops future fulfillment through Agentify for this order. The message is
   * your statement to the buyer, which their agent reads as your words;
   * Agentify confirms no refund or agreement. Repeating the call succeeds and
   * keeps the first closure's time and message. Closing cannot be undone, and
   * it causes no new charge.
   *
   * It does not cancel a payment already accepted for execution, and Agentify
   * keeps checking that payment for an outcome. If it completes after you
   * closed, you receive `order.unfulfilled` with reason `paid_after_closure`,
   * and the order is on `orders.list({ open: true })` until you close it
   * again, which records that closure's own time and message.
   *
   * Resolves to `{ ok: true }`, or to `ok: false` with an `error` and leaves the
   * order unchanged: `fulfillment_complete` where the goods were delivered or
   * the parcel's shipment is recorded, and `nothing_to_close` where the order
   * ended without a charge and holds nothing for its buyer.
   */
  close(options?: OrderCloseRequest): Promise<OrderCloseResponse>;
}

/**
 * The least an order can be and still be answered: its identifier and the
 * calls that close it. It is what `orders.forId` returns, and the type to take
 * in a function that only closes orders.
 */
export type OrderHandle = { readonly id: string } & OrderCalls;

/**
 * An order off the stream, with the calls that close it. It holds the client
 * that produced it, so the merchant never passes an identifier back.
 */
export type LiveOrder = Order & OrderCalls;

/** An order read back from Agentify, with where it stands and the calls that close it. */
export type LiveOrderWithStatus = OrderWithStatus & OrderCalls;

/**
 * The two answers a price question has. `asOf` is when the answer was true,
 * which separates "I went and looked" from "here is what was in the cache";
 * left out, it is the moment the answer is built, so a merchant answering
 * from a cache passes the moment that cache was filled.
 */
export interface QuoteCalls {
  available(price: Money, asOf?: string): QuoteResponse;
  unavailable(asOf?: string): QuoteResponse;
}

/** A price question, with the two answers it can be given. */
export type LiveQuoteRequest = QuoteRequest & QuoteCalls;

/** What the merchant's code does with one paid order. */
export type OrderHandler = (order: LiveOrder) => HandlerAnswer | Promise<HandlerAnswer>;

/** What the merchant's code answers to "how much is this and is it there". */
export type QuoteHandler = (question: LiveQuoteRequest) => QuoteResponse | Promise<QuoteResponse>;

/**
 * Everything a merchant's process can be asked to answer, by the word it is
 * registered under. `problem` is not on the wire; it is where the worker
 * reports what went wrong, registered like the others.
 */
export interface Handlers {
  order: OrderHandler;
  quote: QuoteHandler;
  event: EventHandler;
  problem: ProblemReporter;
}

const PROBLEM = "problem";

export type HandlerKind = StreamHandlerKind | typeof PROBLEM;

/**
 * Whether a type is a union of more than one thing. `on` uses it to refuse a
 * kind that could be any of several, since only one kind says which handler
 * is right.
 */
type IsUnion<Kind, Each = Kind> = Kind extends unknown
  ? [Each] extends [Kind]
    ? false
    : true
  : never;

/**
 * The words `on` accepts. A merchant outside TypeScript, or one who wrote
 * `orders`, would otherwise register a handler that is never called. As a
 * mapped type, it stops compiling when a kind is added and this is not.
 */
const HANDLER_KINDS: { readonly [Kind in HandlerKind]: true } = Object.freeze({
  order: true,
  quote: true,
  event: true,
  problem: true,
});

/** Every word `on` accepts, for the sentence that refuses one that is not. */
const everyKind = (): string[] => Object.keys(HANDLER_KINDS).map((kind) => `'${kind}'`);

/** The kinds that answer something on the stream, which `problem` does not. */
const streamKinds = (): StreamHandlerKind[] => Object.values(REGISTERED_AS);

export interface CatalogNamespace {
  /**
   * Publishes one product, or says what is wrong with the card.
   *
   * Publishing again under the same `merchant_item_id` changes that card
   * rather than adding a second, so a publish script can be run as often as
   * a merchant likes. A refused card comes back as `ok: false` with every
   * finding under `error.problems`.
   *
   * The card may use the short forms `CardInput` allows: the price as one
   * string, a declared field as its type word, the fulfillment mode left off.
   * They are opened out on acceptance, so a card read back is in the
   * canonical form. Throws `AgentifyError` when the call fails without a
   * publish result, such as a refused key or an answer that could not be read.
   */
  publish(card: CardInput): Promise<PublishResult>;
}

export interface OrdersNamespace {
  /**
   * The calls for an order named by its identifier, without asking Agentify
   * anything. It is for a process that kept only the identifier, such as a job
   * queued against it. Because it makes no call, it works during an outage,
   * when a delivery that comes back as "call again" is the answer needed.
   */
  forId(orderId: string): OrderHandle;

  /**
   * One order and the state it is in, with the calls that close it. Throws
   * `AgentifyError` when the call fails, including an unknown order.
   */
  get(orderId: string): Promise<LiveOrderWithStatus>;

  /**
   * Orders and the states they are in. With `open: true`, only the ones a
   * restarted worker should walk: orders it was handed and has not finished,
   * an unfulfilled paid order, one delivered but never paid for, and a closed
   * one whose payment completed after you closed it. An order
   * that was priced and never paid never reached the handler, so it is not on
   * that list; `get` still reads it. Throws `AgentifyError` when the call
   * fails.
   */
  list(query?: { readonly open?: boolean }): Promise<readonly LiveOrderWithStatus[]>;
}

export interface AgentifyClient {
  readonly catalog: CatalogNamespace;
  readonly orders: OrdersNamespace;

  /**
   * Registers what this process answers for one kind: `'order'`, `'quote'`,
   * `'event'` or `'problem'`.
   *
   * Once per kind: a second registration throws a `TypeError` rather than
   * silently replacing the first. Handlers may be registered before or after
   * `start`, and survive `stop`.
   *
   * The kind must be one literal kind. A kind held in a variable or a loop
   * over several admits no handler, because a union would let an order handler
   * type-check under `'quote'` and fail at the first price question.
   */
  on<Kind extends HandlerKind>(
    kind: Kind,
    handler: IsUnion<Kind> extends true ? never : Handlers[Kind],
  ): void;

  /**
   * Opens the subscription and returns once it is running. It is outgoing, so
   * nothing of the merchant's has to be reachable from outside, and one
   * subscription carries orders, price questions and order events together.
   *
   * Throws a `TypeError` when no gateway address was given, when the client is
   * already started or still stopping, or when nothing is registered to
   * answer.
   */
  start(): Promise<void>;

  /**
   * Stops the subscription and waits for it to finish. Safe to call twice,
   * and on a client that was never started. Handlers stay registered.
   *
   * A poll parked at the gateway is dropped; anything taken in the instant
   * before is an order, which comes again, or an event, which is sent once.
   * An answer already on its way is dropped too, and nobody on this side knows
   * whether it arrived: the order may be closed by it or may come back. The
   * merchant's problem reporter is told which orders that happened to.
   *
   * Stopping does not drain the queue, which would pull more work into a
   * process that is going away.
   */
  stop(): Promise<void>;
}

/**
 * The codes an order call or an `AgentifyError` carries when the gateway
 * produced no answer this package can read. The SDK produces them; the
 * gateway never sends them.
 *
 * `call_did_not_reach_us`: the call certainly changed nothing.
 * `answer_not_understood`: the call reached the gateway and may have done its
 * work; what it said could not be read. `outcome_unknown`: the call was sent
 * into silence, such as a dropped connection or a worker shut down
 * mid-flight, and nobody on this side knows whether it arrived.
 */
export const CALL_DID_NOT_REACH_US = "call_did_not_reach_us";
export const ANSWER_NOT_UNDERSTOOD = "answer_not_understood";
export const OUTCOME_UNKNOWN = "outcome_unknown";

const CODE_FOR: Readonly<Record<Reach, string>> = {
  [REACH.NOT_RECEIVED]: CALL_DID_NOT_REACH_US,
  [REACH.ANSWERED]: ANSWER_NOT_UNDERSTOOD,
  [REACH.UNKNOWN]: OUTCOME_UNKNOWN,
};

/**
 * What is thrown where a call has no failure branch to return: publishing a
 * card, reading one order, listing orders.
 *
 * `code` is the gateway's own code where it refused in words this package
 * recognises, and otherwise `call_did_not_reach_us`, `answer_not_understood`
 * or `outcome_unknown`. `route` names the call as the contract's route table
 * does, so a `catch` can tell the calls apart without reading the message.
 *
 * A client built wrong (a missing key, a `baseUrl` that is not an address, a
 * handler registered twice) throws `TypeError` instead, before anything leaves
 * the process.
 */
export class AgentifyError extends Error {
  /** Why the call did not go through, for the code that branches on it. */
  readonly code: string;

  /** The call it happened on, named as the contract's route table names it. */
  readonly route: string;

  /**
   * Whether making the same call again could get past this: the gateway's own
   * answer where it refused in words, and true where nothing readable came
   * back, which says what this package knows, not that the call will work.
   */
  readonly retryable: boolean;

  constructor(code: string, route: string, message: string, retryable: boolean) {
    super(message);
    this.name = "AgentifyError";
    this.code = code;
    this.route = route;
    this.retryable = retryable;
  }
}

/**
 * What an order call hands back when it produced no answer of its own.
 *
 * `code` is the gateway's own where it refused in words this package
 * recognises, and otherwise one of the three codes for a silence, the same
 * choice `AgentifyError` makes. `retryable` is the gateway's own answer where
 * it gave one, and true where nothing readable came back, since that is a
 * statement about what this package knows, not about the order.
 *
 * The sentence saying the call may be repeated safely is added only where the
 * call is idempotent (delivering, accepting or closing; not refusing) and repeating it
 * could get anywhere.
 */
const failedCall = (repeatIsSafe: boolean, failure: TransportFailure): CallError => {
  const retryable = failure.refusal?.retryable ?? true;

  return {
    code: failure.refusal?.code ?? CODE_FOR[failure.reach],
    message:
      repeatIsSafe && retryable
        ? `${whatIsKnown(failure)}: ${failure.reason} — this call may be made again without doing its work twice`
        : `${whatIsKnown(failure)}: ${failure.reason}`,
    retryable,
  };
};

/**
 * The reporter a client gets when the merchant registered none. A worker that
 * stopped and told nobody is worse than a library writing to the console.
 */
const reportToConsole: ProblemReporter = (problem: WorkerProblem): void => {
  // The exception goes out beside the sentence, because its stack is what a
  // merchant debugging their own handler needs.
  if (problem.cause === undefined) {
    console.error(`[agentify] ${problem.kind}: ${problem.message}`);
    return;
  }

  console.error(`[agentify] ${problem.kind}: ${problem.message}`, problem.cause);
};

/**
 * What a key says about the deployment it was issued for, read from its
 * prefix: every key carries its environment as its prefix.
 *
 * This copies a rule whose home is `keyPrefixFor` in
 * `packages/core/src/deployment/environment.ts`, which this published package
 * cannot depend on. `which-world.test.ts` builds keys with core's own function
 * and checks these sentences, so a prefix changed on one side fails the tests;
 * change both together.
 *
 * A key matching neither prefix gets no line at all: guessing would risk
 * telling a merchant their money is play when it is real, or the reverse.
 */
const WHAT_THE_KEY_SAYS: Readonly<Record<string, string>> = Object.freeze({
  csk_test_: "with a test key: the money there is not real",
  csk_live_: "with a live key: the money there is real",
});

const whatTheKeySays = (apiKey: string): string | undefined =>
  Object.entries(WHAT_THE_KEY_SAYS).find(([prefix]) => apiKey.startsWith(prefix))?.[1];

const keyOf = (apiKey: string | undefined): string => {
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new TypeError(
      "createClient needs the merchant's API key, and was given none — check that the environment variable holding it is set where this process can read it",
    );
  }

  return apiKey;
};

/**
 * The address as given, checked as far as it can be without using it. A value
 * that is not an http or https address is refused at once; an address not
 * given at all is refused by the first call that needs it.
 */
const addressOf = (baseUrl: string | undefined): string => {
  if (baseUrl === undefined) return "";

  let parsed: URL;

  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError(`baseUrl is not an address: ${JSON.stringify(baseUrl)}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError(
      `baseUrl is not an http address: ${JSON.stringify(baseUrl)} — the gateway is reached over https, and over http only where the two run on one machine`,
    );
  }

  return baseUrl;
};

/** Refuses to compile if a kind is added to `Handlers` and not registered here. */
const assertEveryKindIsRegistered = (kind: never): never => {
  throw new TypeError(`on() has no place to put a handler for ${JSON.stringify(kind)}`);
};

/**
 * Builds the client a merchant's code publishes cards and answers orders with,
 * against one gateway: `https://test.agentify.ad` while building,
 * `https://agentify.ad` once live, named in `baseUrl`.
 *
 * Building it calls nothing. It throws a `TypeError` at once when `apiKey` is
 * missing or blank and when `baseUrl` is given but is not an http or https
 * address. Left without `baseUrl`, it is still built, and every call that has to
 * reach the gateway throws a `TypeError` naming both addresses, since there is
 * no default to fall back on. Whether the key opens that gateway is learned at
 * the first call.
 *
 * Returns the client: `catalog.publish` for cards, `orders` to read and close
 * orders, `on` to register handlers, and `start` and `stop` for the
 * subscription that brings orders, price questions and order events in.
 */
export const createClient = (options: ClientOptions): AgentifyClient => {
  const gateway: Gateway = {
    apiKey: keyOf(options.apiKey),
    baseUrl: addressOf(options.baseUrl),
  };

  const reachable = (): void => {
    if (gateway.baseUrl === "") {
      throw new TypeError(
        "this client has no gateway address: pass baseUrl to createClient — https://test.agentify.ad while you are building, https://agentify.ad once you are live. There is no default on purpose: which of the two you talk to is the difference between a sale and a rehearsal, and an address this package chose for you would point somebody's production at the wrong one without a word",
      );
    }
  };

  /**
   * The handlers, and the loop that dispatches to them. The registry belongs
   * to the client, so a stopped client starts again on the same handlers.
   * `worker` is the loop currently running, if any; it can also end on its
   * own when the gateway speaks another contract version, so readers ask it
   * whether it is still running.
   */
  const registry: HandlerRegistry = { problem: reportToConsole };
  const registered = new Set<HandlerKind>();
  let worker: RunningWorker | undefined;
  /** Set while a stop is in flight, and shared by every caller of stop(). */
  let stopping: Promise<void> | undefined;
  /** Whether the world this client works in has already been said. */
  let worldIsSaid = false;

  /**
   * The one line this package writes uninvited: where this worker is pointed
   * and whether the money there is real. Once per client, since neither the
   * key nor the address can change. It goes to `console.info` because it is
   * not a fault, and it is not a `WorkerProblem`, since the reporter is for
   * what went wrong.
   */
  const sayWhichWorld = (): void => {
    if (worldIsSaid) return;

    worldIsSaid = true;

    const words = whatTheKeySays(gateway.apiKey);

    if (words === undefined) return;

    console.info(`[agentify] worker started against ${gateway.baseUrl} ${words}`);
  };

  const orderCall = async (
    route: "deliver_order" | "refuse_order",
    orderId: string,
    body: unknown,
  ): Promise<OrderCallResponse> => {
    reachable();

    if (route === "deliver_order") {
      // `droppedFieldWarning` covers the asynchronous delivery too: the field
      // goes no further than the gateway's parse, and this is the merchant's
      // only way to learn so. A warning, not a refusal; the rest is good.
      const dropped = droppedFieldWarning(orderId, body as Delivery);

      if (dropped !== null) reportSafely(registry.problem, dropped);
    }

    const answer = await callRoute(gateway, route, { path: { order_id: orderId }, body });

    return answer.ok
      ? answer.document
      : { ok: false, error: failedCall(route === "deliver_order", answer.failure) };
  };

  const acceptCall = async (orderId: string): Promise<OrderAcceptResponse> => {
    reachable();

    const answer = await callRoute(gateway, "accept_order", {
      path: { order_id: orderId },
      body: {},
    });

    // Accepting the same order again is harmless: an order is taken on afresh
    // on every redelivery.
    return answer.ok ? answer.document : { ok: false, error: failedCall(true, answer.failure) };
  };

  /**
   * The calls one order answers to, closed over its identifier and this
   * client. The identifier is captured once, when the order was read, and
   * never passes back through the merchant's hands, and an order kept for
   * hours still knows which gateway to call and with whose key.
   */
  const callsFor = (orderId: string): OrderCalls => ({
    delivered: (delivery) => ({ delivered: delivery }),
    refused: (refusal) => ({ refused: refusal }),
    accepted: (...given: unknown[]) => {
      if (given.length > 0) reportSafely(registry.problem, acceptanceArgumentWarning(orderId));
      return { accepted: {} };
    },
    deliver: (delivery) => orderCall("deliver_order", orderId, delivery),
    refuse: (refusal) => orderCall("refuse_order", orderId, refusal),
    close: async (options = {}) => {
      reachable();
      const answer = await callRoute(gateway, "close_order", {
        path: { order_id: orderId },
        body: options,
      });
      return answer.ok ? answer.document : { ok: false, error: failedCall(true, answer.failure) };
    },
    accept: (...given: unknown[]) => {
      if (given.length > 0) reportSafely(registry.problem, acceptanceArgumentWarning(orderId));
      return acceptCall(orderId);
    },
  });

  const withCalls = <Shape extends Order>(order: Shape): Shape & OrderCalls =>
    Object.assign({}, order, callsFor(order.id));

  const askedWithAnswers = (question: QuoteRequest): LiveQuoteRequest =>
    Object.assign({}, question, {
      available: (price: Money, asOf?: string): QuoteResponse => ({
        available: true,
        price,
        as_of: asOf ?? new Date().toISOString(),
      }),
      unavailable: (asOf?: string): QuoteResponse => ({
        available: false,
        as_of: asOf ?? new Date().toISOString(),
      }),
    });

  const document = async <Name extends "publish_card" | "get_order" | "list_orders">(
    route: Name,
    options_: Parameters<typeof callRoute<Name>>[2],
  ) => {
    reachable();

    const answer = await callRoute(gateway, route, options_);

    if (!answer.ok) {
      const { failure } = answer;

      // The gateway's own code and retry answer wherever it wrote them, ours
      // only where it did not, as `failedCall` does for the calls that return.
      throw new AgentifyError(
        failure.refusal?.code ?? CODE_FOR[failure.reach],
        failure.route,
        failure.reason,
        failure.refusal?.retryable ?? true,
      );
    }

    return answer.document;
  };

  return {
    catalog: {
      publish: (card) => document("publish_card", { body: card }),
    },

    orders: {
      forId: (orderId) => ({ id: orderId, ...callsFor(orderId) }),

      get: async (orderId) =>
        withCalls(await document("get_order", { path: { order_id: orderId } })),

      list: async (query) => {
        const listed = await document("list_orders", {
          // The wire carries the words "true" and "false", because a query
          // string carries text.
          query: query?.open === undefined ? {} : { open: query.open ? "true" : "false" },
        });

        return listed.orders.map((order) => withCalls(order));
      },
    },

    on(kind, handler) {
      if (!Object.hasOwn(HANDLER_KINDS, kind)) {
        throw new TypeError(
          `on() was given ${JSON.stringify(kind)}, which is not a kind this stream carries: the kinds are ${everyKind().join(", ")}`,
        );
      }

      if (registered.has(kind)) {
        throw new TypeError(
          `on('${kind}') was called twice on one client: the second handler would silently replace the first, and one message goes to one handler`,
        );
      }

      // Narrowed off the generic so the switch is exhaustive over the kinds.
      const which: HandlerKind = kind;

      switch (which) {
        case "order": {
          // Wrapped so the order the loop reads off the envelope gets this
          // client's calls attached.
          const answering = handler as Handlers["order"];

          registry.order = (arrived) => answering(withCalls(arrived));
          break;
        }
        case "quote": {
          const answering = handler as Handlers["quote"];

          registry.quote = (asked) => answering(askedWithAnswers(asked));
          break;
        }
        case "event": {
          registry.event = handler as Handlers["event"];
          break;
        }
        case "problem": {
          registry.problem = handler as Handlers["problem"];
          break;
        }
        default:
          return assertEveryKindIsRegistered(which);
      }

      // Recorded only after everything that could refuse has passed, so a call
      // that threw leaves no trace.
      registered.add(which);
    },

    start: async () => {
      reachable();

      if (stopping !== undefined) {
        throw new TypeError(
          "this client is being stopped: await that stop() before starting it again, or the loop being started would be racing the one going away",
        );
      }

      if (worker?.running() === true) {
        throw new TypeError(
          "this client is already started: a second loop would open a second long poll for one merchant, and an envelope handed to one of them is not handed to the other",
        );
      }

      // Read off the vocabulary, so a kind the stream grows counts as an
      // answer without anybody remembering to add it here.
      if (!streamKinds().some((kind) => registry[kind] !== undefined)) {
        throw new TypeError(
          `this client has nothing registered to answer with: register at least one of ${streamKinds()
            .map((kind) => `on('${kind}')`)
            .join(
              ", ",
            )} before start(), or the loop would take work off the queue that nobody answers`,
        );
      }

      // After every refusal above: a start that threw opened nothing and must
      // not say otherwise.
      sayWhichWorld();

      worker = startWorker(gateway, registry);
    },

    stop: async () => {
      const owned = worker;

      // A client never started has nothing to stop, so a shutdown routine can
      // call this unconditionally.
      if (owned === undefined) return;

      // One promise for every concurrent caller, so the clearing below happens
      // once rather than racing over whether this client still has a worker.
      stopping ??= owned.stop().finally(() => {
        if (worker === owned) worker = undefined;
        stopping = undefined;
      });

      await stopping;
    },
  };
};
