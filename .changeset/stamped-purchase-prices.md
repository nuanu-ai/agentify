---
"@nuanu-ai/agentify-contracts": minor
"@nuanu-ai/agentify": minor
---

Contract version 6 carries an authenticated price stamp through the ordinary
x402 retry. Unpaid pricing creates no stored order; the paid request repeats
its purchase body, and one price identifies one order across concurrent retries.
A generic optional quote_reference confirms a merchant calculation and returns
unchanged on the order. It is visible to the buyer and must contain no secrets
or personal data. The buyer example keeps the challenge before payment and
uses a fresh signature to recover the same purchase.
Since no order exists before a verified payment, the ending reasons
unavailable, price_check_unanswered and price_expired and the refusal codes
order_not_priced_yet and order_closed_before_it_was_priced are removed, and
the worker no longer suggests setting stock aside for a price question.
