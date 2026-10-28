---
"@nuanu-ai/agentify": patch
"@nuanu-ai/agentify-contracts": patch
---

Timing changes your worker will see. An order your process does not answer
comes again for up to three hours after it was first handed over, with pauses
that grow to fifteen minutes, as long as its deadline allows; before, it came
five times within about half a minute. Each repeat carries the same order id,
so a handler that already holds against repeats needs no change. A price
question now waits ten seconds for your answer instead of five, and the price
you name holds for three minutes instead of thirty seconds, so name a price you
can keep for that long.
