/**
 * Records a payment fact the settle call did not return: the facilitator is
 * asked once and a silence is never asked again, so a person who read the
 * outcome elsewhere hands it to the machine here. The fact is not checked, and
 * the word written beside the order says it is an operator's record. A wrong
 * transaction cannot be taken back, since after `payment_settled` the machine
 * has no reverse. The settlement field of the payment-layer header stays
 * empty, because that header is the facilitator's receipt.
 */

import { isOpen, type OrderEvent } from "@agentify/core";
import { type Applied, type OrderFacts, UNOBSERVED_SETTLE } from "./app/runner.js";
import type { StoredOrder } from "./ports/store.js";

const USAGE = [
  "Usage: pnpm --filter @agentify/gateway report-payment <order>",
  "       pnpm --filter @agentify/gateway report-payment <order> settled <transaction>",
  "       pnpm --filter @agentify/gateway report-payment <order> failed <reason>",
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
  // The deadline can declare a silence while the settle call is still in
  // flight, and a fact written then races the answer; a settle word is written
  // only once that call has returned. It must be this charge's word: a failed
  // earlier charge leaves one behind, so only a word written after the payment
  // was last handed over for execution counts.
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
  // Recording a failure on an open order lifts the guard against a second
  // charge, so an unchecked "it failed" would spend the buyer's money on a
  // guess. The order stays unresolved until somebody records that the charge
  // landed, which releases the goods already made and sends nothing new.
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
