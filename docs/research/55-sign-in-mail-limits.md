# How many sign-in and report links go out

2026-10-21. Design note for the limits on the dashboard's link mail.

The dashboard emails two kinds of one-time link: a sign-in link, which anybody
can ask for from the sign-in page, and a report link, which the scanner asks
for when a visitor wants a scan's full report. Both channels, test and live,
send them through one mail provider account from one sender domain. A provider
pauses an account whose bounces or complaints climb, and a pause would stop
email sign-in on both channels at once. It would also stop every live
payout-wallet change, because the dashboard writes a change only after the mail
announcing it has been handed to the provider. A page that mails whatever
address is typed into it is therefore a way to take the sender down, and the
limits below exist to bound what one person can make it send.

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
People behind a carrier's or an office's NAT reach the edge from its one public
exit address, so they count as one visitor. Counting by address costs exactly
that, and the per-visitor allowance is set high enough for an office signing
in, not for a mailing.

Some requests arrive from an address that cannot be a visitor's: a private,
CGNAT, loopback or link-local address, or a value that cannot be read as an
address at all. Such an address belongs to an ingress or proxy in front of the
edge. The test channel is one case: its TLS arrives through an SNI pass-through
ingress, and every visitor reads as that ingress. All of these requests count
together as one unknown client with a larger allowance of its own, thirty
sign-in links and thirty report link asks an hour. Abuse through the test
channel is then bounded. On the day the ingress passes visitors' addresses on,
the limit becomes per visitor by itself.

## The ceiling

Each channel sends at most two hundred sign-in links and two hundred report
links an hour, whoever asks. The ceiling protects the sender: however many
addresses and clients an attacker uses, what the channel sends in an hour is
bounded, and a provider pause becomes an hourly wall that clears by itself.

The ceiling is also a lever. Twenty public addresses asking ten links each,
to throwaway mailboxes, spend it, and then nobody on that channel gets an
emailed link until the hour has passed. Google sign-in, which both channels
offer, does not pass through the ceiling and keeps working, and the refusal
page says so. The two channels count separately, so spending the test
channel's ceiling does not touch the live one.

So that a spent ceiling is seen rather than discovered by a merchant, its first
refusal in a window writes one warning line to the dashboard's log, starting
`[dashboard] link ceiling reached:` and naming the purpose, the limit, the hour
counted and the moment links go out again, with no address in it. An alert can
hang on that line. Each process writes its own line.

The channel's count takes no lock. A lock for the whole channel would hold
every sign-in behind whichever one is waiting on the mail provider. Sends in
flight at the same moment can therefore pass the ceiling by as many as there
are of them.
