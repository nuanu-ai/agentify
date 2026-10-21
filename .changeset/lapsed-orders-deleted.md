---
"@nuanu-ai/agentify": patch
---

The description of `orders.list` says that an order which ended with nothing
charged and nothing held for its buyer is deleted thirty days after it ended,
after which `orders.get` refuses it with `no_such_order` and no list carries it.
