---
"@nuanu-ai/agentify": minor
---

`stop()` sends the answers handlers return while it waits, where it used to
drop them unsent, and waits eight seconds at most, where a handler that never
returned used to hold it for ever. Each message still unfinished then gets a
`batch_abandoned` problem of its own, with the order or price question it is
about as its `subject`, saying where it stood: an order still waiting or in its
handler had nothing sent for it and comes again, and an answer already on its
way may have arrived, which nobody on this side knows. Nothing the stop gave
up on reaches a handler afterwards. A process manager that kills the process
sooner cuts the wait short and nothing is reported: an order whose answer was
not sent comes again, and one whose answer was on its way may or may not be
closed by it.

An answer cut off by `stop()` is now reported as `batch_abandoned`, where it
used to be reported as `answer_failed`, so code that reconciles on
`answer_failed` after a shutdown should read `batch_abandoned` as well.

A worker stopping on another contract version ends the same way. It no longer
reports an answer that was on its way as one for which nothing was sent, nor
reports that answer a second time as `answer_failed`.
