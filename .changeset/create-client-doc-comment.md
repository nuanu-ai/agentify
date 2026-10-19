---
"@nuanu-ai/agentify": patch
---

`createClient` has a doc comment for the integrator: what it builds, that
building it calls nothing, what it throws at once (no key, an address that is
not http or https), what it leaves to the first call (no address at all, a key
the gateway refuses), and what the client it returns carries. The doc comment
on `stop()` no longer opens twice, so an editor shows it from its first word.
No type or behaviour changes.
