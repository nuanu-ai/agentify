---
"@nuanu-ai/agentify-contracts": minor
---

`CardSchema` now refuses a card whose title, description or declared field
title is not plain text: one carrying HTML markup (a tag, or the opening of a
comment), an HTML character reference such as `&amp;` or `&#8217;`, or a
control character. A description may still carry line feeds, and an
ampersand, a comparison or an arrow written as text still passes. Each finding
names what was found and the character it begins at; nothing is cleaned or
rewritten on the way in. The rule is the publish door's alone: a card already
stored is read back exactly as it was, and neither `MerchantCardSchema` nor
`PublicCardSchema` holds a card to it. `notPlainTextIn` is the rule itself,
exported for a connector that turns a shop's HTML into text before it
publishes.
