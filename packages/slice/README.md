# @agentify/slice

This package is the repository's own test equipment, not a product surface:
nothing in it is published, and nothing a merchant integrates against lives
here. It holds the vertical slice that `pnpm test` walks end to end through a
real gateway booted in memory, the `buy` and `smoke` commands that walk a
purchase against a running gateway or a test network, the stand — a local
console, started with `pnpm stand`, where one person sits in turn in each of
the three seats of a purchase: the merchant who publishes, the agent who buys,
and the merchant's code answering orders — and the two fault instruments
described below. All of them drive the real gateway and the real SDK from the
outside, so that a test sees what a merchant or an agent would.

## Cutting an answer after the server committed it

Several stories in the [manual test plan](../../docs/research/42-manual-test-plan.md)
need an answer that is lost after the server has done the work: a buyer's paid
purchase, or the answer to a merchant's publish, handler answer, delivery or
refusal. Killing the caller after a couple of seconds does not show that the
server finished anything. The cut proxy does: it forwards each request to the
gateway, reads the gateway's whole answer, and only then drops it on the way
back to the caller, so at the moment of the cut the full answer was in hand.

It is started from the root of the repository with one rule, and runs until it
is stopped:

```sh
pnpm cut --to http://localhost:8080 --method POST --path '/x402/*/purchase' --phase mid-body
```

`--to` is the gateway's base URL, http or https, and may carry a base path,
which is put in front of every path the caller asks for. A hosted gateway is
given by its https address: its http address answers with a redirect to
https, the caller follows that redirect straight to the gateway, and the
purchase is paid where the proxy never sees it. The proxy passes a redirect
uncounted with its address unchanged, and its line warns that the caller may
go around the proxy by following it. `--to` is refused if it carries a user
name or a password, since the caller's own credentials travel in its headers
and the proxy passes those on as they are. The refusal does not repeat them,
but pnpm prints the command line it runs before the proxy starts, and again
when the command fails, so whatever `--to` carries is in the terminal anyway
and a secret has no place in it.

The proxy listens on `127.0.0.1:8788`, or on the port given with `--port`, and
only on loopback. The caller is then pointed at the proxy instead of the
gateway: the buyer with `GATEWAY_URL=http://127.0.0.1:8788 pnpm buy`, a
merchant's code with `baseUrl: "http://127.0.0.1:8788"` in its SDK client. The
pattern is quoted so that the shell does not expand the `*`. The first line the
proxy prints says where it listens, where it forwards and which answer it will
cut; a malformed or missing flag is refused with one sentence naming the flag,
and the command then exits without listening.

The rule names a method, a path pattern and a phase. The method is matched
exactly and is written in capitals. The pattern is matched against the whole
path without its query string, and `*` stands for any run of characters within
one path segment. A buyer's purchase of any product is `POST /x402/*/purchase`;
the SDK's answer for a handler's result on any order is `POST
/v0/orders/*/answer`, and a merchant's delivery and refusal are the same path
ending in `deliver` and `refuse`; a publish is `POST /v0/catalog/publish`. The
other routes are listed in
[`packages/contracts/src/api.ts`](../contracts/src/api.ts).

Only an answer the gateway gave with a 2xx status is counted. That is the
proxy's rule, not a verdict that other answers commit nothing: the gateway
answers a synchronous purchase that came back without its goods with a 409
that carries the order, and that answer passes uncounted too. The unpaid first
call of a purchase is answered with a 402 challenge; it passes through
untouched and is not counted, which is why the rule above cuts the paid answer
that follows it and not the challenge. `--nth` picks which counted answer is
cut, the first by default. It counts answers in the order they came back whole
from the gateway, which with several requests in flight at once is not always
the order in which the requests arrived; the sequence number in the log keeps
the order of arrival.

Other answers are not counted either, and the log says why each time: an
answer shorter than two bytes, or an answer to HEAD, which has no body at all,
since neither has a middle to cut midway; an answer whose caller had already
left by the time it was complete, or left while the cut midway was still being
written to it, since the cut never reached anyone; and an upstream that could
not be reached or broke off its answer, which the caller receives as a 502
naming the upstream and the network code, unless the caller has left too, in
which case the line says that no 502 was sent.

The phase decides what the caller sees. With `before-headers` the proxy writes
nothing and closes the connection, so the caller has no status at all; curl
reports an empty reply from the server. With `mid-body` it writes the status
and the headers, with a content length that promises the whole body, then half
of the body, and closes the connection once those bytes are written; curl reports
the transfer closed with bytes remaining. A rule cuts once. After the cut, the
proxy passes everything through, as it does for every request the rule does
not match, with the status, the headers and the body unchanged except that the
headers describing the connection are dropped and the length is restated; an
answer to HEAD keeps the length the gateway gave, since it describes a body
that such an answer never carries.

The log is one line per request on standard output: the time, a sequence
number, the method, the path without its query string, the upstream's status,
the size of the body, and the order a JSON answer names in a top-level
`order_id`. The reverse proxy in front of the gateway compresses larger JSON
answers for a caller that accepts it, and the fetch in the SDK and in the buyer
does accept it, so many answers arrive encoded. The proxy forwards those bytes
as they came; the line then names the coding and counts the encoded bytes, and
reads the order from a decoded copy when the coding is gzip, deflate, br or
zstd. When it cannot read the order, because the coding is another one or the
body does not decode, the line says that the order was not read and why, so a
line that names no order is always one whose answer names none. The line for
the cut adds the phase and how many body bytes were written to the caller's
connection before the proxy closed it; how many of them the caller read is
something only the caller can tell. The line after it says that the rule is
spent. Apart from the name of a content coding, the log never prints a
header, a body or a query string, because merchant keys and payment
signatures travel in headers and goods and buyers' addresses in bodies. Order
ids do appear, in the paths and in that field, and an order id is a buyer's
proof of purchase: knowing it is enough to read the order and collect its
goods. A log from a run against a real channel belongs with the private
evidence of that run, not in an issue or in this repository.

The order document a purchase is answered with names its own address in
`status_url`, and that address is built from the address the gateway is
configured to answer as. It points at the gateway itself, so a buyer that
follows it after a cut reads the order directly and bypasses the proxy, and
those reads do not appear in the proxy's log.

After a cut purchase `pnpm buy` ends with a fetch error, and running it again
signs a new payment rather than repeating the one whose answer was lost. The
story in which a buyer sends the very same signed payment again after the cut
needs a buyer that keeps its signed payment header and resends it. The
repository has no such buyer, and the proxy's log cannot stand in for one,
since it never prints the signature.

Arming the rule again means restarting the proxy. Stop the caller first: a
restart drops whatever is in flight through the proxy at that moment, such as
an SDK worker's poll that the gateway holds open, and that is itself a cut
nobody planned.

## Pausing the stand's merchant

Some stories in the manual test plan
([docs/research/42-manual-test-plan.md](../../docs/research/42-manual-test-plan.md),
the instrument it calls merchant barriers) need the merchant to stop at a known
moment of an order: a crash before the merchant's effect, a crash after its
durable effect and before the gateway has been told, two merchant processes
holding the same order that the gateway sent twice. A sleep placed in the hope
of hitting that moment proves nothing about whether it was hit. The stand's
merchant can instead keep durable records and stop every order at one of two
points until a tester releases it by its identifier.

### Starting the stand with records

Records are kept only when the stand is started with a directory for them:

```sh
STAND_RECORDS_DIR=/tmp/stand-records pnpm stand
```

The variable can also go in `.env.stand` beside `STAND_BUYER_KEY`. A relative
path is resolved from `packages/slice`, where the command runs, so an absolute
one is the safer habit. The directory is created if it is missing, and the
start line names it together with the stand's process identifier:

```
Agentify stand: http://127.0.0.1:8787 — process 81696, keeping records in /tmp/stand-records
```

Two kinds of thing are written there, and they are counted apart on purpose.
Every order the SDK hands to the handler appends a line to `arrivals.jsonl`
with the order identifier, the merchant's item identifier, the time, and the
port and process identifier of the stand that received it. Every order the
handler answers gets one file holding the answer that goes back, with the same
identifying fields, and that file is the merchant's effect. It is named by the
SHA-256 of the order identifier, because an identifier may hold any printable
character and a slash in a file name is a path. The file is written whole and
flushed under a temporary name and then linked to its own name; a link refuses
a name that already exists, so the first stand to record an order keeps it,
and nobody ever reads a record half-written.

An order may arrive many times and has one effect. An arrival whose order
already has a record is answered with the recorded answer: what the handler is
set to answer now is not consulted, nothing new is recorded, and no delivery is
scheduled for it. Started without `STAND_RECORDS_DIR`, the stand writes nothing
and remembers nothing, and its start line says so.

A record holds the answer and nothing of a parcel. The stand keeps no shipping
address and has no path for recording a shipment, so the parcel stories that
need the merchant's durable copy of an address, F-02 in the plan, cannot be run
on it.

### The two pause points

The pause is set on the Orders tab, in the Paused panel. It is kept in memory,
starts as "Do not pause" every time the stand starts, and applies to every
arrival from the moment it is set, repeats included. Each arrival is paused
at most once, at the point that was set when it arrived: changing the setting
while an order is paused or still being decided sets up the next arrival and
leaves that one as it was, so turning the pause off releases nothing already
paused. A repeat of the same order is a new arrival and can be paused again.

"Pause each order as it arrives" stops an order once its arrival is counted and
before the stand does anything else with it: no record is looked up, no answer
decided, nothing written. That is the plan's "before effect". "Pause each order
with its answer ready" stops an order once its answer is decided and, with
records kept, recorded, and before that answer goes back to the gateway. That
is the plan's "after the durable effect, before acknowledgement": the record is
on disk and the gateway has heard nothing.

A pause is not one of the handler's answers. The answer chosen above it on the
same tab ("Deliver at once", "Refuse with the code below" and the rest) still
decides what the order gets, and the pause only stops the order at one point on
that path. That makes it a different thing from "Hold it and ask me", which
holds an order so that a person can choose its answer and gives up after thirty
seconds. A pause has no ceiling: it holds until the order is released, until
the stand disconnects, or until the process dies.

### Releasing a paused order

Every paused order is listed in the Paused panel with its identifier, its item,
the point it is paused at and since when, beside a Release button. The same
release works from a terminal, because the stand accepts a form post that
carries no Origin header:

```sh
curl -d action=release_pause -d order_id=<order id> http://127.0.0.1:8787/orders
```

A post the stand runs is answered with a redirect for the browser, a 303, and
the body of that redirect carries what the stand said back, so curl prints
either that the order was released or why nothing was. An identifier that is
not paused at this stand releases nothing and is answered in those words, under
the same 303. A script therefore reads the body to learn whether anything was
released, since the status is the same either way and `curl -f` cannot tell the
two apart. A post the stand does not run is answered otherwise: 403 when its
Origin header names a page other than this stand's own, 400 when its body could
not be read, and 503 while the stand is shutting down.

### Crashing in a phase, and running two stands

The Paused panel shows the stand's process identifier, as the start line does,
and `kill -9 <pid>` stops the stand exactly where its order is paused. Crashed
while an order is paused as it arrived, the stand leaves neither a record nor an
answer, and the gateway can send the order again. Crashed with the answer ready,
it leaves the record while the gateway still has heard nothing, so a stand
started again on the same directory answers the repeat with the recorded
answer, whatever it is now set to answer.

An order taken on with "Accept, then deliver after the delay" and crashed before
its answer went back has no delivery scheduled anywhere after the restart. The
repeat is answered from the record, which promises nothing new, and the order
waits in the Owed panel for a delivery by hand. That is the merchant's recovery
gap the plan asks to be looked at, and the stand does not paper over it.

Two stands of one merchant share its stream of orders. A second one started
with another `STAND_PORT` and the same `STAND_RECORDS_DIR`, and connected with
the same merchant key, shares one effect per order with the first. With both
set to pause with the answer ready, the stand handed the order first records
its answer and stops; a few seconds later the gateway sends the order again, the
other stand receives it, finds the record and stops with the same answer, and
the two hold one order the gateway sent twice, with one record between them.
Releasing or crashing either of them then plays out the plan's story of two
instances holding a redelivered order.

Disconnecting, connecting to another gateway, or stopping the stand with Ctrl-C
gives up on every paused order: its handler throws, the SDK answers nothing for
it, and a record already written stays. An order held by "Hold it and ask me" is
given up on the same way, with nothing answered and nothing recorded, because
nobody answering it while the stand goes away is not the merchant refusing it.
So is an order that would be held or paused, handed over while a disconnect
still waits for a delivery already on its way: it is given up on at once
rather than held. An order the stand decides outright in that wait is
recorded and answered as usual, because the SDK runs until the delivery has
landed. Only the
thirty-second ceiling, reached while the stand is connected, refuses a held
order, and that refusal is recorded like any other answer.

### What a long pause meets

Three clocks run while an order is paused, and a pause outlasts all of them.
The gateway waits about three seconds for one hand-over before sending the
order again; a synchronous order's goods are due ten seconds after the payment;
and the agent is promised an answer within twenty. While a stand's handler is
paused, that stand takes nothing else, because the SDK hands orders to its
handler one at a time. The repeat therefore goes to another stand of the same
merchant if one is polling. With none, it waits behind the paused order, and
the gateway does not hand out an order that has moved on since its repeat was
queued, so once a released delivery or refusal has closed the order nothing
more arrives for it. Taking the order on does not close it, and a repeat
queued before the order was taken on is still handed over after it. With
one stand on "Accept, then deliver" and the pause left at "Pause each order with its answer ready",
the order therefore comes back and is paused again: answered from its record
when records are kept, and decided afresh when they are not. Every repeat
counts toward the order's attempts, and an order is sent again only while it
has attempts left and its deadline allows.

A synchronous order paused past its ten seconds is over by the time it is
released. When its late goods arrive the gateway answers that the purchase has
already closed, and on the wire that answer is a success: the SDK reports only
answers that did not get through or were refused, and the stand does not log
what the gateway said back, so the log shows the handler delivering and nothing
after it. The order's own status is where the outcome shows: read the Orders
panel again after the release, and the order reads expired. A late refusal is
itself refused as an order already closed, and that the log does show. An
asynchronous order is held to its card's own delivery deadline instead, which
makes it the one to pause for long.

### Stories to run without records

A stand that keeps records answers every repeat with what it recorded, as a
merchant's own code should. It therefore cannot play a merchant who answers a
repeat differently: goods corrected after the gateway refused them, a different
delivery on a repeat, a shape the card never declared replaced by the right one.
Those stories run on a stand started without `STAND_RECORDS_DIR`.

### What is not paused

Only the handler's answer to an order is paused. The later delivery of an order
taken on earlier, whether it comes from the stand's own timer or from "Deliver
now" in the Owed panel, goes out without a pause, and so does a refusal sent
from the Owed panel. Price questions and order events are not paused either.
Nothing in the SDK or the gateway changes when the stand pauses: the pause
lives entirely in the stand's merchant.

## Making the dashboard's outside services fail

Three stories in the manual test plan, H-12, H-20 and H-23, need one of the
two outside services the dashboard calls on a merchant's behalf to fail while
everything else keeps working: Coinbase's exchange rates, which the dashboard
reads when a shop priced in another currency is connected and when its
WooCommerce screen is drawn, and the mail provider, which carries every rate a
merchant saves to the account's address before the rate is written. H-23 also
needs a record of every request the dashboard sends to Coinbase with its time,
so that a request made while a buyer waits for a price would show.

The instrument is a Compose file, `packages/slice/outbound/compose.yaml`, laid
over the repository's `compose.yaml`, and a command, `pnpm outbound`, that
works it from the host. The file adds a stand-in with its own TLS front and
changes two things in the application's container and nothing in the
application itself. The name api.coinbase.com resolves there to the TLS front,
which answers with a certificate from its own local authority, and the
application's Node process is told to trust that authority beside the usual
ones. The application's `MAIL_URL` names the stand-in, so the stand-in is the
mail provider. Every other name resolves as it always does, the shop's, the
chain's and the facilitator's at api.cdp.coinbase.com among them. The gateway
runs in the same process as the dashboard and is under the same two changes,
but it sends nothing to api.coinbase.com and nothing through the mail provider,
so the faults reach the dashboard alone.

### Starting a stack with it

The stand-in is for a stack on this machine. It is started with the stack, from
the root of the repository:

```sh
export AGENTIFY_SITE_ADDRESS=agentify.localhost
export AGENTIFY_WEB_PUBLISH=127.0.0.1:8443:443
export AGENTIFY_PUBLIC_ORIGIN=https://agentify.localhost:8443
export AGENTIFY_COOKIE_SECURE=true
docker compose -f compose.yaml -f packages/slice/outbound/compose.yaml up -d --build
```

The four variables are there because the dashboard holds a stack with a mail
provider to the rules of a real one. It refuses to start while the address it
names itself by is localhost, since every link it mails would then point at the
reader's own computer, and the start-up error says so. A name under
`.localhost` is not refused, and Chrome, Firefox and curl take it to this
machine. Connect, for its part, refuses a dashboard that is not on https,
because WooCommerce posts a shop's keys only to an https address; with a
hostname for its site address the stack's own Caddy serves https from a local
authority of its own, which a browser warns about until it is told to go on.
The stand-in takes those variables as it finds them and sets none of them. The
control port is published on 127.0.0.1:8789, or on the port named in
`AGENTIFY_OUTBOUND_PORT`, and `pnpm outbound` takes that port with `--port`.

Every message the dashboard sends now goes to the stand-in, sign-in links
included, and none goes further. The stand-in has no way to send mail: it
forwards nothing to any provider in any mode. Sign in by reading the link with
`pnpm outbound mail read`, as the dashboard's log is read on a stack without
the instrument.

### Working it

Each side has three modes, and a mode applies to every request that arrives
after it is set; a request already open keeps the mode it arrived under.

```sh
pnpm outbound coinbase pass      # forward to Coinbase, unchanged (the start)
pnpm outbound coinbase refuse    # answer 503 at once; Coinbase is not asked
pnpm outbound coinbase silent    # answer nothing; Coinbase is not asked
pnpm outbound mail accept        # answer 200 and keep the message (the start)
pnpm outbound mail refuse        # answer 503 and keep the message
pnpm outbound mail silent        # answer nothing and keep the message
pnpm outbound restore            # Coinbase passes and mail is accepted again
pnpm outbound status
```

Each of them prints the mode of both sides and how many requests each has
recorded. A silent side never answers: the dashboard gives up on each read of
Coinbase after three seconds and on each message after ten. Saving a rate reads
Coinbase twice, once to compare the rate and once to draw the screen again, and
mails the rate in between, so a save with Coinbase silent takes about six
seconds and one with mail silent about ten more. When Coinbase's side passes, the stand-in
makes the dashboard's request to the real api.coinbase.com itself, with the
same method, path, query and headers, less the ones that describe the
connection and the forwarding headers its front adds, and hands back Coinbase's
answer as it came. Nothing else reaches Coinbase from the instrument.

Restarting the stand-in also restores both sides, and it empties both records.

### Reading the record of Coinbase requests

```sh
pnpm outbound coinbase log
```

prints one line for every request that reached the stand-in for
api.coinbase.com since it started:

```
2026-10-22T12:37:01.231Z  #17  GET /v2/exchange-rates?currency=USD  silent  the caller left without an answer after 3002 ms
2026-10-22T12:37:41.533Z  #22  GET /v2/exchange-rates?currency=USD  pass  passed, Coinbase answered 200 after 224 ms
```

The time is when the request arrived, in UTC by the clock of the stand-in's
container, and the line is made at that moment, before anything is decided about the request, so a
request that is still open is listed as such. Then come the sequence number,
the method and the path with its query, the mode the request met, and how it
ended: passed with Coinbase's status; passed but Coinbase could not be reached,
with the network's code, in which case the dashboard was answered 502; passed
but Coinbase broke off its answer; refused; or left by its caller. A request
whose target is not a path on api.coinbase.com is refused with a 400 and sent
nowhere, which the dashboard's own request never meets. To show that no request
went to Coinbase while a buyer waited, read the containers' clock just before
the purchase starts and again once it has ended, and read the lines between the
two moments:

```sh
docker compose -f compose.yaml -f packages/slice/outbound/compose.yaml exec app node -p "new Date().toISOString()"
```

The containers share one clock, and on Docker Desktop it can drift from the
Mac's after the Mac sleeps, so the time on the buyer's terminal is not the one
to compare. Neither is a time in the purchase answer: the price's `as_of` is
when the price behind the sale was true, which can be long before the purchase,
and its `at` is when the price was fixed, after which payment and fulfilment go
on. The purchase itself is not in this record.

A request that never got past the TLS front is not in the record. That
happens when the application trusts another authority than the one the front
signs with, as after the front's volumes were removed and the front started
again without the application, and while the stand-in itself is down or
restarting, when the front answers 502 on its behalf. Either way the dashboard
reports Coinbase unreadable even while the side passes. Opening the
WooCommerce screen of a shop in another currency with Coinbase passing adds a
line; a screen that says Coinbase's rate could not be read and adds no line
means the stand-in is not where the requests go.

### Reading the mail

```sh
pnpm outbound mail read
```

prints every post the dashboard made to its mail provider since the stand-in
started: when it arrived, the mode it met, how it ended, the recipient and the
subject, and then the sender and the plain-text body, which carries every link
the message does. A refused or unanswered message is kept and listed with its
ending, so the record shows the rate notice the dashboard tried to send for a
rate it then did not save. The record lives in the stand-in's memory and goes
when it stops.

### What it does not do

It runs on a stack on this machine and has not been used on the test channel,
whose application is started by the host's release from a fixed set of Compose
files and whose mail goes to a real provider.

It brings no shop. A story about a shop priced in rupiah needs one the
connector accepts: on https with a certificate the application trusts, at a
public address, and able to post its keys to the dashboard's https address. The
lab's shop at its public address cannot reach a stack on this machine to post
them.

Only api.coinbase.com and the mail provider are stood in for. Coinbase's side
fails at the level of HTTP: the application always reaches the front and its
TLS always succeeds, so a fault in name resolution or a refused connection is
not among the modes.

Taking the instrument off is starting the stack again without the file and
with `--remove-orphans`, which puts the application back on its own mail
setting and the real api.coinbase.com and removes the stand-in's two
containers:

```sh
docker compose -f compose.yaml up -d --remove-orphans
```

It also removes every other container the project has outside `compose.yaml`,
such as a shop laid over the same project by a file of its own. Without
`--remove-orphans` the stand-in keeps running beside an application
that no longer goes through it, and `pnpm outbound status` still reports
whatever mode it was left in. `docker compose -f compose.yaml -f
packages/slice/outbound/compose.yaml down` removes the stand-in with the rest of
the stack.
