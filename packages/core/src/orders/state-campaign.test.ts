/** Offline lifecycle campaign: reachable orders, finite event permutations and consumer money promises. */
import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { createOrder, type PriceCheck } from "./create.js";
import { deadlines } from "./deadlines.js";
import { transition } from "./machine.js";
import type { Effect, FulfillmentMode, Order, OrderEvent, OrderPolicy } from "./model.js";
import { DEADLINE_KINDS, isOpen, modeOf, ORDER_EVENT_KINDS, ORDER_STATES } from "./model.js";
import { moneyInvariantViolations } from "./money.js";
import { outcomeFor } from "./outcome.js";

const START = 1_000_000;
const policy: OrderPolicy = {
  deadlines: {
    quoteResponseMs: 17,
    quoteTtlMs: 31,
    settleResponseMs: 23,
    syncResponseMs: 41,
    paymentAfterConfirmationMs: 43,
    confirmationResponseMs: 47,
    asyncFulfillmentMs: 59,
  },
  redelivery: { baseDelayMs: 2, factor: 2, maxDelayMs: 16, maxAttempts: 4 },
};
const modes: readonly FulfillmentMode[] = ["sync", "async", "confirm", "ship"];
const checks: readonly PriceCheck[] = ["none", "merchant"];
const stats = {
  subject: "e11fef741e875ef6f9c42465a6b27577dd2921a1",
  traces: 0,
  attemptedSteps: 0,
  acceptedSteps: 0,
  rejectedSteps: 0,
  candidateTransitions: 0,
  schedules: 0,
  states: {} as Record<string, number>,
  effects: {} as Record<string, number>,
  traceEffects: {} as Record<string, number>,
  counterScopes: {
    states:
      "Initial and accepted states from the 512 generated traces, including repeated observations.",
    effects: "Generated traces plus the 108 schedule prefixes and schedule events.",
    traceEffects: "Effects from the 512 generated traces only.",
    boundaries:
      "Selected generator time classes; a proposed time earlier than the preceding event is clamped.",
  },
  offered: {} as Record<string, number>,
  taken: {} as Record<string, number>,
  boundaries: {} as Record<string, number>,
  seeds: [] as { caseId: string; seed: number }[],
  scheduleCases: [] as {
    caseId: string;
    clock: string;
    expectedState: string;
    expectedPayment: string;
    actualState: string;
    actualPayment: string;
    outcome: string;
  }[],
};
const count = (map: Record<string, number>, key: string): void => {
  map[key] = (map[key] ?? 0) + 1;
};
const ensure = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}
function choose<T>(random: () => number, values: readonly T[]): T {
  const value = values[Math.floor(random() * values.length)];
  if (value === undefined) throw new Error("empty campaign choice");
  return value;
}
function make(mode: FulfillmentMode, priceCheck: PriceCheck, id: string): Order {
  const made = createOrder({
    id,
    at: START,
    mode: modeOf(mode),
    policy,
    priceCheck,
    cardPrice: { amount: "7.20", currency: "USD", asOf: START - 100 },
    test: true,
    selling: "open",
  });
  if (!made.ok) throw new Error(made.rejection.message);
  return made.order;
}
function events(at: number): OrderEvent[] {
  return ORDER_EVENT_KINDS.flatMap((kind): OrderEvent[] => {
    switch (kind) {
      case "quote_answered":
        return [
          { kind, at, available: true, price: { amount: "8.10", currency: "USD", asOf: at - 10 } },
          { kind, at, available: true, price: { amount: "8.10", currency: "EUR", asOf: at - 10 } },
          { kind, at, available: false },
        ];
      case "payment_verification_failed":
        return ["signature", "insufficient_funds", "price_stale"].map(
          (reason) => ({ kind, at, reason }) as OrderEvent,
        );
      case "handler_refused":
      case "refuse_called":
        return [
          { kind, at, code: "cannot_fulfill", message: "The requested product is unavailable." },
        ];
      case "deadline_expired":
        return DEADLINE_KINDS.map((deadline) => ({ kind, at, deadline }));
      default:
        return [{ kind, at }];
    }
  });
}

/** This ledger does not ask transition() whether a charge or release was safe. */
function ledger() {
  let outstanding = 0;
  let releases = 0;
  let receipts = 0;
  let erasures = 0;
  return (
    before: Order,
    event: OrderEvent,
    after: Order,
    effects: readonly Effect[],
    where: string,
  ): void => {
    for (const effect of effects) {
      if (effect.kind === "execute_payment") {
        ensure(
          outstanding === 0,
          `${where}: a second charge was requested before the first resolved`,
        );
        ensure(
          before.payment !== "outcome_unknown",
          `${where}: an unresolved payment was charged again`,
        );
        outstanding += 1;
      }
      if (effect.kind === "release_goods_to_agent") releases += 1;
      if (effect.kind === "issue_receipt") receipts += 1;
      if (effect.kind === "erase_ship_to") erasures += 1;
      if (effect.kind === "mark_refund_due")
        ensure(after.payment === "settled", `${where}: debt without a settled payment`);
      count(stats.effects, effect.kind);
    }
    if (
      (event.kind === "payment_settled" || event.kind === "payment_settle_failed") &&
      (before.payment === "settling" || before.payment === "outcome_unknown")
    ) {
      outstanding -= 1;
    }
    ensure(
      outstanding >= 0 && outstanding <= 1,
      `${where}: invalid outstanding charge count ${outstanding}`,
    );
    ensure(
      releases <= 1 && receipts <= 1,
      `${where}: goods or receipt issued twice (${releases}/${receipts})`,
    );
    ensure(erasures <= 1, `${where}: buyer's address erased twice`);
    ensure(
      after.state !== "delivered" || after.payment === "settled",
      `${where}: success without payment`,
    );
    ensure(
      !["refund_due", "refunded"].includes(after.state) || after.payment === "settled",
      `${where}: debt without payment`,
    );
    ensure(
      after.payment !== "settled" ||
        ["paid", "dispatched", "delivered", "refund_due", "refunded"].includes(after.state),
      `${where}: settled money has neither goods nor a debt`,
    );
    ensure(
      after.payment !== "outcome_unknown" || outcomeFor(after) === "payment_unresolved",
      `${where}: unknown payment described as known`,
    );
    ensure(
      moneyInvariantViolations(after).length === 0,
      `${where}: ${moneyInvariantViolations(after).join("; ")}`,
    );
    if (before.mode.parcel === true && before.dispatch.accepted) {
      ensure(after.dispatch.accepted, `${where}: a parcel forgot its acceptance`);
      ensure(
        event.kind !== "order_dispatched",
        `${where}: parcel sent back after its address was erased`,
      );
    }
  };
}

function freeze(order: Order): Order {
  Object.freeze(order.timestamps);
  Object.freeze(order.dispatch);
  Object.freeze(order);
  return order;
}
function walk(caseId: string, seed: number, mode: FulfillmentMode, priceCheck: PriceCheck): void {
  const random = rng(seed);
  let order = freeze(make(mode, priceCheck, caseId));
  let at = START;
  const account = ledger();
  const trace: string[] = [];
  count(stats.states, order.state);
  for (let step = 0; step < 128; step += 1) {
    const due = deadlines(order)[0];
    const clockClass = Math.floor(random() * 6);
    const proposed =
      clockClass === 0
        ? at
        : clockClass === 1
          ? at + 1
          : clockClass === 5
            ? at + 101
            : due === undefined
              ? at + 2
              : due.at + clockClass - 3;
    at = Math.max(at, proposed);
    count(
      stats.boundaries,
      ["same", "next", "deadline-1", "deadline", "deadline+1", "distant"][clockClass] ?? "unknown",
    );
    const all = events(at);
    const advance: OrderEvent[] = [];
    const open: OrderEvent[] = [];
    const money: OrderEvent[] = [];
    const timed: OrderEvent[] = [];
    for (const candidate of all) {
      stats.candidateTransitions += 1;
      const result = transition(order, candidate);
      if (!result.ok || JSON.stringify(result.order) === JSON.stringify(order)) continue;
      advance.push(candidate);
      if (isOpen(result.order.state)) open.push(candidate);
      if (
        result.effects.some((effect) =>
          ["execute_payment", "release_goods_to_agent", "mark_refund_due"].includes(effect.kind),
        )
      )
        money.push(candidate);
      if (candidate.kind === "deadline_expired") timed.push(candidate);
    }
    const die = random();
    const pool =
      die < 0.15 && timed.length
        ? timed
        : die < 0.35 && money.length
          ? money
          : die < 0.7 && open.length
            ? open
            : die < 0.88 && advance.length
              ? advance
              : all;
    const event = choose(random, pool);
    const before = JSON.stringify(order);
    const result = transition(order, event);
    ensure(JSON.stringify(order) === before, `${caseId}/${step}: input mutated`);
    ensure(
      JSON.stringify(result) === JSON.stringify(transition(order, event)),
      `${caseId}/${step}: replay differs`,
    );
    stats.attemptedSteps += 1;
    count(
      stats.offered,
      event.kind === "deadline_expired" ? `${event.kind}/${event.deadline}` : event.kind,
    );
    trace.push(
      `${event.kind}@${at}->${result.ok ? `${result.order.state}/${result.order.payment}` : result.rejection.code}`,
    );
    if (result.ok) {
      stats.acceptedSteps += 1;
      account(
        order,
        event,
        result.order,
        result.effects,
        `${caseId} seed=${seed} step=${step} trace=${trace.join(" | ")}`,
      );
      order = freeze(result.order);
      count(stats.states, order.state);
      count(
        stats.taken,
        event.kind === "deadline_expired" ? `${event.kind}/${event.deadline}` : event.kind,
      );
    } else stats.rejectedSteps += 1;
  }
  stats.traces += 1;
  stats.seeds.push({ caseId, seed });
}

describe("generated order consumer promises", () => {
  it("preserves money, goods and uncertainty in 512 reachable traces of 128 events", () => {
    for (const [modeIndex, mode] of modes.entries())
      for (const [checkIndex, priceCheck] of checks.entries()) {
        const cell = modeIndex * 2 + checkIndex;
        for (let index = 0; index < 64; index += 1) {
          const seed = (0xe11fef74 ^ Math.imul(index + 1, 0x9e3779b9) ^ cell) >>> 0;
          walk(`state-${mode}-${priceCheck}-${index}`, seed, mode, priceCheck);
        }
      }
    expect(stats.attemptedSteps).toBe(65_536);
    stats.traceEffects = { ...stats.effects };
    expect(Object.keys(stats.states).sort()).toEqual([...ORDER_STATES].sort());
    for (const effect of [
      "execute_payment",
      "release_goods_to_agent",
      "issue_receipt",
      "mark_refund_due",
    ])
      expect(stats.effects[effect], `not reached: ${effect}`).toBeGreaterThan(0);
  }, 90_000);
});

const permutations = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const;
function recipe(
  mode: FulfillmentMode,
  kinds: readonly OrderEvent["kind"][],
): { order: Order; account: ReturnType<typeof ledger> } {
  let order = make(mode, "none", `schedule-${mode}`);
  const account = ledger();
  for (const [index, kind] of kinds.entries()) {
    const event = events(START + index + 1).find((candidate) => candidate.kind === kind);
    if (event === undefined) throw new Error(`missing event ${kind}`);
    const result = transition(order, event);
    ensure(result.ok, `checkpoint ${mode}/${kind} was unreachable`);
    if (!result.ok) throw new Error("checkpoint refused");
    const expected =
      kind === "payment_verified"
        ? mode === "sync"
          ? "paid/verified"
          : "quoted/settling"
        : kind === "payment_settled"
          ? "paid/settled"
          : kind === "order_dispatched"
            ? `dispatched/${mode === "sync" ? "verified" : "settled"}`
            : kind === "handler_delivered"
              ? "fulfilled/settling"
              : kind === "payment_settle_failed"
                ? "delivered_unpaid/settle_failed"
                : "refund_due/settled";
    ensure(
      `${result.order.state}/${result.order.payment}` === expected,
      `checkpoint ${mode}/${kind}: expected ${expected}, got ${result.order.state}/${result.order.payment}`,
    );
    ensure(
      JSON.stringify(order) !== JSON.stringify(result.order),
      `checkpoint ${mode}/${kind} changed nothing`,
    );
    account(order, event, result.order, result.effects, `checkpoint-${mode}-${kind}`);
    order = result.order;
  }
  return { order, account };
}
const groups: {
  id: string;
  mode: FulfillmentMode;
  prefix: OrderEvent["kind"][];
  trio: OrderEvent["kind"][];
  deadline: "sync_response" | "settle_response" | "async_fulfillment";
}[] = [
  {
    id: "sync-answer",
    mode: "sync",
    prefix: ["payment_verified", "order_dispatched"],
    trio: ["handler_delivered", "handler_refused", "deadline_expired"],
    deadline: "sync_response",
  },
  {
    id: "settle-uncertain",
    mode: "sync",
    prefix: ["payment_verified", "order_dispatched", "handler_delivered"],
    trio: ["deadline_expired", "payment_settled", "purchase_repeated"],
    deadline: "settle_response",
  },
  {
    id: "async-answer",
    mode: "async",
    prefix: ["payment_verified", "payment_settled", "order_dispatched"],
    trio: ["deadline_expired", "deliver_called", "refuse_called"],
    deadline: "async_fulfillment",
  },
  {
    id: "debt",
    mode: "async",
    prefix: ["payment_verified", "payment_settled", "order_dispatched", "handler_refused"],
    trio: ["deliver_called", "refund_settled", "refuse_called"],
    deadline: "async_fulfillment",
  },
  {
    id: "parcel",
    mode: "ship",
    prefix: ["payment_verified", "payment_settled", "order_dispatched"],
    trio: ["handler_accepted", "order_dispatched", "deadline_expired"],
    deadline: "async_fulfillment",
  },
  {
    id: "unpaid-retry",
    mode: "sync",
    prefix: ["payment_verified", "order_dispatched", "handler_delivered", "payment_settle_failed"],
    trio: ["payment_settle_failed", "purchase_repeated", "payment_verified"],
    deadline: "settle_response",
  },
];

describe("critical order schedules", () => {
  for (const group of groups)
    for (const offset of [-1, 0, 1])
      for (const permutation of permutations) {
        it(`${group.id}/${offset}/${permutation.join("")}`, () => {
          let { order, account } = recipe(group.mode, group.prefix);
          const running = deadlines(order)[0];
          expect(`${order.state}/${order.payment}`).toBe(
            group.id === "settle-uncertain"
              ? "fulfilled/settling"
              : group.id === "debt"
                ? "refund_due/settled"
                : group.id === "unpaid-retry"
                  ? "delivered_unpaid/settle_failed"
                  : `dispatched/${group.mode === "sync" ? "verified" : "settled"}`,
          );
          const clock = running ? "deadline boundary" : "time sample; no running deadline";
          const anchor =
            running?.at ??
            (order.timestamps.settleStartedAt ?? order.timestamps.paidAt ?? START) + 59;
          for (const index of permutation) {
            const kind = group.trio[index];
            const event =
              kind === "deadline_expired"
                ? ({ kind, at: anchor + offset, deadline: group.deadline } as OrderEvent)
                : events(anchor + offset).find((candidate) => candidate.kind === kind);
            if (event === undefined) throw new Error("schedule event missing");
            const result = transition(order, event);
            if (result.ok) {
              account(
                order,
                event,
                result.order,
                result.effects,
                `${group.id}/${offset}/${permutation.join("")}`,
              );
              order = result.order;
            }
          }
          const position = (index: number): number => permutation.indexOf(index as 0 | 1 | 2);
          const expected =
            group.id === "sync-answer"
              ? offset < 0
                ? position(0) < position(1)
                  ? ["fulfilled", "settling", "in_progress"]
                  : ["failed", "verified", "rejected"]
                : ["expired", "verified", "expired"]
              : group.id === "settle-uncertain" || group.id === "async-answer"
                ? ["delivered", "settled", "delivered"]
                : group.id === "debt"
                  ? position(0) < position(1)
                    ? ["delivered", "settled", "delivered"]
                    : ["refunded", "settled", "refunded"]
                  : group.id === "parcel"
                    ? offset < 0
                      ? ["dispatched", "settled", "in_progress"]
                      : ["refund_due", "settled", "refund_due"]
                    : [
                        "delivered_unpaid",
                        position(1) > position(2)
                          ? "none"
                          : position(0) > position(2)
                            ? "settle_failed"
                            : "settling",
                        "delivered_unpaid",
                      ];
          expect([order.state, order.payment, outcomeFor(order)]).toEqual(expected);
          stats.scheduleCases.push({
            caseId: `${group.id}/${offset}/${permutation.join("")}`,
            clock,
            expectedState: expected[0] ?? "",
            expectedPayment: expected[1] ?? "",
            actualState: order.state,
            actualPayment: order.payment,
            outcome: outcomeFor(order),
          });
          stats.schedules += 1;
        });
      }
});

afterAll(() => {
  if (process.env.AGENTIFY_STATE_CAMPAIGN_EVIDENCE)
    writeFileSync(
      process.env.AGENTIFY_STATE_CAMPAIGN_EVIDENCE,
      `${JSON.stringify(stats, null, 2)}\n`,
    );
});
