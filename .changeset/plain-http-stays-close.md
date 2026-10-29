---
"@nuanu-ai/agentify": patch
---

`createClient` now refuses a `baseUrl` over plain `http:` unless it names this
machine (`localhost`, a `*.localhost` name, `127.0.0.0/8` or `[::1]`) or a
name with no dot, meant for a container on a private network. It
throws a `TypeError` when the client is built, before any call, because every
call carries your API key and plain http would send it unencrypted. The
gateways at `https://test.agentify.ad` and `https://agentify.ad` are reached
over https as before.
