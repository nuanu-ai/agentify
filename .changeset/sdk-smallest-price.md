---
"@nuanu-ai/agentify": minor
---

`checkCard` reports a price above zero and below 0.01 as a finding on
`price.amount`, in the words the publish call uses, because publication now
refuses it: the payment network refuses payments below a minimum it does not
publish. A card priced `'0.001 USD'` that passed the check before is now
reported. The worker holds a price handler's answer to the same rule and
reports one under a cent as `HANDLER_ANSWER_REFUSED` without sending it.
