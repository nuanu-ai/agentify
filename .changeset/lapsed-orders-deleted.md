---
"@nuanu-ai/agentify": patch
---

The description of `orders.list` says that an order which ended rejected or
expired with nothing charged or held is deleted thirty days after it was last
written, after which `orders.get` refuses it with `no_such_order` and no list
carries it.
