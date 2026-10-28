/**
 * What an operator reads of a purchase: how long each party took, which gate
 * turned a request away, and what a buyer was told to wait for. Every label
 * takes its value from a short fixed list, so no series names a merchant, a
 * buyer, a product, an order or a price, and the number of series stays the
 * same however many purchases there are. Times are read on the gateway's own
 * clock, the one its deadlines run on.
 */

import { telemetry } from "@agentify/observability/source";
import type { SettleOutcome, VerifyOutcome } from "../ports/facilitator.js";
import type { AdmissionResult, Integration } from "../ports/store.js";

const priceAnswers = telemetry.durations(
  "agentify_price_answer_duration_seconds",
  "Time from asking a merchant for a price to its answer, or to the end of the wait for one",
  ["outcome", "integration"],
);
const pricesPaid = telemetry.durations(
  "agentify_price_to_payment_seconds",
  "Time from a price being named to the arrival of a first payment for it, payments after the price expired included",
  [],
);
const checks = telemetry.durations(
  "agentify_payment_verify_duration_seconds",
  "Time the payment layer took to check a payment, by the lane it waited in and the verdict",
  ["lane", "outcome"],
);
const admissions = telemetry.durations(
  "agentify_payment_admission_duration_seconds",
  "Time of the transaction that admits a checked payment's order, by its result",
  ["result"],
);
const charges = telemetry.durations(
  "agentify_payment_settle_duration_seconds",
  "Time from asking the payment layer for a charge to its answer, by outcome and by when the card is charged",
  ["outcome", "mode"],
);
const payerReads = telemetry.durations(
  "agentify_payer_read_duration_seconds",
  "Time of one read of a payer's wallet from the payment chain",
  ["outcome"],
);
const gateRefusals = telemetry.occurrences(
  "agentify_gate_refusals_total",
  "Requests a merchant's gate had no place for within their wait",
  ["gate"],
);
const retryAfters = telemetry.occurrences(
  "agentify_retry_after_answers_total",
  "Answers that told a buyer to come again after Retry-After seconds",
  ["answer", "retry_after_seconds"],
);

/** A clock stepped back reads as no time rather than as negative time. */
const seconds = (ms: number): number => Math.max(0, ms) / 1_000;

const FAILED = Symbol("failed");

/** Runs `work` and records how long it took under what it returned, or under `FAILED` where it threw. */
async function timed<T>(
  clock: () => number,
  work: () => Promise<T>,
  record: (ms: number, ended: T | typeof FAILED) => void,
): Promise<T> {
  const started = clock();
  let ended: T | typeof FAILED = FAILED;
  try {
    ended = await work();
    return ended;
  } finally {
    record(clock() - started, ended);
  }
}

export function priceAnswered(
  outcome: "answered" | "unavailable" | "silent",
  integration: Integration,
  ms: number,
): void {
  priceAnswers.observe({ outcome, integration }, seconds(ms));
}

export function paymentArrived(sincePricedMs: number): void {
  pricesPaid.observe({}, seconds(sincePricedMs));
}

/** The lane a payment waits in for its check: signed by its wallet's own funded key, or not. */
export type PaymentLane = "proven" | "unproven";

export function verifyTimed(
  clock: () => number,
  lane: PaymentLane,
  verify: () => Promise<VerifyOutcome>,
): Promise<VerifyOutcome> {
  return timed(clock, verify, (ms, ended) => {
    const outcome =
      ended === FAILED
        ? "failed"
        : ended.verified === true
          ? "verified"
          : ended.verified === false
            ? "refused"
            : "no_verdict";
    checks.observe({ lane, outcome }, seconds(ms));
  });
}

export function admissionTimed(
  clock: () => number,
  admit: () => Promise<AdmissionResult>,
): Promise<AdmissionResult> {
  return timed(clock, admit, (ms, ended) => {
    admissions.observe({ result: ended === FAILED ? "failed" : ended.kind }, seconds(ms));
  });
}

export function settleTimed(
  clock: () => number,
  mode: "on_purchase" | "after_fulfillment",
  settle: () => Promise<SettleOutcome>,
): Promise<SettleOutcome> {
  return timed(clock, settle, (ms, ended) => {
    const outcome =
      ended === FAILED
        ? "failed"
        : ended.settled === true
          ? "settled"
          : ended.settled === false
            ? "refused"
            : "unknown";
    charges.observe({ outcome, mode }, seconds(ms));
  });
}

export function payerReadTimed<T>(clock: () => number, read: () => Promise<T>): Promise<T> {
  return timed(clock, read, (ms, ended) => {
    payerReads.observe({ outcome: ended === FAILED ? "failed" : "read" }, seconds(ms));
  });
}

/**
 * A gate that had no place in time. Not every refusal reaches the buyer: a
 * card charged after its goods sells at its card price when its price
 * question finds no place, and a payment whose payer could not be read waits
 * in the unproven lane.
 */
export function gateRefused(gate: "price" | PaymentLane | "payer_read"): void {
  gateRefusals.inc({ gate });
}

export function retryAfterAnswered(
  answer: "seller_busy" | "payment_being_checked" | "not_checked_now",
  waitSeconds: number,
): void {
  retryAfters.inc({ answer, retry_after_seconds: String(waitSeconds) });
}
