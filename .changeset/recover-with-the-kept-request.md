---
"@nuanu-ai/agentify-contracts": patch
---

The purchase route's description says that asking the purchase address again
without the kept challenge starts a new purchase with a new payment reference,
which is charged again, so a lost answer is recovered only by signing the kept
challenge again. No schema, type or behaviour of the package changes, and
`CONTRACT_VERSION` does not move.
