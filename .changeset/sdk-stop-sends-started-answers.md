---
"@nuanu-ai/agentify": minor
---

`stop()` sends the answers handlers return while it waits, where it used to
drop them unsent, and waits fifty seconds at most, where a handler that never
returned used to hold it for ever. Each message still unfinished then gets a
`batch_abandoned` problem of its own, with the message's identifier as its
`subject`, saying where it stood: an order still waiting or in its handler had
nothing sent for it and comes again, and an answer already on its way may have
arrived, which nobody on this side knows.

A worker stopping on another contract version ends the same way. It no longer
reports an answer that had already left as one for which nothing was sent, nor
reports that answer a second time as `answer_failed`.
