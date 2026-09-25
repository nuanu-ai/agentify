---
"@nuanu-ai/agentify-contracts": minor
---

The payout wallet answer now carries `pending`, a required field that is null
when nothing is waiting and otherwise names the replacement address and
`takes_effect_at`, the moment it replaces the address paid now. On the live
deployment a replacement for a wallet already set is announced to every
cabinet account of the merchant and takes effect forty-eight hours later, and
a caller that reads its old address back beside a pending change has not
failed to write. The nested document is published as `pending_payout_wallet`.

Four refusal codes join `ERROR_CODES`, all returned by `POST
/v0/payout-wallet` alone: `wallet_change_nobody_to_tell`,
`wallet_change_not_announced`, `wallet_change_unconfirmed` and
`wallet_change_raced`. No SDK worker reads that route, so the contract
version stays where it is; a reader holding the previous `PayoutWalletSchema`
refuses an answer carrying `pending`, which is why this is a minor release.
