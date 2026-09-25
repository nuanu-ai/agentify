---
"@nuanu-ai/agentify-contracts": minor
---

The payout wallet is set only through the merchant's cabinet, whose calls to
the gateway come from inside the stack, when a person sets it on the Settings
screen. `POST /v0/payout-wallet` is not routed by the public origin at all,
so from outside it answers as a path the site does not have, and at the
gateway a key made for the merchant's own code is refused with 403 under
`not_a_cabinet_key`, for the first address as for a replacement, with nothing
written or announced. `GET /v0/payout-wallet` still answers any key of the
merchant's. The descriptions of both routes say who may call them, and the
publish route's description sends a merchant with no wallet to the cabinet's
Settings.

No schema changes and `ERROR_CODES` does not grow, since the code is the one
the cabinet's key routes already refuse under. What changes is what a reader
of the contract relies on: code written against the previous description
could set the wallet with its own key, and now it cannot, which is why this is
a minor release rather than a patch. No SDK worker calls the route, so the
contract version stays where it is.
