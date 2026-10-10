---
"@nuanu-ai/agentify-contracts": minor
---

The agent's order status carries `reason`, a code and a sentence, where
Agentify and not the merchant ended the order and the status word alone would
blur the next step: `rejected` with `unavailable`, `price_check_unanswered` or
`payment_not_settled`, and `expired` with `price_expired` or
`merchant_timed_out`. The codes are an open word whose known values are
`ORDER_ENDING_REASONS` (`OrderEndingReasonSchema`). A reason never stands
beside a merchant's `refusal`. The field is optional and the storefront's
documents are read open (ADR-0006 §5), so `CONTRACT_VERSION` does not move.
