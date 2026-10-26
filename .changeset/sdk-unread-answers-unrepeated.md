---
"@nuanu-ai/agentify": patch
---

No failure or problem the package reports repeats the contents of an answer it
could not read, whatever that answer's status or content type: it names the
call, the status, the content type and the length, and where JSON did not fit,
the fields and what was expected there, so the buyer's details and the prices
stay out of your logs.

An answer that does not parse as JSON, such as a proxy's error page or a
gateway document cut short, is no longer quoted. A `poll_failed` problem about
an answer that names another contract version says so without repeating the
version it named.
