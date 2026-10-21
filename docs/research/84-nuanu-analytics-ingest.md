# What Nuanu Analytics is relied on to do with an event

Agentify's server sends every product analytics event to Nuanu Analytics
itself, one request per event, as decided in
[ADR-0042](../decisions/0042-product-analytics-leave-from-the-server.md). Nuanu
Analytics is the analytics team's deployment of Rybbit, an open-source web
analytics server. Rybbit's public tracking script, the one a website puts in
its pages, posts each event as JSON to `/api/track`; Agentify's sender posts a
document of the same shape there from the server, with an `event_id` and a
`timestamp` of its own.

The sender relies on two things about how that server treats such a document.
The first is that an event whose `timestamp` is more than seven days before its
arrival is not stored at that time but dated at the moment it arrives; this is
why the sender gives up, unsent, an event that has waited more than seven days,
rather than let it be counted on the wrong day. The second is that a second
event with the same `event_id` as one already stored is recognised as the same
event and not counted again; this is what makes it safe for delivery to be at
least once, since an event whose answer was lost is posted again with the same
id and time. Underneath both lies a third, which the whole design needs: that
an event posted from a server, with no browser behind it, is stored at all and
is not discarded as a robot's visit.

These facts come from the analytics team's own description of their server's
code, given to Agentify on 2026-10-20 and 2026-10-21. None of them has been
checked against the deployed service yet.

The first send to the TEST site is therefore also the check. It has to show
three things, each read back from the site rather than from the answer to the
request: that a server-sent event carrying `event_id` and `timestamp` is stored
with the time it carried; that it is not filtered out as a robot's; and that
posting the very same event a second time leaves one event, not two. If the
first fails, nothing the server sends is counted. If the second fails, every
event repeated after a lost answer is counted twice. A different age limit than
seven days changes only how long the sender lets an event wait.
