---
"@nuanu-ai/agentify-contracts": minor
---

The refusal code `wallet_change_unconfirmed` is gone from `ERROR_CODES`. The
dashboard that sends the messages about a payout wallet change runs in the
gateway's own process (ADR-0030), so asking it can no longer go unanswered; a
telling that fails part of the way is refused as `wallet_change_not_announced`,
whose words already say a message may have reached an account. Only the
dashboard sets the payout wallet and no SDK worker reads its refusals, so the
contract version stays (ADR-0006 §2). Code that matched the removed code by
name no longer compiles against this version.
