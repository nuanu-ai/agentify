---
"@nuanu-ai/agentify-contracts": patch
---

The refusal of an address whose capital letters do not match its checksum now
says that a character is mistyped and asks for the address to be copied again
from the wallet. It no longer suggests writing the address in lower case: lower
case carries no checksum, so following that advice would have turned a mistyped
address, which is somebody else's valid one, into an accepted one. Which
spellings are accepted is unchanged.
