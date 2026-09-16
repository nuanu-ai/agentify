---
"@nuanu-ai/agentify-contracts": patch
---

Say whose ceiling a description is held to, and how long the text actually is.
The refusal a card gets for a description over five hundred characters used to
read "a description is at most 500 characters, which is what a listing carries",
and a merchant reading that could not tell whether the limit was ours, the
payment protocol's, or something about the alphabet they write in. It is the
discovery catalog's, documented rather than enforced by anything of theirs we
can run, and the sentence now says so — along with the length of the text that
was refused, which is the one number the merchant cannot see for themselves and
the one they have to act on.

Nothing about the shape moves: the ceiling is the same five hundred characters,
the JSON Schema still carries `maxLength: 500`, and `CONTRACT_VERSION` does not
change. What changes is what a merchant reads when the door turns their card
away.
