/**
 * The one loop that carries everything the merchant's process receives, over
 * HTTP long polling: the worker asks for the next batch, and the gateway holds
 * the request until something arrives or its own window closes. An empty batch
 * is the ordinary answer to a quiet window.
 *
 * An order goes to the merchant's handler, and what the handler returns is
 * posted to the order's answer route in every mode. A price question goes to
 * the price handler, and its answer to the quote route against the question's
 * `price_id`. An event is handed over and nothing is sent back.
 *
 * When a handler throws, nothing is sent and nothing is retried here: an
 * unanswered order comes back because the gateway decides on another attempt,
 * and a second retry policy on this side would disagree with it. The same
 * holds for an answer the contract refuses and for a kind with no handler; the
 * merchant is told through the problem reporter. A message this package cannot
 * read, such as an order carrying a field added after it was released, is set
 * aside unanswered with a warning naming the fields, and so is an event of a
 * kind it does not know; the rest of the batch is handled. An event is not sent again,
 * so a handler that throws on one has lost what it carried. The only retry
 * here is of a poll that failed, with the backoff in `backoff.ts`.
 */

import {
  type HandlerAnswer,
  HandlerAnswerSchema,
  type Order,
  type OrderWithStatus,
  PROTOTYPE_KEY_IS_DROPPED,
  priceProblemsOf,
  type QuoteRequest,
  type QuoteResponse,
  QuoteResponseSchema,
  type Read,
  UNKNOWN_WORD,
  type UnreadEnvelope,
  type UnreadEvent,
  type UnreadOrder,
  type WorkerEnvelope,
  type WorkerEnvelopeKind,
} from "@nuanu-ai/agentify-contracts";
import { retryDelayMs } from "./backoff.js";
import { contractVersion, speaksContract } from "./contract.js";
import type { OrderEvent } from "./reading.js";
import { describeProblems, onlyWhatIsNew, problemsOf, whereItFailed } from "./schema.js";
import { callRoute, type Gateway, REACH, type TransportFailure, whatIsKnown } from "./transport.js";

/**
 * What follows from a failed answer for the order it was about. Only an
 * answer that never left is certain to leave the order unanswered, so only
 * then is a redelivery promised; one that reached the gateway or vanished may
 * already have closed the order.
 */
const andSoTheOrder = (failure: TransportFailure): string =>
  failure.reach === REACH.NOT_RECEIVED
    ? ", so the order counts as undelivered: it is sent again while it has attempts left and its deadline allows, and otherwise ends undelivered"
    : ", so whether the order is delivered again is not something this side can say";

/**
 * What this loop calls with one paid order off the stream. `client.ts`
 * registers a function of this shape that attaches the order's calls and then
 * calls the merchant's own handler.
 */
type OrderDispatch = (order: Order) => HandlerAnswer | Promise<HandlerAnswer>;

/** The same, for "how much is this and is it there". */
type QuoteDispatch = (question: QuoteRequest) => QuoteResponse | Promise<QuoteResponse>;

/**
 * The name of one delivery of a message: its envelope's `id` and when it was
 * sent. It is no way to recognise a repeat; an order sent again comes in a
 * fresh envelope with a fresh `id`, and what holds still is the order's own
 * identifier.
 */
export interface Delivered {
  readonly id: string;
  readonly sent_at: string;
}

/**
 * What the merchant's code does with something that happened to an order.
 *
 * The second argument names this delivery of the message, for a log line or a
 * question to Agentify afterwards, since an event is answered against nothing.
 * An event is sent at most once, so the risk to write against is an event that
 * never arrives, not one that arrives twice; reading open orders with
 * `orders.list({ open: true })` finds a paid order whose `order.unfulfilled`
 * went missing, including one paid after you closed it.
 */
export type EventHandler = (event: OrderEvent, delivered: Delivered) => void | Promise<void>;

/**
 * The things the worker tells the merchant about, under names their code can
 * branch on, through the reporter registered with `on('problem')`.
 */
export const WORKER_PROBLEM_KINDS = Object.freeze({
  /** The gateway speaks another dialect of the contract. The loop stops. */
  CONTRACT_VERSION_MISMATCH: "contract_version_mismatch",
  /** A poll did not reach the gateway or did not come back as an answer. */
  POLL_FAILED: "poll_failed",
  /** The merchant's handler threw. Nothing was answered and the work returns. */
  HANDLER_FAILED: "handler_failed",
  /** The handler answered with something the contract does not accept. */
  HANDLER_ANSWER_REFUSED: "handler_answer_refused",
  /** Something arrived that nobody had registered a handler for. */
  NO_HANDLER: "no_handler",
  /**
   * Something arrived that this package could not read in full, so it was set
   * aside and nothing was guessed about it: a message on the stream, such as
   * an event of a kind or a price question for a purpose added after this
   * release, or an order carrying a field the contract version it speaks does
   * not allow, left unanswered while the rest is handled; or orders read back
   * with a status word this release does not know. The message names what it
   * could not read, without its values, and what follows for the work.
   */
  UNREAD: "unread",
  /** The answer was produced and could not be delivered to the gateway. */
  ANSWER_FAILED: "answer_failed",
  /** The gateway would not take the answer: it names an order it cannot close. */
  ANSWER_REFUSED: "answer_refused",
  /** A price answer arrived too late to price the purchase it was asked for. */
  QUOTE_ANSWER_UNUSED: "quote_answer_unused",
  /**
   * The worker stopped with work unfinished: part of a batch unread, or a
   * handler that had not answered when the stop could wait no longer.
   */
  BATCH_ABANDONED: "batch_abandoned",
  /** The loop itself failed in a way nothing here anticipated. A defect in this SDK. */
  WORKER_FAILED: "worker_failed",
  /** A delivery carried the one field name this contract removes in silence. */
  DELIVERY_FIELD_DROPPED: "delivery_field_dropped",
  /** An acceptance was given an argument, which it does not carry. The order is taken on. */
  ACCEPTANCE_ARGUMENT_IGNORED: "acceptance_argument_ignored",
} as const);

export type WorkerProblemKind = (typeof WORKER_PROBLEM_KINDS)[keyof typeof WORKER_PROBLEM_KINDS];

/** One thing the worker has to tell the merchant about. */
export interface WorkerProblem {
  readonly kind: WorkerProblemKind;
  /** What happened, in one sentence a person can act on. */
  readonly message: string;
  /** Whether the loop stopped because of it. */
  readonly fatal: boolean;
  /** The exception behind it, where there was one. */
  readonly cause?: unknown;
  /** The order or the price question it is about, where it is about one. */
  readonly subject?: string;
}

/**
 * Where the worker reports problems, registered with `on('problem')`. It is
 * called synchronously; whatever it throws or rejects with is swallowed, so a
 * failing reporter cannot stop the worker. Without one, problems go to
 * `console.error`.
 */
export type ProblemReporter = (problem: WorkerProblem) => void;

/**
 * Calls a merchant's reporter and lets nothing it does escape. A reporter that
 * throws, or that is `async` and rejects a turn later, would otherwise end the
 * loop or surface as an unhandled rejection and take the host process down;
 * there is nowhere left to report it, so it is swallowed. A merchant calling
 * `deliver` directly reports through this too.
 */
export const reportSafely = (reporter: ProblemReporter, problem: WorkerProblem): void => {
  try {
    // Anything with a `then`, not only a real Promise: another library's
    // promise, or one from another realm, fails the same way.
    const reporting = reporter(problem) as { then?: unknown } | undefined;

    if (typeof reporting?.then === "function") {
      void Promise.resolve(reporting).catch(() => {});
    }
  } catch {
    // Nowhere to say it.
  }
};

/**
 * The warning for a delivery carrying a field named `__proto__`, which is
 * removed while the delivery is parsed: the agent never receives it, and
 * without this the merchant would not know. No card can declare such a field.
 * Both roads to the gateway use it, the worker answering for a handler and a
 * merchant calling `deliver` directly.
 */
export const droppedFieldWarning = (
  orderId: string,
  delivered: Readonly<Record<string, unknown>> | undefined,
): WorkerProblem | null => {
  if (delivered === undefined || !Object.hasOwn(delivered, PROTOTYPE_KEY_IS_DROPPED)) {
    return null;
  }

  return {
    kind: WORKER_PROBLEM_KINDS.DELIVERY_FIELD_DROPPED,
    fatal: false,
    subject: orderId,
    message: `the delivery for order ${orderId} carried a field named ${PROTOTYPE_KEY_IS_DROPPED}, which is removed before anything can check it: the agent will not receive it, and no card can declare it`,
  };
};

/**
 * The warning reported when `accepted` or `accept` is given an argument.
 * TypeScript refuses one, but JavaScript code can pass it, and nothing passed
 * reaches the gateway. The order is accepted all the same, because refusing
 * would strand an order its buyer has paid for.
 */
export const acceptanceArgumentWarning = (orderId: string): WorkerProblem => ({
  kind: WORKER_PROBLEM_KINDS.ACCEPTANCE_ARGUMENT_IGNORED,
  fatal: false,
  subject: orderId,
  message: `order ${orderId} was accepted with an argument, and an acceptance carries nothing: whatever was passed was not sent (eta_seconds was removed), so call accepted() or accept() with nothing in it`,
});

/** How many orders one warning about a list names before it counts the rest. */
const ORDERS_NAMED_AT_MOST = 10;

/**
 * The warning about a list of orders read back, or null when it holds nothing
 * to warn about. It names the orders left out because this release could not
 * read them, by identifier and where each failed but never by value, so the
 * list is never shorter in silence; and it counts the orders whose status word
 * this release does not know, which read `unknown` and which a loop over open
 * orders rightly leaves alone, so that paid work waiting among them is said.
 * It decides nothing about any of them.
 */
export const listWarning = (
  listed: readonly (Read<OrderWithStatus> | UnreadOrder)[],
  open: boolean,
): WorkerProblem | null => {
  const ofThem = `of the ${listed.length} ${open ? "open " : ""}orders listed`;
  const unread = listed.filter((one): one is UnreadOrder => "issues" in one);
  const unknown = listed.filter((one) => !("issues" in one) && one.status === UNKNOWN_WORD).length;
  const said: string[] = [];

  if (unread.length > 0) {
    const them = unread.length === 1 ? "it" : "them";
    const named = unread
      .slice(0, ORDERS_NAMED_AT_MOST)
      .map(
        (one) =>
          `${one.subject === undefined ? "an order whose identifier could not be read" : `order ${one.subject}`} (${whereItFailed(one.issues)})`,
      )
      .join("; ");
    const rest =
      unread.length > ORDERS_NAMED_AT_MOST
        ? `; and ${unread.length - ORDERS_NAMED_AT_MOST} more, not named`
        : "";
    const next = unread.every((one) => onlyWhatIsNew(one.issues))
      ? `${NEWER_RELEASE} may read ${them}`
      : `nothing here says whether ${unread.length === 1 ? "it was" : "they were"} sent broken or in a shape added later`;

    said.push(
      `orders.list left out ${unread.length} ${ofThem}, because each has something contract version ${contractVersion}, which this release speaks, does not allow: ${named}${rest}. Nothing here guesses whether to deliver ${them}, orders.get throws naming the same fields, and ${next}`,
    );
  }

  if (unknown > 0) {
    const them = unknown === 1 ? "it" : "them";

    said.push(
      `${ofThem}, ${unknown} ${unknown === 1 ? "has" : "have"} a status this release does not know, read as unknown: nothing here guesses whether to deliver ${them}, paid work may be waiting among ${them}, and ${NEWER_RELEASE} reads ${them}`,
    );
  }

  return said.length === 0
    ? null
    : { kind: WORKER_PROBLEM_KINDS.UNREAD, fatal: false, message: said.join(". ") };
};

/**
 * Which registration answers each kind on the stream, by the word a merchant
 * passes to `on`. Everything that has to know the stream's kinds derives from
 * this table, and the `satisfies` clause stops the file compiling when the
 * contract gains a kind this table lacks; the `switch` in `dispatch` demands
 * the behaviour for it.
 */
export const REGISTERED_AS = Object.freeze({
  order: "order",
  quote_request: "quote",
  order_event: "event",
} as const satisfies { readonly [Kind in WorkerEnvelopeKind]: string });

/**
 * The words a merchant registers something on the stream under. Indexed by
 * the table's own keys rather than the contract's kinds, so that when the
 * contract grows a kind, the compile errors name the two places that need
 * work instead of collapsing every `on(...)` call site into implicit `any`.
 */
export type StreamHandlerKind = (typeof REGISTERED_AS)[keyof typeof REGISTERED_AS];

/** What answers each kind, in the shape this loop calls. */
interface StreamDispatch {
  order: OrderDispatch;
  quote: QuoteDispatch;
  event: EventHandler;
}

/**
 * The handlers the loop dispatches to, read when an envelope is handled rather
 * than when the loop starts, so a handler registered while the loop runs is in
 * place for the next envelope. It belongs to the client and outlives any loop.
 */
export type HandlerRegistry = {
  [Kind in StreamHandlerKind]?: StreamDispatch[Kind] | undefined;
} & {
  problem: ProblemReporter;
};

/**
 * Time, as the loop sees it: a seam so a test can check which delays were
 * asked for without waiting. Not part of the published surface.
 */
export interface WorkerClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  random(): number;
}

export const systemClock: WorkerClock = {
  // Monotonic rather than the wall clock: this clock only measures how long
  // something took, and a wall clock stepped back an hour would become an
  // hour-long sleep.
  now: () => performance.now(),
  random: () => Math.random(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = (): void => {
        clearTimeout(timer);
        resolve();
      };

      signal.addEventListener("abort", onAbort, { once: true });
    }),
};

/**
 * The shortest a quiet poll may take before the next one. Against a gateway
 * that holds polls open it costs nothing, since the window is far longer; it
 * exists so a gateway that answers at once does not get as many requests a
 * second as the network allows.
 */
export const QUIET_POLL_FLOOR_MS = 1_000;

// shortcut: four unfinished envelopes per process; revisit on measured saturation.
const HANDLERS_AT_ONCE = 4;

/**
 * The contract version named inside a body that is not a poll answer. It goes
 * into the merchant's sentence and no further: the body was held to no schema,
 * so a proxy's error page with a field of that name must not stop a worker.
 */
const versionSpokenIn = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) return undefined;

  const named = (body as { contract_version?: unknown }).contract_version;

  return typeof named === "string" && named !== "" ? named : undefined;
};

/** A newer release's name, for the sentences about what it reads that this one cannot. */
const NEWER_RELEASE = "a newer release of @nuanu-ai/agentify";

/**
 * The warning for a message this package could not read: where it failed, by
 * field and never by value, and what follows for the work it carried. Every
 * such message is outside the contract version this release speaks, since
 * anything added to an order, to a price question or to the kinds of message
 * comes with a new version; so a newer release only may read it, and where
 * what failed is a value rather than something added, not even that is said.
 */
const unreadWarning = (envelope: UnreadEnvelope): WorkerProblem => {
  // The merchant's handler is given the payload, so its fields are named from there.
  const issues = envelope.issues.map((issue) =>
    issue.path[0] === "payload" ? { ...issue, path: issue.path.slice(1) } : issue,
  );
  const where = whereItFailed(issues);
  const unreadable = `has something contract version ${contractVersion}, which this release speaks, does not allow (${where}); ${
    onlyWhatIsNew(issues)
      ? `${NEWER_RELEASE} may read it`
      : "nothing here says whether it was sent broken or in a shape added later"
  }`;
  const about = envelope.subject;

  switch (envelope.named) {
    case "order":
      return {
        kind: WORKER_PROBLEM_KINDS.UNREAD,
        fatal: false,
        ...(about === undefined ? {} : { subject: about }),
        message: `${about === undefined ? "an order" : `order ${about}`} ${unreadable}, so it was not handed to your handler and nothing was answered: it is sent again while it has attempts left and its deadline allows, and otherwise ends undelivered`,
      };
    case "quote_request":
      return {
        kind: WORKER_PROBLEM_KINDS.UNREAD,
        fatal: false,
        ...(about === undefined ? {} : { subject: about }),
        message: `${about === undefined ? "a price question" : `price question ${about}`} ${unreadable}, so it was left unanswered, which counts as a silent price check: a synchronous card sells at its own card price, and in the other modes the sale is refused`,
      };
    case "order_event":
      return {
        kind: WORKER_PROBLEM_KINDS.UNREAD,
        fatal: false,
        ...(about === undefined ? {} : { subject: about }),
        message: `${about === undefined ? "an event" : `an event for order ${about}`} ${unreadable}, so it was skipped and nothing here can ask for it again; orders.list({ open: true }) still finds every paid order waiting on you`,
      };
    default:
      return {
        kind: WORKER_PROBLEM_KINDS.UNREAD,
        fatal: false,
        message: `a message${envelope.named === "" ? "" : ` of the kind ${JSON.stringify(envelope.named)}`} ${unreadable}, so it was left unanswered`,
      };
  }
};

const askedForAKnownPurpose = (question: Read<QuoteRequest>): question is QuoteRequest =>
  question.purpose !== UNKNOWN_WORD;

/** Refuses to compile if a kind is added to the contract and not handled here. */
const assertEveryKindIsHandled = (envelope: never): never => {
  throw new TypeError(
    `the worker was handed an envelope of a kind it does not know: ${JSON.stringify(envelope)}`,
  );
};

/**
 * How long the worker asks the gateway to hold a poll open. The gateway holds
 * it for its own window at most, so a shorter answer is ordinary.
 */
export const POLL_WAIT_SECONDS = 25;

/**
 * How long the worker waits for a poll before giving up on it: twice the
 * window asked for, so a gateway that answers late is never cut off, while a
 * connection dropped silently by something in the middle costs one window
 * rather than the runtime's default of minutes.
 *
 * Two copies elsewhere must move with it. `WORKER_POLL_WAIT_CEILING_MS` in
 * `apps/gateway/src/config.ts` is set under this number, and nothing checks
 * that it still is. `DOUBT_MS` in packages/slice/src/subscription.ts is this
 * plus the backoff ceiling, since a gateway that accepts and never answers
 * fails a poll only when this runs out; raise this alone and a healthcheck
 * reads the quiet between two failures as a recovery.
 */
export const POLL_DEADLINE_MS = POLL_WAIT_SECONDS * 2 * 1_000;

/** What `startWorker` hands its caller, which is the client and never a merchant. */
export interface RunningWorker {
  /**
   * Stops the loop and waits for it to finish. Safe to call twice. A parked
   * poll is dropped, and so is an answer already on its way, which the
   * merchant is told about by order; the queue is not drained.
   */
  stop(): Promise<void>;
  /** Whether the loop is still going. False once it has stopped for any reason. */
  running(): boolean;
}

export const startWorker = (
  gateway: Gateway,
  handlers: HandlerRegistry,
  clock: WorkerClock = systemClock,
  /** A parameter so a test can see the deadline work without waiting it out. */
  deadlineMs: number = POLL_DEADLINE_MS,
): RunningWorker => {
  const controller = new AbortController();
  let stopping = false;
  let ended = false;
  const active = new Set<Promise<void>>();
  const orders = new Set<string>();
  const tails = new Map<string, Promise<void>>();
  let wakeRoom: (() => void) | undefined;
  controller.signal.addEventListener("abort", () => wakeRoom?.(), { once: true });

  const report = (problem: WorkerProblem): void => reportSafely(handlers.problem, problem);

  const rest = async (ms: number): Promise<void> => {
    if (ms > 0) await clock.sleep(ms, controller.signal);
  };

  const reportTheMismatch = (spoken: string): void => {
    report({
      kind: WORKER_PROBLEM_KINDS.CONTRACT_VERSION_MISMATCH,
      fatal: true,
      // Both versions are in the sentence, so the merchant can tell which end
      // needs upgrading.
      message: `the gateway speaks contract version ${spoken} and this SDK speaks ${contractVersion}; the worker takes no more work, finishes what it already holds and stops, rather than handle orders in a dialect it may be reading wrong`,
    });
  };

  const answerOrder = async (order: Order, answer: HandlerAnswer): Promise<void> => {
    const sent = await callRoute(gateway, "answer_order", {
      path: { order_id: order.id },
      body: answer,
      signal: controller.signal,
    });

    if (!sent.ok) {
      // Reported even while stopping: the handler has run, goods may have been
      // issued, and the merchant needs to know this answer went nowhere.
      report({
        kind: WORKER_PROBLEM_KINDS.ANSWER_FAILED,
        fatal: false,
        subject: order.id,
        message: `the answer for order ${order.id} was produced and ${whatIsKnown(sent.failure)}${andSoTheOrder(sent.failure)}: ${sent.failure.reason}`,
      });
      return;
    }

    if (!sent.document.ok) {
      report({
        kind: WORKER_PROBLEM_KINDS.ANSWER_REFUSED,
        fatal: false,
        subject: order.id,
        message: `the answer for order ${order.id} was not accepted (${sent.document.error.code}): ${sent.document.error.message}`,
      });
    }
  };

  /** See `droppedFieldWarning`. */
  const warnAboutTheDroppedKey = (order: Order, answer: HandlerAnswer): void => {
    const dropped = droppedFieldWarning(
      order.id,
      "delivered" in answer ? answer.delivered : undefined,
    );

    if (dropped !== null) report(dropped);
  };

  const handleOrder = async (order: Order): Promise<void> => {
    const handler = handlers.order;

    if (handler === undefined) {
      report({
        kind: WORKER_PROBLEM_KINDS.NO_HANDLER,
        fatal: false,
        subject: order.id,
        message: `order ${order.id} arrived and no handler was registered with on('${REGISTERED_AS.order}'), so it was left unanswered: it is sent again while it has attempts left and its deadline allows, and otherwise ends undelivered`,
      });
      return;
    }

    let answer: HandlerAnswer;

    try {
      answer = await handler(order);
    } catch (cause) {
      report({
        kind: WORKER_PROBLEM_KINDS.HANDLER_FAILED,
        fatal: false,
        cause,
        subject: order.id,
        message: `the handler threw on order ${order.id}, so nothing was answered and the order counts as undelivered — it is sent again while it has attempts left and its deadline allows, and otherwise ends undelivered: ${String(cause)}`,
      });
      return;
    }

    const checked = HandlerAnswerSchema.safeParse(answer);

    if (!checked.success) {
      report({
        kind: WORKER_PROBLEM_KINDS.HANDLER_ANSWER_REFUSED,
        fatal: false,
        subject: order.id,
        message: `the handler's answer for order ${order.id} is not one the contract carries, so nothing was sent and the order counts as undelivered — it is sent again while it has attempts left and its deadline allows, and otherwise ends undelivered:\n${describeProblems(problemsOf(checked.error.issues))}`,
      });
      return;
    }

    warnAboutTheDroppedKey(order, answer);

    await answerOrder(order, checked.data);
  };

  const handleQuote = async (question: QuoteRequest): Promise<void> => {
    const handler = handlers.quote;

    if (handler === undefined) {
      report({
        kind: WORKER_PROBLEM_KINDS.NO_HANDLER,
        fatal: false,
        subject: question.price_id,
        message: `a price question for ${question.merchant_item_id} arrived and no handler was registered with on('${REGISTERED_AS.quote_request}'), so it was left unanswered`,
      });
      return;
    }

    let answer: QuoteResponse;

    try {
      answer = await handler(question);
    } catch (cause) {
      report({
        kind: WORKER_PROBLEM_KINDS.HANDLER_FAILED,
        fatal: false,
        cause,
        subject: question.price_id,
        message: `the price handler threw on question ${question.price_id}, so no price was sent and the sale goes on the card's own price or does not go on at all: ${String(cause)}`,
      });
      return;
    }

    // Held to the contract before it is sent, so that the easiest mistake, an
    // amount written as a number, is named as the merchant's own field rather
    // than coming back as the gateway's complaint.
    const checked = QuoteResponseSchema.safeParse(answer);
    // The gateway holds the price to the rule a card's price meets; applied
    // here too, a zero or a missing cent names the merchant's own field.
    const problems = checked.success
      ? checked.data.available
        ? priceProblemsOf(checked.data.price)
        : []
      : problemsOf(checked.error.issues);

    if (!checked.success || problems.length > 0) {
      report({
        kind: WORKER_PROBLEM_KINDS.HANDLER_ANSWER_REFUSED,
        fatal: false,
        subject: question.price_id,
        message: `the price handler's answer for question ${question.price_id} is not one the contract carries, so no price was sent:\n${describeProblems(problems)}`,
      });
      return;
    }

    const sent = await callRoute(gateway, "answer_quote", {
      path: { price_id: question.price_id },
      body: checked.data,
      signal: controller.signal,
    });

    if (!sent.ok) {
      report({
        kind: WORKER_PROBLEM_KINDS.ANSWER_FAILED,
        fatal: false,
        subject: question.price_id,
        // The advice about stock is the same whichever reach this was: a price
        // that was used produces an order before the question expires, so
        // stock is released only once it has expired.
        message: `the price for question ${question.price_id} was answered and ${whatIsKnown(sent.failure)}; stock set aside under that identifier can be released once the question expires, whichever of those it was: ${sent.failure.reason}`,
      });
      return;
    }

    if (!sent.document.used) {
      report({
        kind: WORKER_PROBLEM_KINDS.QUOTE_ANSWER_UNUSED,
        fatal: false,
        subject: question.price_id,
        message: `the price for question ${question.price_id} arrived too late to be used, or the question is no longer held; stock set aside under that identifier can be released`,
      });
    }
  };

  const handleEvent = async (
    event: OrderEvent | UnreadEvent,
    delivered: Delivered,
  ): Promise<void> => {
    if (event.type === UNKNOWN_WORD) {
      report({
        kind: WORKER_PROBLEM_KINDS.UNREAD,
        fatal: false,
        ...(event.order_id === undefined ? {} : { subject: event.order_id }),
        message: `an event of a kind this release does not know, "${event.named}", arrived and was skipped; ${NEWER_RELEASE} reads it, and orders.list({ open: true }) still finds every paid order waiting on you`,
      });
      return;
    }

    const handler = handlers.event;

    if (handler === undefined) {
      report({
        kind: WORKER_PROBLEM_KINDS.NO_HANDLER,
        fatal: false,
        subject: event.order_id,
        message: `${event.type} arrived for order ${event.order_id} and nothing is listening for events; register one with on('${REGISTERED_AS.order_event}') to receive them`,
      });
      return;
    }

    try {
      await handler(event, delivered);
    } catch (cause) {
      report({
        kind: WORKER_PROBLEM_KINDS.HANDLER_FAILED,
        fatal: false,
        cause,
        subject: event.order_id,
        // An event is sent at most once and carries no acknowledgement, so
        // nothing here can ask for it again: what the handler failed on is
        // lost, and the open-orders list is where an unfulfilled order shows up.
        message: `the event handler threw on ${event.type} for order ${event.order_id}; nothing here can ask for that event again, and whether it is sent again is not something this SDK knows: ${String(cause)}`,
      });
    }
  };

  const dispatch = async (envelope: Read<WorkerEnvelope>): Promise<void> => {
    switch (envelope.kind) {
      case "order":
        await handleOrder(envelope.payload);
        return;
      case "quote_request":
        if (askedForAKnownPurpose(envelope.payload)) {
          await handleQuote(envelope.payload);
        } else {
          report({
            kind: WORKER_PROBLEM_KINDS.UNREAD,
            fatal: false,
            subject: envelope.payload.price_id,
            message: `a price question for ${envelope.payload.merchant_item_id} came for a purpose this package does not know and was left unanswered, which counts as a silent price check: a synchronous card sells at its own card price, and in the other modes the sale is refused; ${NEWER_RELEASE} answers it`,
          });
        }
        return;
      case "order_event":
        await handleEvent(envelope.payload, { id: envelope.id, sent_at: envelope.sent_at });
        return;
      case UNKNOWN_WORD:
        report(unreadWarning(envelope));
        return;
      default:
        // Unreachable while the contract carries three kinds; a fourth stops
        // this file compiling instead of being dropped in silence.
        return assertEveryKindIsHandled(envelope);
    }
  };

  const fail = (cause: unknown): void => {
    if (stopping) return;
    stopping = true;
    controller.abort();
    report({
      kind: WORKER_PROBLEM_KINDS.WORKER_FAILED,
      fatal: true,
      cause,
      message: `the worker stopped on an error it did not expect, which is a defect in the Agentify SDK rather than something the gateway did: ${String(cause)}`,
    });
  };

  const room = async (): Promise<void> => {
    while (!stopping && active.size >= HANDLERS_AT_ONCE) {
      await new Promise<void>((resolve) => {
        wakeRoom = resolve;
      });
      wakeRoom = undefined;
    }
  };

  const schedule = (envelope: Read<WorkerEnvelope>): void => {
    const orderId =
      envelope.kind === "order"
        ? envelope.payload.id
        : envelope.kind === "order_event" && envelope.payload.type !== UNKNOWN_WORD
          ? envelope.payload.order_id
          : undefined;
    if (envelope.kind === "order" && orders.has(envelope.payload.id)) return;
    if (envelope.kind === "order") orders.add(envelope.payload.id);
    const predecessor = orderId === undefined ? undefined : tails.get(orderId);
    // Same-order events follow fulfillment; unrelated work need not wait for it.
    const work = Promise.resolve(predecessor)
      .then(() => dispatch(envelope))
      .catch(fail)
      .finally(() => {
        active.delete(work);
        wakeRoom?.();
        if (envelope.kind === "order") orders.delete(envelope.payload.id);
        if (orderId !== undefined && tails.get(orderId) === work) tails.delete(orderId);
      });
    active.add(work);
    if (orderId !== undefined) tails.set(orderId, work);
  };

  /** Whether the stop still waits for what is in the handlers. */
  let waitsForHandlers = true;

  /**
   * What is already in a handler may have issued goods, so its answer goes out
   * before the stop, which would otherwise abort it; but a handler that never
   * returns must not hold the stop for ever, so the wait is as long as a poll
   * may take and no longer.
   */
  const drainOrAbandon = async (): Promise<void> => {
    const waited = new AbortController();
    const drained = await Promise.race([
      Promise.all(active).then(() => true),
      clock.sleep(deadlineMs, waited.signal).then(() => false),
    ]);
    waited.abort();
    if (drained) return;

    waitsForHandlers = false;
    const unanswered = [...orders];
    report({
      kind: WORKER_PROBLEM_KINDS.BATCH_ABANDONED,
      fatal: false,
      message: `the worker stopped with ${active.size} messages still in a handler after ${deadlineMs} ms${unanswered.length === 0 ? "" : `, among them orders ${unanswered.join(", ")}`}; nothing was sent for them, so each order is sent again while it has attempts left and its deadline allows, and otherwise ends undelivered`,
    });
  };

  const run = async (): Promise<void> => {
    // One turn before the first poll, so that a process which calls start()
    // without awaiting it and registers on the next line is ready first.
    await Promise.resolve();

    let failures = 0;

    while (!stopping) {
      await room();
      if (stopping) break;
      const startedAt = clock.now();
      const answer = await callRoute(gateway, "poll_worker", {
        body: { wait_seconds: POLL_WAIT_SECONDS },
        // Ends early when the worker is stopped or the answer takes longer
        // than any answer should.
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(deadlineMs)]),
      });

      if (stopping) break;

      if (!answer.ok) {
        // The version a failed body names is passed on as a remark, never as a
        // verdict: that body was held to no schema, and only an answer of the
        // poll's outer shape decides a mismatch. That shape is read whatever
        // the messages inside it are, so the version decides before they do.
        const spoken = versionSpokenIn(answer.failure.body);
        const remark =
          spoken !== undefined && !speaksContract(spoken)
            ? ` — what answered names contract version ${spoken} while this SDK speaks ${contractVersion}, which may mean the gateway is of another version`
            : "";

        // A refusal that says waiting will not help, such as a revoked key, is
        // still not taken as the end, since one such answer may come from a
        // proxy; but it is said for what it is.
        const settled = answer.failure.refusal?.retryable === false;
        failures += 1;
        report({
          kind: WORKER_PROBLEM_KINDS.POLL_FAILED,
          fatal: false,
          message: settled
            ? `${answer.failure.reason}${remark} — the gateway says asking again will not change this, and no new orders arrive until what it names is fixed; asking again after a wait in case it was not the gateway that answered`
            : `${answer.failure.reason}${remark} — asking again after a wait`,
        });
        await rest(retryDelayMs(failures, clock.random()));
        continue;
      }

      failures = 0;

      if (!speaksContract(answer.document.contract_version)) {
        reportTheMismatch(answer.document.contract_version);
        stopping = true;
        await drainOrAbandon();
        return;
      }

      const batch = answer.document.envelopes;
      let handled = 0;

      for (const envelope of batch) {
        await room();
        if (stopping) break;
        schedule(envelope);
        handled += 1;
      }

      if (handled < batch.length) {
        // An order may be retried; a price question expires and an event is lost.
        report({
          kind: WORKER_PROBLEM_KINDS.BATCH_ABANDONED,
          fatal: false,
          message: `the worker stopped with ${batch.length - handled} of this batch's ${batch.length} messages unread (${batch
            .slice(handled)
            .map((envelope) => envelope.kind)
            .join(
              ", ",
            )}); unanswered orders may be sent again within their attempts and deadline, price questions expire, and nothing here can ask for an event again`,
        });
      }

      if (batch.length === 0) {
        await rest(QUIET_POLL_FLOOR_MS - (clock.now() - startedAt));
      }
    }
  };

  const finished = run()
    .catch(fail)
    .finally(async () => {
      stopping = true;
      controller.abort();
      if (waitsForHandlers) await Promise.all(active);
      ended = true;
    });

  return {
    running: () => !ended,
    stop: async () => {
      stopping = true;
      controller.abort();
      await finished;
    },
  };
};
