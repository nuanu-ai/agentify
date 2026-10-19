---
"@nuanu-ai/agentify-contracts": patch
---

The purchase route's description says that the price a challenge names holds
for thirty seconds, and the order opened for it lapses with it, while the
challenge's `maxTimeoutSeconds` is longer: it is how long the signed
authorisation has to stay valid for a purchase delivered in the answer to be
charged after its goods, not a time to pay in, so an agent signs and presents
the payment at once. It also says that, where the goods are still to be made,
a payment for such a purchase whose authorisation would end before that
charge, with a margin, is refused as `payment_not_verified`, before anything
is made or charged, and that the same order can be paid again with a fresh
signature while its price holds. No
schema, type or behaviour of the package changes, and `CONTRACT_VERSION` does
not move.
