/**
 * The machine's answer to a merchant as the contract puts it on the wire. The
 * machine names which error it is, and the sentence a person reads for each
 * one lives here once, so no call site words the same fact differently.
 */

import type { MerchantAnswer, MerchantAnswerError } from "@agentify/core";
import type { OrderCallResponse } from "@nuanu-ai/agentify-contracts";

const WHY: Record<MerchantAnswerError, string> = {
  refund_already_settled:
    "the buyer has his money back for this order, so there is nothing left to deliver against",
  order_already_closed: "this order reached an ending that no call reopens",
  not_applicable_in_mode:
    "this does not exist for this card's mode — in the synchronous one the handler answers with the goods or a refusal, and there is no taking the order on and no separate deliver or refuse call",
};

export function orderCallResponseOf(answer: MerchantAnswer): OrderCallResponse {
  if (answer.ok) {
    return { ok: true, result: answer.result };
  }
  return {
    ok: false,
    error: { code: answer.error, message: WHY[answer.error], retryable: answer.retryable },
  };
}
