/**
 * The merchant half of the stand, on the SDK a merchant actually uses.
 *
 * In memory it keeps only the answer the handler is set to give, the orders it
 * has taken on for a later delivery, the ones it is holding while it waits for
 * a person to choose their answer, and the ones paused, their path already
 * decided, until somebody releases them. Given a records directory, it keeps
 * there what a merchant's own code has to keep: every arrival counted, and one
 * record per order of the answer it got, written before that answer is sent
 * and sent again to every repeat. The feed records what crossed this boundary; it neither replaces the
 * gateway's journal nor teaches the merchant key to any observer.
 *
 * Everything a merchant's code can do here goes through the SDK, and that is
 * the point of the file rather than a convenience: an outside engineer reading
 * it must not learn to assemble by hand what the package already carries. So
 * the orders on screen are `client.orders.list`, the calls that close them are
 * the ones on the rows it returns, and the only calls in this console made with
 * raw HTTP are the ones the SDK deliberately does not have.
 */

import {
  type AgentifyClient,
  type CardInput,
  createClient,
  type Delivery,
  type HandlerAnswer,
  type LiveOrder,
  type LiveOrderWithStatus,
  type Money,
  type OrderCallResponse,
  type PublishResult,
  type Refusal,
} from "@nuanu-ai/agentify";
import type { ParamSpec } from "@nuanu-ai/agentify-contracts";
import { filledFrom } from "./stand-goods.js";
import type { Feed } from "./stand-log.js";
import type { Recorded, StandRecords } from "./stand-records.js";

export type OrderMood =
  | "deliver"
  | "accept_then_deliver"
  | "accept_and_say_nothing"
  | "refuse"
  | "say_nothing"
  | "answer_wrong_shape"
  | "ask_me";

type DecidedMood = Exclude<OrderMood, "ask_me">;

export type QuoteMood = "price" | "unavailable" | "say_nothing";

/** What a person can answer with while the handler holds an order open. */
export type HeldAnswer = "deliver" | "accept" | "refuse" | "say_nothing";

interface Moods {
  order: OrderMood;
  quote: QuoteMood;
  deliverAfterMs: number;
  refusal: Refusal;
  price: Money;
  delivery: Delivery | null;
}

/** An order the handler is holding while it waits for somebody to answer. */
export interface HeldOrder {
  readonly id: string;
  readonly merchantItemId: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly since: number;
}

/**
 * Where the stand stops every order whose path is already decided, until
 * somebody releases it: as it arrives, before anything is done with it, or
 * with its answer ready — decided and, with records kept, recorded — before
 * that answer goes back.
 */
export type PausePoint = "none" | "arrival" | "answer_ready";

/** An order stopped at a pause point, waiting to be released. */
export interface PausedOrder {
  readonly id: string;
  readonly merchantItemId: string;
  readonly phase: Exclude<PausePoint, "none">;
  readonly since: number;
}

export interface StandMerchant {
  readonly moods: Moods;
  connected(): string | null;
  /**
   * Why the subscription ended, where it has.
   *
   * A fatal problem stops the loop. A console that went on saying "connected"
   * after one would be claiming a subscription it no longer has.
   */
  stopped(): string | null;
  connect(baseUrl: string, apiKey: string): Promise<void>;
  disconnect(): Promise<void>;
  publish(card: CardInput): Promise<PublishResult>;
  learn(merchantItemId: string, result: ParamSpec): void;
  /**
   * This merchant's orders, and with `open` only those still owed something.
   *
   * Through `client.orders.list`, which is what the SDK offers for exactly
   * this: the rows come back carrying the calls that close them, and the open
   * ones are what a process reads after a restart. What this process happens to
   * be holding in memory is not that list and does not survive a reconnection.
   */
  orders(open?: boolean): Promise<readonly LiveOrderWithStatus[]>;
  /** Orders the handler is holding open until a person answers. */
  readonly held: ReadonlyMap<string, HeldOrder>;
  /** Answers one held order. False when it is no longer being held. */
  answerHeld(orderId: string, answer: HeldAnswer): boolean;
  /**
   * Where every order arriving from now on is paused, repeats included. Each
   * arrival is paused at most once, at the point set when it arrived, so
   * changing this neither releases nor pauses again an arrival in progress.
   */
  readonly pause: { at: PausePoint };
  /** Orders paused at this stand, waiting to be released. */
  readonly paused: ReadonlyMap<string, PausedOrder>;
  /** Lets one paused order go on. False when that order is not paused here. */
  releasePaused(orderId: string): boolean;
  /** Delivers an order taken on earlier, named by its own identifier. */
  deliverOwed(orderId: string, merchantItemId: string): Promise<void>;
  /** Refuses an order taken on earlier, named by its own identifier. */
  refuseOwed(orderId: string): Promise<void>;
}

/**
 * How long the silent moods stay silent, and why it is this long.
 *
 * The deadline this mood has to outlast is the order's own: a synchronous
 * purchase is answered within `SYNC_RESPONSE_MS`, ten seconds counted from the
 * payment. `HANDLER_ANSWER_MS` is a different number and it is the one that is
 * easy to mistake for this: three seconds is how long the gateway waits for one
 * delivery attempt before calling that attempt unanswered and sending the order
 * round again, so an answer arriving in the fifth second is late for the
 * attempt and still well inside the order's deadline — the goods go out and the
 * purchase settles. Waiting anything short of ten seconds therefore delivers
 * and calls it a timeout, which is the one thing this mood must not do.
 *
 * The worker dispatches handlers serially, so every second spent here blocks
 * every other order and quote. This is the shortest wait that is honestly past
 * the deadline, and no longer.
 */
const SILENCE_PAST_DEADLINES_MS = 11_500;

/**
 * How long the handler will hold an order open for a person.
 *
 * Short, and the reason is worth knowing before anybody designs around this.
 * Three clocks run at once: the gateway waits about three seconds for one
 * delivery attempt (`HANDLER_ANSWER_MS`) before calling it unanswered and
 * sending the order round again, the goods themselves are due within ten
 * seconds of the payment (`SYNC_RESPONSE_MS`), and the agent is promised an
 * answer within twenty (`SYNC_BUDGET_MS`). Holding an order for a person
 * therefore runs past what the order can survive almost at once — the gateway
 * stops waiting and the order expires while this side is still holding it.
 * That is worth watching once, which is why holding exists at all; it is not
 * worth waiting two minutes for, and a held order blocks the worker's serial
 * dispatch the whole time.
 *
 * The ceiling refuses rather than falling silent, because a refusal names
 * itself in the order's own record and a silence looks like a crash.
 */
const ASK_CEILING_MS = 30_000;

/** What the ceiling refuses with, so the record says why rather than what. */
const NOBODY_ANSWERED: Refusal = {
  code: "nobody_answered",
  message:
    "The stand held this order at the console and nobody answered it. The gateway had stopped waiting long before.",
};

/** Nobody answered in time, which is neither of the four answers a person gives. */
const RAN_OUT = "ran_out" as const;

const defaultMoods = (): Moods => ({
  order: "deliver",
  quote: "price",
  deliverAfterMs: 1_000,
  refusal: { code: "cannot_fulfill", message: "The stand was told not to fulfill this order." },
  price: { amount: "1.00", currency: "USD" },
  delivery: null,
});

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const HELD_MEANS: Readonly<Record<HeldAnswer, DecidedMood>> = {
  deliver: "deliver",
  accept: "accept_then_deliver",
  refuse: "refuse",
  say_nothing: "say_nothing",
};

interface DeliverySession {
  cancelling: boolean;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
  readonly inFlight: Set<Promise<void>>;
}

const makeDeliverySession = (): DeliverySession => ({
  cancelling: false,
  timers: new Set(),
  inFlight: new Set(),
});

/** What the handler settled on for one order, before any of it goes back. */
interface Decision {
  readonly answer: HandlerAnswer;
  /** The feed's line for the moment this answer goes back to the gateway. */
  readonly said: string;
  readonly detail: Record<string, unknown>;
  /** Whether the goods are promised for later, from a timer on this side. */
  readonly deliversLater: boolean;
}

interface StandMerchantOptions {
  /**
   * Called when an order stops being owed anything without the page having
   * asked for it — a delivery this side had promised and then made from a
   * timer, and any event the gateway sends about an order. Those are the
   * moments nobody pressed anything for, so they are the moments a console
   * drawn from a press goes stale on. The calls the page makes itself need no
   * telling: whoever pressed the button reads the orders back after it.
   */
  readonly closedOnItsOwn?: () => void;
  /** Where this merchant keeps its arrivals and its one effect per order, if anywhere. */
  readonly records?: StandRecords;
}

/** Makes a merchant whose handler decisions are changed directly by the stand page. */
export const makeStandMerchant = (
  feed: Feed,
  { closedOnItsOwn = () => {}, records }: StandMerchantOptions = {},
): StandMerchant => {
  const moods = defaultMoods();
  const taken = new Map<string, LiveOrder>();
  const held = new Map<string, HeldOrder>();
  const answering = new Map<
    string,
    { answer: (chosen: HeldAnswer) => void; abandon: (why: Error) => void }
  >();
  const pause: { at: PausePoint } = { at: "none" };
  const paused = new Map<string, PausedOrder>();
  const unpausing = new Map<string, { release: () => void; abandon: (why: Error) => void }>();
  const results = new Map<string, ParamSpec>();
  let deliverySession = makeDeliverySession();
  let client: AgentifyClient | undefined;
  let address: string | null = null;
  let stoppedBecause: string | null = null;
  // Set for as long as a disconnect is under way. A handler that reaches a
  // pause or a hold then gives up at once, because the disconnect is waiting
  // for every handler in flight to finish and nobody would release it.
  let disconnecting = false;

  const connectedClient = (): AgentifyClient => {
    if (client === undefined) {
      throw new Error("Connect the stand merchant before asking it for anything.");
    }
    return client;
  };

  /**
   * The calls that close one order, named by its identifier.
   *
   * `orders.forId` reaches no gateway — the SDK offers it for the process that
   * kept an identifier and nothing else, which is exactly what a console
   * pressing a button on a row has. The order object a handler was given works
   * too, and stops existing the moment this process reconnects.
   */
  const calls = (orderId: string) => connectedClient().orders.forId(orderId);

  /**
   * What this handler hands over for one product.
   *
   * The goods are made from the card's own `result` declaration, which this
   * console learns when it reads the merchant's cards. A card published
   * somewhere else after that — from the dashboard, from another process — is one
   * it has never read, and the fields it would fill are none. That case says so
   * rather than delivering an empty object into a refusal nobody can explain:
   * it is a gap in this console, not in the SDK, and it is one press of "Read
   * again" on the catalogue away.
   */
  const deliveryFor = (merchantItemId: string): Delivery => {
    if (moods.delivery !== null) return moods.delivery;
    const declared = results.get(merchantItemId);
    if (declared === undefined) {
      feed.write(
        "stand",
        `This console has not read the card ${merchantItemId} declares, so it has nothing to deliver for it. Read the catalogue again, or paste the goods yourself.`,
      );
    }
    return filledFrom(declared);
  };

  /** Every answer the handler gives is something this side put on the wire. */
  const writeOrderAnswer = (
    title: string,
    order: LiveOrder,
    detail: Record<string, unknown>,
  ): void => {
    feed.sent("merchant", title, {
      order_id: order.id,
      merchant_item_id: order.merchant_item_id,
      ...detail,
    });
  };

  /**
   * How a delivery or a refusal answered, in the fields the log reads.
   *
   * A call the gateway would not take is named under `error` as well as carried
   * whole, for the reason the worker's problems are: the log colours a line off
   * that field, and without it the one refused delivery sits in the stream
   * looking like every other line. The finding leads where the refusal carries
   * any — the code is the word a merchant's own program branches on, and the
   * finding is the thing their handler has to change.
   */
  const answerRead = (result: OrderCallResponse): Record<string, unknown> => {
    if (result.ok) return { result };
    const first = result.error.problems?.[0];
    const said =
      first === undefined || first.path.length === 0
        ? (first?.message ?? result.error.message)
        : `${first.path.join(".")}: ${first.message}`;
    return { error: `${result.error.code} — ${said}`, result };
  };

  /**
   * Hands over the goods for an order taken on earlier, and says how it went.
   *
   * No try/catch, and that is deliberate. The SDK's transport says in its own
   * header that nothing there throws: a call that did not get through comes
   * back as an answer saying so. A catch around it would teach a reader of this
   * file — which is meant to read like a merchant's own code — to write a
   * handler for an exception that never arrives, and no branch on the answer
   * that always does.
   */
  const handOver = async (orderId: string, merchantItemId: string): Promise<void> => {
    const delivery = deliveryFor(merchantItemId);
    feed.sent("merchant", "The handler delivered the goods it had promised.", {
      order_id: orderId,
      merchant_item_id: merchantItemId,
      delivery,
    });
    const result = await calls(orderId).deliver(delivery);
    feed.got(
      "merchant",
      result.ok ? "The gateway took that delivery." : "The gateway would not take that delivery.",
      { order_id: orderId, ...answerRead(result) },
    );
  };

  const deliverLater = (order: LiveOrder): void => {
    const session = deliverySession;
    const timer = setTimeout(() => {
      session.timers.delete(timer);
      if (session.cancelling || taken.get(order.id) !== order) {
        return;
      }
      const inFlight = handOver(order.id, order.merchant_item_id);
      session.inFlight.add(inFlight);
      void inFlight.then(() => {
        session.inFlight.delete(inFlight);
        // The gateway has answered the delivery by now, so what it says about
        // this order has already changed under whoever is watching.
        closedOnItsOwn();
      });
    }, moods.deliverAfterMs);
    session.timers.add(timer);
  };

  const stopDeliveries = async (): Promise<void> => {
    const session = deliverySession;
    session.cancelling = true;
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
    if (session.inFlight.size > 0) {
      feed.write("stand", "Waiting for a delivery already in flight before stopping the SDK.", {
        deliveries: session.inFlight.size,
      });
    }
    await Promise.all([...session.inFlight]);
  };

  /** Why a waiting handler gives up: it throws this, so the SDK answers nothing for it. */
  const abandonment = (orderId: string, what: string): Error =>
    new Error(`Order ${orderId} ${what}, so its handler answers nothing.`);

  /**
   * Holds one order open until a person answers or the ceiling runs out. A
   * disconnect gives up on it instead: nobody answered because the stand went
   * away, which is not the merchant refusing, so nothing is answered or recorded.
   */
  const askAbout = async (order: LiveOrder): Promise<HeldAnswer | typeof RAN_OUT> => {
    if (disconnecting) throw abandonment(order.id, "arrived while the stand was disconnecting");
    held.set(order.id, {
      id: order.id,
      merchantItemId: order.merchant_item_id,
      params: order.params,
      since: Date.now(),
    });
    feed.write("merchant", "An order is being held at the console, waiting for you to answer it.", {
      order_id: order.id,
      merchant_item_id: order.merchant_item_id,
      params: order.params,
    });

    try {
      return await new Promise<HeldAnswer | typeof RAN_OUT>((resolve, reject) => {
        const ceiling = setTimeout(() => resolve(RAN_OUT), ASK_CEILING_MS);
        answering.set(order.id, {
          answer: (chosen) => {
            clearTimeout(ceiling);
            resolve(chosen);
          },
          abandon: (why) => {
            clearTimeout(ceiling);
            reject(why);
          },
        });
      });
    } finally {
      held.delete(order.id);
      answering.delete(order.id);
    }
  };

  /**
   * Stops one order at `phase` when `pauseAt`, the point set as it arrived,
   * is that phase, until it is released or the stand disconnects. There is no
   * ceiling: the worker dispatches serially, so everything else this process
   * would be handed waits behind a paused order, and that is the point of
   * pausing it.
   */
  const pausedIfAsked = async (
    order: LiveOrder,
    pauseAt: PausePoint,
    phase: PausedOrder["phase"],
    answer?: HandlerAnswer,
  ): Promise<void> => {
    if (pauseAt !== phase) return;
    if (disconnecting) throw abandonment(order.id, "arrived while the stand was disconnecting");
    paused.set(order.id, {
      id: order.id,
      merchantItemId: order.merchant_item_id,
      phase,
      since: Date.now(),
    });
    feed.write(
      "merchant",
      phase === "arrival"
        ? "The stand paused this order as it arrived, before doing anything with it. It waits until you release it."
        : `The stand paused this order with its answer ${records === undefined ? "ready" : "recorded"} and not yet sent. It waits until you release it.`,
      {
        order_id: order.id,
        merchant_item_id: order.merchant_item_id,
        phase,
        ...(answer === undefined ? {} : { answer }),
      },
    );
    try {
      await new Promise<void>((release, abandon) => {
        unpausing.set(order.id, { release, abandon });
      });
    } finally {
      paused.delete(order.id);
      unpausing.delete(order.id);
    }
  };

  /** Gives up on every paused order, so a disconnect never waits on a release. */
  const abandonPaused = (): void => {
    for (const [orderId, { abandon }] of [...unpausing]) {
      feed.write(
        "merchant",
        "The stand is disconnecting while this order is paused, so the handler gives up on it and answers nothing.",
        { order_id: orderId, phase: paused.get(orderId)?.phase },
      );
      abandon(abandonment(orderId, "was paused when the stand disconnected"));
    }
  };

  /** Every handler answer but the one that asks a person first. */
  const decide = async (order: LiveOrder, mood: DecidedMood): Promise<Decision> => {
    switch (mood) {
      case "deliver": {
        const delivery = deliveryFor(order.merchant_item_id);
        return {
          answer: order.delivered(delivery),
          said: "The handler delivered the goods.",
          detail: { delivery },
          deliversLater: false,
        };
      }
      case "accept_then_deliver": {
        const answer = order.accepted();
        return {
          answer,
          said: "The handler accepted the order and promised the goods later.",
          detail: { answer },
          deliversLater: true,
        };
      }
      case "accept_and_say_nothing": {
        const answer = order.accepted();
        return {
          answer,
          said: "The handler accepted the order and will never deliver it.",
          detail: { answer },
          deliversLater: false,
        };
      }
      case "refuse":
        return {
          answer: order.refused(moods.refusal),
          said: "The handler refused the order.",
          detail: { refusal: moods.refusal },
          deliversLater: false,
        };
      case "say_nothing": {
        await wait(SILENCE_PAST_DEADLINES_MS);
        const delivery = deliveryFor(order.merchant_item_id);
        return {
          answer: order.delivered(delivery),
          said: "The handler delivered, long past the deadline the card promised.",
          detail: { delivery },
          deliversLater: false,
        };
      }
      case "answer_wrong_shape": {
        const delivery = { a_field_this_card_never_declared: "wrong-shape" };
        return {
          answer: order.delivered(delivery),
          said: "The handler delivered a shape the card never declared.",
          detail: { delivery },
          deliversLater: false,
        };
      }
    }
  };

  /** What the handler's mood makes of one order, asking a person first where it is set to. */
  const decided = async (order: LiveOrder): Promise<Decision> => {
    if (moods.order !== "ask_me") {
      return decide(order, moods.order);
    }
    const answered = await askAbout(order);
    if (answered === RAN_OUT) {
      return {
        answer: order.refused(NOBODY_ANSWERED),
        said: "Nobody at the console answered, so the handler refused.",
        detail: { refusal: NOBODY_ANSWERED },
        deliversLater: false,
      };
    }
    return decide(order, HELD_MEANS[answered]);
  };

  /** An answer this order already has, which goes back as it is and promises nothing more. */
  const fromRecord = (recorded: Recorded, said: string): Decision => ({
    answer: recorded.answer,
    said,
    detail: { answer: recorded.answer, recorded_by: { port: recorded.port, pid: recorded.pid } },
    deliversLater: false,
  });

  /**
   * What goes back for one order: with records kept, the effect it already
   * has, or the one decided now and recorded before anything is sent.
   */
  const answerFor = async (order: LiveOrder): Promise<Decision> => {
    if (records === undefined) return decided(order);
    const earlier = await records.find(order.id);
    if (earlier !== null) {
      return fromRecord(earlier, "The handler answered a repeat with the answer it recorded.");
    }
    const decision = await decided(order);
    const kept = await records.keep(order, decision.answer);
    if (kept.first) {
      feed.write("merchant", "The handler recorded its answer before sending it.", {
        order_id: order.id,
        merchant_item_id: order.merchant_item_id,
        records: records.directory,
      });
      return decision;
    }
    feed.write(
      "merchant",
      "Another stand recorded this order first, so this one sends that stand's answer instead of its own.",
      {
        order_id: order.id,
        decided: decision.answer,
        recorded_by: { port: kept.recorded.port, pid: kept.recorded.pid },
      },
    );
    return fromRecord(
      kept.recorded,
      "The handler answered with the answer another stand recorded.",
    );
  };

  const register = (fresh: AgentifyClient): void => {
    fresh.on("order", async (order) => {
      feed.got("merchant", "The SDK handed the handler an order.", {
        order_id: order.id,
        merchant_item_id: order.merchant_item_id,
        params: order.params,
      });
      const pauseAt = pause.at;
      await records?.arrived(order);
      await pausedIfAsked(order, pauseAt, "arrival");
      const decision = await answerFor(order);
      await pausedIfAsked(order, pauseAt, "answer_ready", decision.answer);
      // Only now, with the answer about to go back: a delivery promised from a
      // timer started before a pause could reach the gateway ahead of the
      // answer that took the order on.
      if (decision.deliversLater) {
        taken.set(order.id, order);
        deliverLater(order);
      }
      writeOrderAnswer(decision.said, order, decision.detail);
      return decision.answer;
    });

    fresh.on("quote", async (question) => {
      feed.got("merchant", "The SDK handed the handler a price question.", {
        merchant_item_id: question.merchant_item_id,
        price_id: question.price_id,
      });
      if (moods.quote === "unavailable") {
        const answer = question.unavailable();
        feed.sent("merchant", "The handler said this product has no price right now.", {
          price_id: question.price_id,
          answer,
        });
        return answer;
      }
      if (moods.quote === "say_nothing") {
        await wait(SILENCE_PAST_DEADLINES_MS);
      }
      const answer = question.available(moods.price);
      feed.sent("merchant", "The handler answered the price question.", {
        price_id: question.price_id,
        answer,
      });
      return answer;
    });

    fresh.on("event", (event) => {
      taken.delete(event.order_id);
      feed.got("gateway", "The gateway sent an event about an order.", event);
      closedOnItsOwn();
    });

    // Eleven kinds arrive here and exactly one of them is the gateway refusing
    // what this handler sent. A poll that never got through, a handler that
    // threw, an answer this SDK would not send, a dialect mismatch that stops
    // the loop — a console calling all of them "the gateway refused" is wrong
    // about ten. The SDK already writes one sentence a person can act on, so
    // that sentence is the line; the kind travels beside it as the fact it is,
    // and a fatal one ends the subscription on screen rather than leaving the
    // top of the page claiming a loop that has stopped.
    fresh.on("problem", (problem) => {
      if (problem.fatal && stoppedBecause === null) {
        stoppedBecause = problem.message;
      }
      feed.got("gateway", problem.message, {
        error: problem.kind,
        fatal: problem.fatal,
        ...(problem.subject === undefined ? {} : { subject: problem.subject }),
        ...(problem.cause === undefined ? {} : { cause: String(problem.cause) }),
      });
    });
  };

  /** Gives up on every order held for a person, so a disconnect never waits on an answer. */
  const abandonHeld = (): void => {
    for (const [orderId, { abandon }] of [...answering]) {
      feed.write(
        "merchant",
        "The stand is disconnecting while this order is held for you, so the handler gives up on it and answers nothing.",
        { order_id: orderId },
      );
      abandon(abandonment(orderId, "was held for a person to answer when the stand disconnected"));
    }
  };

  return {
    moods,
    held,
    pause,
    paused,
    releasePaused(orderId) {
      const waiting = unpausing.get(orderId);
      if (waiting === undefined) return false;
      feed.write("stand", "You released a paused order.", {
        order_id: orderId,
        phase: paused.get(orderId)?.phase,
      });
      waiting.release();
      return true;
    },
    connected: () => address,
    stopped: () => stoppedBecause,
    answerHeld(orderId, answer) {
      const waiting = answering.get(orderId);
      if (waiting === undefined) return false;
      feed.write("stand", "You answered a held order.", { order_id: orderId, answer });
      waiting.answer(answer);
      return true;
    },
    async orders(open) {
      // Both halves, like every other call this file makes. The console cannot
      // watch an SDK call from the outside the way it watches its own fetches,
      // so a call the SDK makes says for itself that it went and what came
      // back — a line arriving with nothing in front of it is what makes a log
      // read as though it were out of order.
      feed.sent(
        "merchant",
        open === true
          ? "Asking the SDK for the orders still owed something."
          : "Asking the SDK for this merchant's orders.",
        { open: open === true },
      );
      const listed = await connectedClient().orders.list(
        open === true ? { open: true } : undefined,
      );
      // Which question this answers is said out loud. Both lists are asked for
      // on connect and they come back in either order, so two lines reading
      // "The gateway answered with 0 orders." and "…with 7 orders." arrive back
      // to back with nothing on either of them saying which was which.
      feed.got(
        "merchant",
        open === true
          ? `The gateway answered with ${listed.length} order${listed.length === 1 ? "" : "s"} still owed something.`
          : `The gateway answered with ${listed.length} order${listed.length === 1 ? "" : "s"}.`,
        {
          open: open === true,
          orders: listed.length,
        },
      );
      return listed;
    },
    async deliverOwed(orderId, merchantItemId) {
      await handOver(orderId, merchantItemId);
    },
    async refuseOwed(orderId) {
      feed.sent("merchant", "The handler refused an order it had already accepted.", {
        order_id: orderId,
        refusal: moods.refusal,
      });
      const result = await calls(orderId).refuse(moods.refusal);
      feed.got(
        "merchant",
        result.ok ? "The gateway took that refusal." : "The gateway would not take that refusal.",
        { order_id: orderId, ...answerRead(result) },
      );
    },
    async connect(baseUrl, apiKey) {
      await this.disconnect();
      disconnecting = false;
      deliverySession = makeDeliverySession();
      stoppedBecause = null;
      const fresh = createClient({ baseUrl, apiKey });
      register(fresh);
      await fresh.start();
      client = fresh;
      address = baseUrl;
      feed.write(
        "stand",
        "Started the merchant SDK. It is polling this gateway for work from now on.",
        { base_url: baseUrl },
      );
    },
    async disconnect() {
      const stopping = client;
      client = undefined;
      address = null;
      taken.clear();
      results.clear();
      disconnecting = true;
      abandonPaused();
      abandonHeld();
      await stopDeliveries();
      if (stopping !== undefined) {
        await stopping.stop();
        feed.write("stand", "Stopped the merchant SDK. It is no longer polling and holds nothing.");
      }
    },
    async publish(card) {
      if (client === undefined) {
        throw new Error("Connect the stand merchant before publishing a card.");
      }
      const result = await client.catalog.publish(card);
      feed.sent("merchant", "Published a card through the SDK.", {
        merchant_item_id: card.merchant_item_id,
        result,
      });
      return result;
    },
    learn(merchantItemId, result) {
      results.set(merchantItemId, result);
    },
  };
};
