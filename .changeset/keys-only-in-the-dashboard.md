---
"@nuanu-ai/agentify-contracts": minor
---

A merchant's key no longer reaches the merchant's keys. The routes
`list_keys` (`GET /v0/keys`), `issue_key` (`POST /v0/keys`) and `disable_key`
(`POST /v0/keys/:key_id/disable`) are removed from `API_ROUTES`, and the gateway
answers them as it answers any address it does not have: 404 with the code
`no_such_route`. Keys are issued, listed and revoked only by a person signed in
to the merchant's dashboard, so a key that leaks cannot issue itself a successor
or revoke the merchant's other keys, and revoking it ends what it can do. The
codes `key_opened_this_call` and `no_such_key`, which only those routes sent,
are removed from `ERROR_CODES`. The SDK made none of these calls.

The documents only those routes carried leave the package with them:
`MerchantKeySchema`, `MerchantKeyListSchema`, `IssueKeyRequestSchema`,
`IssuedKeySchema` and `DisabledKeySchema`, their types, and their entries
`merchant_key`, `merchant_key_list`, `issue_key_request`, `issued_key` and
`disabled_key` in `schemas`.

The `publish_card` description no longer calls the operator's approval
one-time: a merchant whose approval the operator has withdrawn gets
`no_operator_approval` as one never approved does.
