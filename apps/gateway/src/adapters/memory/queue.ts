/**
 * The queue, in memory. A worker already parked when an envelope is published
 * receives it at once, with no polling lag. Each merchant has a stream of
 * their own, and a drawn envelope never returns to it on its own: the order
 * machine decides any redelivery. Waiting is `setTimeout`, so tests drive it
 * with fake timers.
 */

import type { WorkerEnvelope } from "@nuanu-ai/agentify-contracts";
import type { DrawnEnvelope, Queue, Reminder, ReminderPatience } from "../../ports/queue.js";
import type { Envelopes } from "./store.js";

type Waiter = () => void;

interface Stream {
  readonly ready: WorkerEnvelope[];
  /**
   * Published with a delay and not arrived yet: counted by `holdsOrder`, out of
   * a worker's reach until its moment.
   */
  readonly held: Set<WorkerEnvelope>;
  readonly waiters: Set<Waiter>;
}

export class MemoryQueue implements Queue {
  /**
   * One stream per merchant. A single filtered stream would have to draw a
   * stranger's envelope to look at it, and merchant A polling would swallow
   * merchant B's orders.
   */
  readonly #streams = new Map<string, Stream>();
  readonly #inFlight = new Map<string, { merchantId: string; envelope: WorkerEnvelope }>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #fire: ((reminder: Reminder) => Promise<void>) | null = null;
  #running = false;
  #handles = 0;
  readonly #patience: ReminderPatience;
  /** What would run daily, by name, so a test can run it when it wants to. */
  readonly daily = new Map<string, () => Promise<unknown>>();

  constructor(patience: ReminderPatience = { attempts: 3, retryDelayMs: 5 }) {
    this.#patience = patience;
  }

  async publish(merchantId: string, envelope: WorkerEnvelope, afterMs?: number): Promise<void> {
    (await this.stage(merchantId, envelope, afterMs))();
  }

  /**
   * Takes an envelope for a stream and hands back the call that makes it
   * visible. The memory store uses the two halves in place of a transaction:
   * anything that would refuse refuses here, before the order is written, and
   * the envelope appears only after, so no worker sees an envelope for an
   * order change not yet written.
   */
  async stage(merchantId: string, envelope: WorkerEnvelope, afterMs?: number): Promise<() => void> {
    const stream = this.#streamOf(merchantId);
    return () => {
      if (afterMs === undefined || afterMs <= 0) {
        this.#arrive(merchantId, envelope);
        return;
      }
      stream.held.add(envelope);
      this.#later(() => {
        // Gone from `held` means forgotten while it waited: it must not arrive.
        if (stream.held.delete(envelope)) {
          this.#arrive(merchantId, envelope);
        }
      }, afterMs);
    };
  }

  /**
   * Drops every undrawn envelope on the stream that carries a parcel's address:
   * the order's hand-overs and the named price question, delayed ones
   * included. Events carry no address and stay. It cannot refuse; the store
   * calls it with the write that records the address as erased.
   */
  forget(merchantId: string, orderId: string, priceQuestion: string | null): void {
    const carries = (envelope: WorkerEnvelope): boolean =>
      (envelope.kind === "order" && envelope.payload.id === orderId) ||
      (envelope.kind === "quote_request" &&
        priceQuestion !== null &&
        envelope.payload.price_id === priceQuestion);

    const stream = this.#streamOf(merchantId);
    const kept = stream.ready.filter((envelope) => !carries(envelope));
    stream.ready.splice(0, stream.ready.length, ...kept);
    for (const envelope of [...stream.held]) {
      if (carries(envelope)) {
        stream.held.delete(envelope);
      }
    }
  }

  /**
   * This queue as the store's way of writing with an order. Calls go through
   * the queue at call time, so a test that replaces `stage` affects the store.
   */
  envelopes(): Envelopes {
    return {
      stage: (merchantId, envelope, afterMs) => this.stage(merchantId, envelope, afterMs),
      forget: async (merchantId, orderId, priceQuestion) => () => {
        this.forget(merchantId, orderId, priceQuestion);
      },
    };
  }

  async holdsOrder(merchantId: string, orderId: string): Promise<boolean> {
    const stream = this.#streamOf(merchantId);
    // A drawn envelope is in neither, as with the real queue.
    return [...stream.ready, ...stream.held].some(
      (envelope) => envelope.kind === "order" && envelope.payload.id === orderId,
    );
  }

  async draw(
    merchantId: string,
    max: number,
    waitMs: number,
    gone?: AbortSignal,
  ): Promise<readonly DrawnEnvelope[]> {
    if (gone?.aborted) {
      return [];
    }
    const first = this.#take(merchantId, max);
    if (first.length > 0 || waitMs <= 0) {
      return first;
    }

    await this.#park(merchantId, waitMs, gone);
    // A worker that left takes nothing; what arrived stays for the next poll.
    return gone?.aborted ? [] : this.#take(merchantId, max);
  }

  async finish(merchantId: string, handle: string): Promise<void> {
    // An unknown handle is a repeated answer, which merchants are promised is
    // safe. Another merchant's handle is left alone.
    if (this.#inFlight.get(handle)?.merchantId === merchantId) {
      this.#inFlight.delete(handle);
    }
  }

  async remind(reminder: Reminder, afterMs: number): Promise<void> {
    this.#deliver(reminder, Math.max(afterMs, 0), 1);
  }

  /**
   * One delivery of a reminder, and another after it if the handler threw, as
   * pg-boss's retries do.
   */
  #deliver(reminder: Reminder, afterMs: number, attempt: number): void {
    this.#later(() => {
      const fire = this.#fire;
      if (fire === null) {
        return;
      }
      void fire(reminder).catch(() => {
        if (attempt < this.#patience.attempts) {
          this.#deliver(reminder, this.#patience.retryDelayMs, attempt + 1);
        }
      });
    }, afterMs);
  }

  onReminder(fire: (reminder: Reminder) => Promise<void>): void {
    if (this.#running) {
      throw new Error("where reminders go is set before the queue is started, not after");
    }
    this.#fire = fire;
  }

  /** Records what would run daily and never runs it. */
  async everyDay(name: string, work: () => Promise<unknown>): Promise<void> {
    this.daily.set(name, work);
  }

  async start(): Promise<void> {
    if (this.#fire === null) {
      throw new Error("the queue has nowhere to put reminders and will not start");
    }
    this.#running = true;
  }

  async stop(): Promise<void> {
    this.#running = false;
    for (const timer of this.#timers) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    for (const stream of this.#streams.values()) {
      for (const wake of stream.waiters) {
        wake();
      }
      stream.waiters.clear();
    }
  }

  #streamOf(merchantId: string): Stream {
    const found = this.#streams.get(merchantId);
    if (found !== undefined) {
      return found;
    }
    const made: Stream = { ready: [], held: new Set(), waiters: new Set() };
    this.#streams.set(merchantId, made);
    return made;
  }

  #arrive(merchantId: string, envelope: WorkerEnvelope): void {
    const stream = this.#streamOf(merchantId);
    stream.ready.push(envelope);
    // Only this merchant's parked workers are woken.
    for (const wake of stream.waiters) {
      wake();
    }
    stream.waiters.clear();
  }

  #take(merchantId: string, max: number): DrawnEnvelope[] {
    const stream = this.#streamOf(merchantId);
    const drawn = stream.ready.splice(0, Math.max(max, 0));
    return drawn.map((envelope) => {
      this.#handles += 1;
      const handle = `h${this.#handles}`;
      this.#inFlight.set(handle, { merchantId, envelope });
      return { envelope, handle };
    });
  }

  #park(merchantId: string, waitMs: number, gone?: AbortSignal): Promise<void> {
    const stream = this.#streamOf(merchantId);
    return new Promise((resolve) => {
      const wake: Waiter = () => {
        clearTimeout(timer);
        this.#timers.delete(timer);
        stream.waiters.delete(wake);
        gone?.removeEventListener("abort", wake);
        resolve();
      };
      const timer = setTimeout(wake, waitMs);
      this.#timers.add(timer);
      stream.waiters.add(wake);
      gone?.addEventListener("abort", wake, { once: true });
    });
  }

  #later(run: () => void, afterMs: number): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      run();
    }, afterMs);
    this.#timers.add(timer);
  }
}
