---
"@nuanu-ai/agentify-contracts": patch
---

A card that leaves out `merchant_item_id`, `title`, `description` or `price`,
or names a `fulfillment` mode or a declared field's `type` that does not exist,
is refused in a sentence saying what the field is or which words it takes,
rather than in the validation library's "Invalid input: expected string,
received undefined" or "Invalid option".
