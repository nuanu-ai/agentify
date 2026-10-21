# How many sign-in and report links go out

2026-10-21. Design note for the limits on the dashboard's link mail.

The dashboard emails two kinds of one-time link: a sign-in link, which anybody
can ask for from the sign-in page, and a report link, which the scanner asks
for when a visitor wants a scan's full report. Both channels, test and live,
send real mail through Resend from one sender domain; the test channel's
startup log names the provider and the sender. Whether the two channels share
one provider account is not recorded in the repository. A provider pauses an
account whose bounces or complaints climb. If the channels share an account, a
pause would stop email sign-in on both at once; on the live channel it would
also stop every payout-wallet change, because the dashboard writes a change
only after the mail announcing it has been handed to the provider. A page that
mails whatever address is typed into it is therefore a way to take the sender
down, and the limits below bound what one person can make it send.

## The limits

An address gets at most one link a minute and three an hour. This keeps one
inbox from being flooded, and it is the only limit an honest person normally
meets.

A visitor gets at most ten sign-in links an hour, whatever addresses it types,
and ten report link asks an hour across every scan. A visitor is the address
the edge in front of the site writes into `X-Forwarded-For`, after the edge has
thrown away whatever the browser sent there. An IPv4 address carried in an IPv6
form counts as that IPv4 address, and an IPv6 address counts by its /64,
because one machine commonly holds a whole /64 and can move around inside it.
People behind a carrier's or an office's network address translation, where
many devices share one public address, reach the edge from that one address and
count as one visitor. Counting by address costs exactly that, and the
per-visitor allowance is set high enough for an office signing in, not for a
mailing.

Some requests arrive from an address that cannot be a visitor's: a private
network address, an address from the range carriers use between their own
devices and their shared public addresses (100.64.0.0/10), a loopback or
link-local address, or a value that cannot be read as an address at all. Such
an address belongs to a proxy in front of the edge, not to a visitor. All of
these requests count together as one unknown client with an allowance of its
own: thirty sign-in links and thirty report link asks an hour.

The test channel is in this position today. Its encrypted connections pass
unopened through a forwarding host in front of it, which routes them by the
site name they ask for, and every visitor reads as that host's private address.
On the test channel the thirty are therefore everybody's thirty. One person
asking three links for each of ten addresses closes email sign-in on the test
channel for an hour, about seven times more cheaply than the ceiling below, and
report links close the same way. Our own test runs, with several personas
signing in, can reach it by accident. This bounds abuse of the shared sender
through the test channel, at that price. Passing visitors' addresses through
does not happen on its own: besides the forwarding host sending them, the
inner Caddy needs either a listener that reads the PROXY protocol header the
forwarding host would add, or that host's address among its trusted proxies if
it forwards a header instead. Only then does the limit become per visitor.

## The ceiling

Each channel sends at most two hundred sign-in links and two hundred report
links an hour, whoever asks. The ceiling protects the sender: however many
addresses and clients an attacker uses, what the channel sends in an hour is
bounded, and a provider pause becomes an hourly wall that clears by itself.

The ceiling is also a lever. Twenty public addresses asking ten links each,
to throwaway mailboxes, spend it, and then nobody on that channel gets an
emailed link until the hour has passed. Where Google sign-in is configured,
and today both channels' sign-in pages offer it, it does not pass through the
ceiling and keeps working, and the refusal page offers it. The two channels
count separately, so spending the test channel's ceiling does not touch the
live one's count.

So that a spent ceiling is seen rather than discovered by a merchant, a refusal
by the ceiling writes one warning line to the dashboard's log, starting
`[dashboard] link ceiling reached:` and naming the purpose, the limit, the hour
counted and the moment links go out again, with no address in it. A process
writes the line again only after a link of that purpose has gone out since its
last line. Under a sustained attack every slot that frees is taken at once, so
the line can be written about once per freed slot, up to a couple of hundred
times an hour per process. An alert can hang on it. Each process keeps its own
note, and a restarted process writes the line afresh.

The channel's count takes no lock. A lock for the whole channel would hold
every sign-in behind whichever one is waiting on the mail provider. Sends in
flight at the same moment can therefore pass the ceiling by as many as there
are of them.
