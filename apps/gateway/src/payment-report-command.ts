/**
 * Recording a payment fact the settle call did not return.
 *
 * The facilitator is asked once. A silence is not asked again, and sending
 * the charge a second time is the thing the machine forbids. What is left is
 * a person who has read the answer somewhere else — a dashboard, a chain
 * explorer — and needs a way to hand that fact to the machine. This command
 * is that way. It does not check the fact. It says so, in the line it prints
 * and in the word it writes beside the order, so a later reader can tell an
 * operator's record from a sentence the facilitator actually returned.
 *
 * It is not a merchant route. A merchant did not see the facilitator's
 * answer, and a button that asserts a charge is a second machine. Whoever
 * runs this has the database in front of them, the same authority as the
 * merchant command, and a wrong transaction cannot be taken back: after
 * `payment_settled` the machine has no reverse.
 *
 * The settlement field the purchase route puts in the payment-layer header
 * is left empty. That header is the facilitator's receipt. Writing the
 * operator's string there would be presenting a person's reading as the
 * payment layer's own.
 */

import { isOpen, type OrderEvent } from "@agentify/commerce-core";
import { type Applied, type OrderFacts, UNOBSERVED_SETTLE } from "./app/runner.js";
import type { StoredOrder } from "./ports/store.js";

const USAGE = [
  "Usage: pnpm --filter @agentify/commerce-gateway report-payment <order>",
  "       pnpm --filter @agentify/commerce-gateway report-payment <order> settled <transaction>",
  "       pnpm --filter @agentify/commerce-gateway report-payment <order> failed <reason>",
  "",
  "The first form prints what is known and writes nothing.",
  "A write records a fact the facilitator was not asked for and the chain was not read.",
  "A wrong transaction cannot be taken back.",
].join("\n");

export interface PaymentReport {
  read(orderId: string): Promise<StoredOrder | null>;
  record(orderId: string, event: OrderEvent, facts: OrderFacts): Promise<Applied>;
  now(): number;
}

export async function runPaymentReport(
  argv: readonly string[],
  report: PaymentReport,
  say: (line: string) => void,
): Promise<number> {
  const [orderId, verb, ...rest] = argv;
  if (orderId === undefined || orderId === "--help" || orderId === "-h") {
    say(USAGE);
    return orderId === undefined ? 2 : 0;
  }

  if (verb === undefined) {
    const found = await report.read(orderId);
    if (found === null) {
      say(`there is no order ${orderId}`);
      return 1;
    }
    say(describe(found));
    return 0;
  }

  if (verb !== "settled" && verb !== "failed") {
    say(USAGE);
    return 2;
  }

  const fact = rest.join(" ").trim();
  if (verb === "settled" && rest.length !== 1) {
    say(USAGE);
    return 2;
  }
  if (fact === "") {
    say(USAGE);
    return 2;
  }

  const found = await report.read(orderId);
  if (found === null) {
    say(`there is no order ${orderId}`);
    return 1;
  }
  if (found.order.payment !== "outcome_unknown") {
    say(already(found));
    return found.order.payment === "settling" ? 1 : 0;
  }
  // The deadline can declare a silence while the original settle call is still
  // in flight — the client waits longer than that deadline. A settle word is
  // written only when that call has returned. Without one, a fact written now
  // races the answer, and whichever lands second is dropped.
  //
  // It has to be this charge's word and not any word. A first charge that came
  // back failed leaves one behind; the buyer then repeats the purchase and a
  // second charge goes out, and that one can go quiet with the first one's
  // sentence still sitting on the order. The order says when the payment was
  // last handed over for execution, and a word written before that instant
  // belongs to the charge before this one.
  const sentAt = found.order.timestamps.settleStartedAt;
  const answered =
    sentAt !== null &&
    found.paymentWords.some((word) => word.about === "settle" && word.at >= sentAt);
  if (!answered) {
    say(
      `${found.order.id} is waiting on a settle call that has not returned; a fact written now would race it`,
    );
    return 1;
  }
  // Recording a failure on an open order sets the payment to failed and lifts
  // the guard that refuses a second charge. An unchecked "it failed" would
  // spend the buyer's money on a guess about the first. The order stays
  // unresolved until somebody records that the charge landed, which releases
  // the goods already made and sends nothing new.
  if (verb === "failed" && isOpen(found.order.state)) {
    say(
      `${found.order.id} is still open; recording a failure would allow a second charge on a guess about the first`,
    );
    return 1;
  }

  say(
    "This records a fact the facilitator was not asked for and the chain was not read. A wrong transaction cannot be taken back.",
  );

  const at = report.now();
  const said =
    verb === "settled"
      ? `an operator recorded a settlement of ${fact}; ${UNOBSERVED_SETTLE} again and the chain was not read`
      : `an operator recorded that the charge failed (${fact}); ${UNOBSERVED_SETTLE} again and the chain was not read`;
  const applied = await report.record(
    orderId,
    { kind: verb === "settled" ? "payment_settled" : "payment_settle_failed", at },
    { paymentWord: { at, about: "settle", said } },
  );

  if (applied.outcome === "moved") {
    say(describe(applied.order));
    return 0;
  }
  if (applied.outcome === "no_such_order") {
    say(`there is no order ${orderId}`);
    return 1;
  }
  if (applied.outcome === "refused") {
    const again = await report.read(orderId);
    if (again !== null && again.order.payment !== "outcome_unknown") {
      say(already(again));
      return 0;
    }
    say(`${orderId} was not moved: ${applied.rejection.message}`);
    return 1;
  }
  say(`${orderId} was not moved`);
  return 1;
}

function describe(record: StoredOrder): string {
  const price = record.order.price;
  const lines = [
    record.order.id,
    `state ${record.order.state}`,
    `payment ${record.order.payment}`,
    price === null ? "no price" : `price ${price.amount} ${price.currency}`,
    record.payTo === null ? "no payTo" : `payTo ${record.payTo}`,
    record.paidBy === null ? "no payer" : `paid by ${record.paidBy}`,
  ];
  if (record.paymentWords.length === 0) {
    lines.push("the payment layer has said nothing");
  } else {
    for (const word of record.paymentWords) {
      lines.push(`${word.about}: ${word.said}`);
    }
  }
  return lines.join("\n");
}

function already(record: StoredOrder): string {
  if (record.order.payment === "settling") {
    return `${record.order.id} is still settling; the silence has not been declared, and a fact written now would race the call`;
  }
  return `${record.order.id} is already recorded as ${record.order.payment}\n${describe(record)}`;
}
