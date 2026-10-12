/**
 * The queue: each merchant's stream of envelopes, and the reminders the gateway
 * leaves itself. Behind it is pg-boss; do not hand-roll a queue here.
 *
 * A drawn envelope never returns to the stream on its own. For orders that is
 * deliberate: an unanswered delivery comes back as a reminder, and only the
 * order machine decides whether to send again. For events it is a real gap:
 * an event drawn into a poll that never reached its worker is lost, since the
 * contract gives events no acknowledgement.
 *
 * A reminder only says a clock ran out; the order machine decides what it
 * means. A reminder whose handler throws is redelivered by the queue a bounded
 * number of times, because a reminder is the only thing that declares an
 * order overdue, and a dropped one leaves a paid order nobody refunds.
 */

import type { DeadlineKind } from "@agentify/core";
import type { WorkerEnvelope } from "@nuanu-ai/agentify-contracts";

/**
 * How often the Postgres queue looks for due reminders, in milliseconds, and so
 * the least a reminder can be late by. The configuration counts it into the
 * time a synchronous sale has to fit; a full batch of due reminders adds the
 * time the batch before it took.
 */
export const REMINDER_POLL_MS = 500;

export interface DrawnEnvelope {
  readonly envelope: WorkerEnvelope;
  /**
   * The handle for this delivery, not for the envelope. A poll that cannot
   * record a hand-over puts the same envelope back, so one envelope can be
   * drawn twice, and finishing one delivery must not finish the other.
   */
  readonly handle: string;
}

/**
 * Something the gateway asked to be reminded of. A deadline carries the instant
 * it runs out, not the instant the reminder fired, so a timer that fires early
 * or twice cannot close an order whose merchant is still inside the deadline.
 */
export type Reminder = (
  | {
      readonly kind: "deadline";
      readonly deadline: DeadlineKind;
      readonly at: number;
    }
  | {
      readonly kind: "delivery_unanswered";
      /**
       * Which hand-over went quiet: one delivery, not the message, so a
       * merchant who answered it is not sent the order again.
       */
      readonly handOver: string;
    }
) & {
  readonly orderId: string;
};

export interface Queue {
  /**
   * Puts one envelope on one merchant's stream, now or after a wait. No
   * document on the wire names a merchant, so the stream is named here.
   */
  publish(merchantId: string, envelope: WorkerEnvelope, afterMs?: number): Promise<void>;

  /**
   * Draws at most `max` envelopes off one merchant's stream, holding the call
   * open until one arrives or `waitMs` runs out; an empty batch is ordinary.
   * Never filter after drawing from a shared stream: that would consume
   * somebody else's message to look at it.
   */
  draw(
    merchantId: string,
    max: number,
    waitMs: number,
    /** The worker has gone: a waiting draw stops and takes nothing. */
    gone?: AbortSignal,
  ): Promise<readonly DrawnEnvelope[]>;

  /** This delivery has been answered. A handle is only unique on its stream. */
  finish(merchantId: string, handle: string): Promise<void>;

  /**
   * Whether this merchant's stream still holds an undrawn order envelope for
   * this order, a delayed redelivery included. The sweep asks before sending
   * an order again, because every hand-over counts towards the attempt cap and
   * reaching it means a refund.
   *
   * An envelope already drawn looks the same as one never written; that gap is
   * covered by `sweepDispatchGraceMs`, not by this.
   */
  holdsOrder(merchantId: string, orderId: string): Promise<boolean>;

  /** Asks to be reminded of something once, `afterMs` from now. */
  remind(reminder: Reminder, afterMs: number): Promise<void>;

  /**
   * Where fired reminders go. Set once, before the queue is started, or
   * deadlines are dropped silently.
   */
  onReminder(fire: (reminder: Reminder) => Promise<void>): void;

  /**
   * Runs `work` about once a day under `name`, once across all processes;
   * registering the same name again replaces it. The in-memory queue never
   * runs it, so nothing an order depends on may be put here.
   */
  everyDay(name: string, work: () => Promise<unknown>): Promise<void>;

  start(): Promise<void>;
  stop(): Promise<void>;
}

/** How patient a queue is with a reminder whose handler threw. */
export interface ReminderPatience {
  /**
   * How many deliveries in all, the first included. A process that dies while
   * holding a reminder uses up an attempt too, so with one attempt a crash
   * loses the deadline for good.
   */
  readonly attempts: number;
  readonly retryDelayMs: number;
}
