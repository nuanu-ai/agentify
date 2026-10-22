# @agentify/slice

This package is the repository's own test equipment, not a product surface:
nothing in it is published, and nothing a merchant integrates against lives
here. It holds the vertical slice that `pnpm test` walks end to end through a
real gateway booted in memory, the `buy` and `smoke` commands that walk a
purchase against a running gateway or a test network, the stand — a local
console, started with `pnpm stand`, where one person sits in turn in each of
the three seats of a purchase: the merchant who publishes, the agent who buys,
and the merchant's code answering orders — and the fault instruments
described below. All of them drive the real gateway and the real SDK from the
outside, so that a test sees what a merchant or an agent would. Each one that
listens does so on loopback, on a port of its own by default, so that a run
can use several at once: the stand on 8787, the cut proxy on 8788, the
outbound stand-in's control on 8789, the payment fault control on 8790 and the
additions proxy on 8791.

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

## Breaking a payment on purpose

Several stories in the [manual test plan](../../docs/research/42-manual-test-plan.md)
turn on what the payment layer answers about one purchase: a payment the
facilitator refuses to verify, a charge it refuses outright, a charge it carried
out whose answer never came back, and a charge whose success arrives after the
gateway has stopped waiting for it. No real facilitator gives any of these on
demand. The payment fault control is a facilitator of its own for the local
stack: it answers the two calls the gateway makes, verify and settle, the way
the gateway's x402 client expects, valid and settled, except the one call the
armed fault names. The gateway is pointed at it through the setting it already
has, `FACILITATOR_URL`, so nothing in the gateway, the SDK or the dashboard
changes or knows.

Nothing it answers is money. It signs nothing, broadcasts nothing and asks no
chain, and what it calls a transfer is an entry in its own memory. Every line
of its log that names a transfer says it is a local model, and the transfer is
named `local-model-<run>-<n>`, where the run is six hexadecimal characters
drawn when the control starts, so that the transfers of two runs are told apart.
That name is what the gateway records as the transaction that paid an order:
the buyer's answer, the order's status, the merchant's receipt and the
dashboard all show it, and none of them is evidence of a payment on any chain.

### Pointing the local stack at it

It is started from the root of the repository, and runs until it is stopped:

```sh
pnpm payment-faults --fault settle-lost
```

It listens on `127.0.0.1:8790`, or on the port given with `--port`, and only on
loopback. The stack's gateway runs in a container, which reaches the host's
loopback as `host.docker.internal` on Docker Desktop, where this was tried; on a
Linux Docker engine that name is not defined by `compose.yaml`, and whether a
container reaches a loopback listener there has not been tried. The stack is
pointed at the control with the variable `compose.yaml` already reads, and the
application is recreated for it to take effect:

```sh
AGENTIFY_FACILITATOR_URL=http://host.docker.internal:8790 docker compose up -d app
```

The same variable has to be given to every later `docker compose up` of that
stack, or the application comes back on the sandbox's scripted facilitator.
`AGENTIFY_PAYMENT_RPC_URL` stays empty, as `compose.yaml` leaves it. Given an
address, the gateway's payment recovery would read the real Base Sepolia for
every charge left unanswered, find the buyer's authorisation never used, since
nothing ever broadcast it, and once it had expired record the order as not
paid: the opposite of what `settle-lost`, and a late success that reached
nobody, claim in the model. That was not tried here.

A gateway whose facilitator is anything but the sandbox's is no longer a
sandbox. It takes itself for a test channel: its first log line and the
dashboard's banner say that payments settle on Base Sepolia with test funds,
which is not true here, every key it issues begins with `csk_test_`, and a
merchant sells only once they have a seller name and a payout wallet, set in
the dashboard as on the test channel. The sandbox's placeholder wallet no
longer stands in for one. Any address will do, such as a well-known
local-devnet account, since nothing is ever paid to it. A gateway on a chain
where the money is real refuses to start with any facilitator but Coinbase's,
and the control itself answers only for Base Sepolia, `eip155:84532`: a call
naming any other chain is answered 400 with no verdict, which the gateway reads
as a facilitator that said nothing, and the log line says why.

The buyer is `pnpm buy`, pointed at the stack as usual, or any x402 client. A
buyer's signature is a real authorisation on Base Sepolia, and the control is
the only party that receives it besides the gateway; it never sends it on, and
its log never prints it.

### Choosing the fault

The rule names a fault and, optionally, which call it falls on and how long the
answer is held. Without `--fault` the control breaks nothing, which is how the
stack is run between faults.

`--fault verify-refused` answers the chosen verification invalid, with the
reason `insufficient_funds`. The gateway refuses that purchase before any goods
are asked for and charges nothing: the buyer is answered 409
`payment_not_verified`, not retryable, and the refusal quotes the control's own
sentence, which says it is the armed fault.

`--fault settle-failed` answers the chosen settle as a definite failure, one
refused before anything was broadcast, with `invalid_exact_evm_recipient_mismatch`.
That reason is one of the two the gateway's x402 adapter takes as proof that
no money moved; every other failure it keeps as unknown, which is why the
control does not let the reason be chosen. No transfer is counted in the model.
A synchronous purchase whose goods were made reads `delivered_unpaid` with
`payment_status` `not_paid`, the goods withheld from the buyer and the order
listed for the merchant as delivered and not paid; a purchase paid before its
goods reads `rejected` and `not_paid`.

`--fault settle-lost` counts the chosen settle as a transfer in the model and
closes the connection without an answer. The gateway's client meets a closed
connection and the gateway keeps the order's payment as still running until its
own wait for the charge runs out, ten seconds on a synchronous purchase and
fifteen on one paid before its goods (`SETTLE_RESPONSE_MS` and
`SETTLE_BEFORE_GOODS_MS`). From then the order reads `payment_unresolved` with
`payment_status` `unresolved`, for the buyer, for the merchant and on the
dashboard, where it says the payment outcome is unknown. With payment recovery
off it stays that way, since nothing on the local stack can ever settle it.

`--fault settle-late` holds the chosen settle and then answers it settled, as
a counted transfer in the model. The hold is what makes it late, and only a
hold longer than the gateway's own wait for the charge, ten or fifteen seconds
as above, does: a shorter one is merely slow. When the wait runs out the order
reads `payment_unresolved`, and the success that comes after it is applied to
the order. A synchronous order then releases its goods and reads `delivered`
and `paid`; an order paid before its goods and not handed to the merchant reads
`unfulfilled` and `paid`. A merchant's closure sent during the hold was taken at
once, two and six seconds into it, and the late success then left the order
`fulfillment_closed` and `paid`, back on the merchant's open orders as paid
after closure. The gateway's facilitator client gives up on its own after thirty
seconds, measured with `@x402/core` 2.23.0 and counted from before the call
reaches the control: a hold of thirty seconds or more never reaches the
gateway, which then reads the charge as unknown exactly as with `settle-lost`,
and the log says that the success reached nobody. A hold a little under thirty
seconds, such as 27, leaves the most time for a person to act before the
answer. The log line says only that the control sent the answer; the order
turning `paid` is what shows the gateway received it.

`--nth` picks which call of the faulted kind is broken, counted in the order the
calls arrive: verifications for `verify-refused`, settles for the others. It is
the first by default. The nth call is not the nth purchase: a purchase the
merchant refuses, one whose goods come too late, one whose price is declined
and one whose payment the gateway refuses on its own reach no settle, a
buyer who presents a payment again after a verification went unanswered makes
a second verification, and a payment
presented again for an order already paid is meant to reach the facilitator
not at all. The safe habit is to restart the control with the default `--nth`
right before the purchase to break, and to read the log's count of calls
rather than count purchases.

`--after` is the hold, in seconds, from 0 to 600: twenty by default for
`settle-late` and none for the other settle faults, where a hold makes the
failure or the lost answer late as well. It is refused with `verify-refused`.

A fault falls once. From then on every call is answered valid or settled, and
the log says the fault is spent; arming it again means restarting the control.
Stopping it while a settle is held drops that answer as well, which is a lost
answer nobody chose, so a held settle is waited out before a restart. A
control that is not running at all is one more way to fail, not a fault it
arms: a verification that meets the closed port is answered to the buyer as a
refusal marked retryable, and a settle that meets it is unknown, as with
`settle-lost`.

### Reading the log

The log is one line per call on standard output, and more for a settle the
fault holds or cuts: the time, a sequence number, verify or settle, the
payment reference, the amount, the payer, the address paid, the first
characters of the authorisation's nonce, and what was answered and after how
long. A line also says when the gateway stopped waiting while an answer was
held. The payment reference is the name the 402 challenge gives an order and
opens nothing; the order's own identifier never reaches a facilitator and is
not in the log. The payee is the merchant's payout contract, which is how a
story about a changed wallet reads which address a charge was made out to.

The model counts one transfer per authorisation. A second settle of an
authorisation it already counted is answered as the rule says, names the first
transfer again and says so in its line: that line is what a story about a
charge made twice looks for, since no chain would move one authorisation's
money twice and a gateway that asked for it would be the defect. A real
facilitator would refuse the used authorisation, so the order such a settle
leaves behind is not what a real one would, and only the log line is evidence
in that case. The control checks nothing else about a payment: no signature,
no balance and no nonce on any chain, so a payment it calls valid proves
nothing about the buyer's wallet.

### What it does not model

The control speaks for the facilitator and nobody else. The gateway's recovery
of an unanswered charge reads the chain through `PAYMENT_RPC_URL`, and there is
no model of that chain here, so the stories that need a finalized transfer, a
cancelled authorisation, one that expired unused, an unreachable endpoint or a
receipt that does not match are not run with it, and a lost answer stays
unresolved on the local stack for good. A facilitator's answer that a charge
is pending, or a failure in words the adapter does not know, is not offered
either: the gateway keeps both as unknown, which `settle-lost` already shows.
It is not the forwarder that records the calls between the gateway and
x402.org's facilitator, and a real settlement on the test channel still needs
a capped real purchase there.

## Answering as a newer gateway

Story D-08 in the manual test plan asks what a merchant process does when the
gateway is newer than its release of the SDK without having moved the contract
version: when it adds things a reader is to ignore or read as `unknown`, and,
separately, when it adds to what an order delivers, which a reader is to
refuse. The rules are those of the contract version's decision record,
[ADR-0006](../../docs/decisions/0006-wire-version.md). The gateway of the run's
revision never sends such an answer, because it writes every answer to the
closed shape it knows, so the additions proxy stands in front of it and
answers as the newer gateway would. Like the cut proxy, it is outside the
product: nothing in the gateway or the SDK changes when it runs.

It is started from the root of the repository with one or more additions, and
runs until it is stopped:

```sh
pnpm additions --to http://localhost:8080 --add field --add status-word --add event-kind \
  --add event-reason --add result-word --add quote-purpose
pnpm additions --to http://localhost:8080 --add delivery-field
pnpm additions --to http://localhost:8080 --add address-shape
```

`--to` is read as the cut proxy reads it, with the same refusals: a base URL,
http or https, without a user name, a password, a query or a fragment, and a
hosted gateway given by its https address. The proxy listens on
`127.0.0.1:8791`, or on the port given with `--port`, and only on loopback. A
merchant's code is pointed at it with `baseUrl: "http://127.0.0.1:8791"` in
its SDK client, and every call the SDK makes then passes through it: polls,
order reads and lists, answers, deliveries, refusals and publishes. The first
lines it prints say where it listens and where it forwards, and then, one line
for each addition, what it adds and on which answers.

### The additions

Each addition is named by what it is, and the places it reaches are fixed from
the contract. The first six only inform: a reader of contract version 3 is to
leave them out, read them as `unknown` or skip them, and go on selling.

| Addition | What the caller receives | In which answers |
| --- | --- | --- |
| `field` | the field `"instrument_note":"added by the additions proxy"` at the top of the answer, inside `error` when the answer is a refusal made of `error` alone, and, in a poll, also in each envelope the gateway sent and in each event | every merchant route under `/v0/` and an agent's `GET /x402/orders/:order_id/status`; the top of an order read is closed, so an order read gets the field only inside a refusal, and a failed call that answers `ok: false` beside its `error` gets it at the top |
| `status-word` | `added_status` in place of each order's `status` | an order read, each order of a list, and an agent's status read |
| `event-kind` | a new envelope after each order and each order event of a poll, holding an event of the kind `order.added_kind` about the same order, with the envelope's own identifier followed by `.added` and its own time | polls |
| `event-reason` | `added_reason` in place of the `reason` of each event that carries one, which today is `order.unfulfilled` | polls |
| `result-word` | `added_result` in place of the `result` of a successful answer, delivery or refusal | `POST /v0/orders/:order_id/answer`, `deliver` and `refuse` |
| `quote-purpose` | `added_purpose` in place of each price question's `purpose` | polls |

The last two add to what an order delivers, which a reader is to refuse rather
than read narrowed: the poll or the read that carries one fails, and the order
stays where it was.

| Addition | What the caller receives | In which answers |
| --- | --- | --- |
| `delivery-field` | the field `"quantity":3` in each order's core | each order of a poll, an order read and each order of a list |
| `address-shape` | in place of each `ship_to` that names a place, a pickup point: `{"pickup_point":"added_pickup_point", …}` with the address's own country, state, city and postal code, and without its name, lines and phone; an erased address is left as it is | the same |

An addition reaches only an answer that carries what it changes, so a word
needs something in flight: `event-reason` needs a refused order to raise its
event, `quote-purpose` a card with a price check and a buyer asking for its
price, and `address-shape` a parcel's order before the merchant takes it on.
Additions of the two kinds are refused together, because a delivery addition
fails the very poll that would show whether the informing ones were read; they
are run in two runs. One addition can be given only once.

An addition can be narrowed to the answers whose path matches a pattern, read
as the cut proxy reads one, by writing the pattern after an `@`:
`--add status-word@/v0/orders` gives the open-orders list the new word while
an order read one by one keeps its own, and `--add 'field@/v0/orders/*/deliver'`
leaves every poll alone. A pattern with a `*` is quoted, as for the cut proxy,
or the shell expands it or refuses it before the proxy sees it. A pattern that matches none of the answers its
addition reaches is refused with the answers it does reach. A pattern that
could reach the purchase, `/x402/:item_id/purchase`, or the catalog,
`/x402/catalog`, is refused as well, as `'field@/*/*/*'` is: those answers carry
a payment's requirements and its settlement, and this proxy never rewrites
them.

### What it leaves alone

Every answer that no addition reaches is passed on as the cut proxy passes
one: the status, the headers and the body unchanged, apart from the headers
that describe the connection and the restated length. So is an answer that an
addition reaches but that carries a payment challenge or settlement in its
headers, or a 402, whatever its route; one that is not JSON, not UTF-8, not
one JSON document, or nested too deep for the proxy to walk; one encoded in a
coding the proxy does not decode, which includes a body encoded twice; and one
that holds nothing the addition changes. The log line says which of these it
was.

When an addition reaches an answer, the proxy works on the upstream's own
text. A field is inserted before the closing brace of its object, a new
envelope after the envelope it stands beside, and a word or an address shape
in place of the old value's exact bytes, so the answer the caller receives
differs from the gateway's only where the log says, and the spacing, the order
of the fields and the spelling of every number are the gateway's. An answer
that arrived compressed is decoded first and sent on uncompressed. A rewritten
answer goes without its `content-encoding`, its `etag` and any digest of its
body (`content-md5`, `digest`, `content-digest`, `repr-digest`), since they
described the bytes the gateway sent; the other headers pass as they came.

### The log

The log is one line per request on standard output: the time, a sequence
number, the method, the path without its query string, the upstream's status
and the size of its body. A line ends with what became of the answer: passed
through, passed through unchanged and why, or sent with its new size and the
additions it carried, each with the places it went to and how many times, such
as `field (envelope ×2; top), event-kind (beside the order of order ord_…)`.
As in the cut proxy, the log never prints a header, a body or a query string.
It names orders and price questions, and an order identifier is a buyer's
proof of purchase, so a log from a run against a real channel belongs with the
private evidence of that run.

### What it cannot do

It adds only to answers. What a merchant's code sends passes untouched, and so
does every answer to an agent except the order's status read: the purchase
answer an agent reads first never carries a new status word. The order
document names its own address in `status_url`, built from the address the
gateway answers as, so an agent that follows it reads the gateway directly and
meets no addition, as with the cut proxy.

It adds only what leaves the contract version where it is. A new kind of
envelope, a new card mode, a field in a price question or anything else that
moves the version, by the decision record above, is the first variant of D-08
and is met by running an older release against the gateway as it is. An
older release meets these additions with its own reader: the release before
contract version 3 reads every answer closed, so with `field` reaching every
poll it fails each poll and names the gateway's version as a remark without
ever stopping on the mismatch. Run against the gateway directly, or through
the proxy with additions that leave an empty poll alone, it stops at the first
poll with `contract_version_mismatch`.

A restart drops whatever is in flight through the proxy, a poll the gateway
holds open among them, so the merchant process is stopped before the proxy is
restarted with other additions, as with the cut proxy.

## Faulting the wallet behind the dashboard's Coinbase buttons

The dashboard's Settings page asks a merchant's Coinbase Wallet for two
things, through Coinbase's own code running in the page: an address for the
payout wallet box, under "Create or connect a Coinbase Wallet", and the payout
transaction, under "Pay out with Coinbase Wallet". Each opens Coinbase's
window, and the page waits for the window's answer. The stories of the
[manual test plan](../../docs/research/42-manual-test-plan.md) that ask what
the page does when that answer is a refusal, is malformed, never comes or
comes after the page stopped waiting cannot be played with Coinbase's real
window, which a tester cannot make misbehave on demand. This command opens a
browser on the real dashboard in which Coinbase's window is a stand-in, and the
person at the stand-in chooses each answer.

```sh
pnpm wallet-faults --dashboard http://localhost:8080/dashboard --address 0x…
```

`--dashboard` is the dashboard's address with its base path, http or https,
without a query and without a user name or password. `--address` is the EVM
address the stand-in gives as the wallet's. Give one you hold: the stand-in
only puts it in the box, but a press of Save in this browser is a real save on
that dashboard, and payouts would then go to it. The command opens Playwright's
Chromium, visibly, on the dashboard's Settings page, and runs until that tab
is closed or the command is stopped with Ctrl-C. A flag that is missing or
malformed is refused with one sentence naming it, and nothing opens; so is a
dashboard on a host of Coinbase's, which would otherwise become reachable. A
dashboard that does not answer is named in one sentence, and the browser
closes.

The Coinbase buttons are drawn only where payments settle on a chain, so a
dashboard in the sandbox has none. The local stack is in the sandbox unless it
is started with `AGENTIFY_FACILITATOR_URL` naming some other address. Name
one where nothing listens, such as `http://127.0.0.1:9/facilitator`: the
stack then calls itself TEST, the buttons are drawn, and no purchase can be
paid, which none of these stories needs. A facilitator that answers would make
purchases payable, and the gateway refuses a host of Coinbase's here without
its keys. The
payout button appears once a payout wallet is saved. The test channel's
dashboard has both buttons as it is.

The browser starts with nothing kept: no session and nothing of Coinbase's.
Sign in by asking for a link and pasting the link into this browser's address
bar; on the local stack the link is in the dashboard's log. Google's sign-in
is not available here, for the reason the next paragraph gives.

### What the browser reaches

Every request a page in this browser makes goes through one rule, except the
further hops of a redirect, which Chromium follows without asking it. A request to
the dashboard's origin, its scheme, host and port, is sent to the dashboard as
it is. A request for Coinbase's window, `https://keys.coinbase.com/connect`
with any query, never leaves the browser: it is answered with the stand-in.
Every other request, to Coinbase's other hosts, to Google, to anything at all,
is refused before it leaves, and the terminal says so once for each host. The
browser is also told that no host name but the dashboard's exists and that
no address written as numbers can be looked up, so a redirect, or anything
else that went around the rule, can reach the dashboard's host and nothing
else, without a line in the terminal. Service workers, which could otherwise
answer requests unseen, are switched off, and so is WebRTC's direct traffic,
which goes around both. The
one request that is made from the command itself rather than the browser is
the reading of Settings described below; it goes to the dashboard's Settings
address and follows no redirect.

The stand-in holds no wallet and signs nothing. The only key it makes is the
key of the encryption Coinbase's code uses between the page and its window,
made afresh for every handshake. The address it gives is the one named on the
command line, and the identifier it gives when it acknowledges a payout is
made up on the spot and names nothing on any chain. No transaction is ever
sent.

### The stand-in's window

The window opens where Coinbase's would, when one of the two buttons is
pressed. Coinbase's code in the page, `@base-org/account`, runs as the
dashboard serves it, and talks to the stand-in as it talks to Coinbase: the
window says it has loaded, the page introduces itself, the two agree a session
key in a handshake, and each request then travels encrypted under that key.
The stand-in answers the handshake and the move to the payout's chain at once,
since a person approves neither. Every other request waits for a choice: the
request for an address, which the payout button also makes before it sends
anything, and the payout itself. Each is listed in the window with its number,
its method and its session, the payout with the address it is sent from, its
chain, the contract it calls and the size of its data, and waits until a
button under it is pressed. Until then the page has been told nothing.

The buttons under a waiting request answer it in one of these ways:

| Button | What the window sends the page |
| --- | --- |
| Answer as the wallet | The address from `--address`, or for a payout an acknowledgement naming a made-up batch |
| Refuse (4001) | EIP-1193's refusal, code 4001 with the words "User rejected the request.", as a person declining does |
| Unreadable answer | The wallet's answer encrypted under a key the page does not hold |
| Answer outside the protocol | A reply to the request that carries no content at all |
| Answer in the wrong shape | A readable answer of the wrong form: the address shortened as wallets display it, its first six characters and last four around an ellipsis, or an acknowledgement naming no batch |
| Say the window closed, then answer as the wallet | The message a closing window sends, and straight after it the wallet's answer |
| Hold the answer | Nothing yet; the request stays held and offers the wallet's answer, the refusal and the closing answer, each to be sent whenever chosen |

Windows are numbered in the terminal as they open. A page uses one window for
as long as it is loaded, so a tab opens a second one only after its window was
closed or the tab loaded again, after a Save among other things. An earlier
window of the same tab still open at that moment is made to vanish, and the
terminal says so: closed in the ordinary way it would tell the new page that
its window closed, and the new page would give up on its own. Windows opened
from another tab are left alone.

Two buttons at the top act on the window itself. "Close, as a person closes
it" closes the window and tells the page that it closed. The window says so as
it unloads, so closing it by its own close box should tell the page the same
way, but only the button has been tried. "Vanish without a word" closes it
without telling the page, as a phone that drops a tab may. A request
can also simply be left waiting.

The four faults a story asks for are made this way. A refusal is "Refuse
(4001)". A malformed answer is one of the three that follow it, each failing in
a different place: the decryption, the reading of the message, and the reading
of the value. An answer that never comes is a request left waiting, or the
window vanished. An answer after the page gave up has two forms, for the two
ways the page gives up. Holding a request and pressing the same button in the
page again starts a new press, which ends the session the held request was
asked in; the held answer, sent afterwards, arrives encrypted under the key
of that ended session. "Say the window closed, then answer as the
wallet" lets the page hear that the window closed, upon which Coinbase's code
stops listening and closes the window itself, and sends the wallet's answer
just after, so it arrives at a page no longer waiting for it.

### What the terminal prints

Every line starts with the time in UTC. The window's lines say what it was
asked and what it answered, by request number. The page's lines say what the
page shows beside its buttons whenever that changes: every element the page
marks as a status, so a copy button's "Copied." appears there too.

A reading is printed a second and a half after every answer the window sends
and every closing of the window, after every press of a form on the dashboard
once its page has loaded, and whenever Enter is pressed in the terminal. It
has four lines. The first is what the page says beside its buttons, and the
second what the payout wallet box holds, both in the tab the dashboard opened
in; tabs opened by hand are not read. The third is what Coinbase's code keeps
in the dashboard's storage in this browser: the account it connected, if any,
and which of its session keys it kept, named and never shown. The fourth is
the payout wallet as the dashboard's server draws Settings when asked afresh
with this browser's cookies, with every address whole: the address saved
here and any address waiting to replace it. It says that no payout wallet is
saved only where the page offers the box under the label it has while nothing
is saved. When the answer is not Settings, because the session has ended and
the dashboard redirects to sign in, or it answers with an error, or the page
is drawn in a way the command does not recognise, the line says it was not
read and why, and never reads that as nothing saved.

The log holds addresses, which are public, request numbers and the page's own
words. It never prints a cookie, the value of a session key or the payout's
data.

### What it cannot stand in for

It covers the dashboard's one path to Coinbase Wallet in an ordinary browser,
on a computer or a phone: `@base-org/account` opening Coinbase's window. It
was written against version 2.5.13 of that code, and the window's second line,
"the page introduced itself as …", names the version the page runs. Opened
inside Coinbase Wallet's own app, the dashboard's Coinbase code uses the
wallet the app injects into the page instead, and opens no window; that path is
not imitated. Neither is a wallet other than Coinbase's: the dashboard asks
no other wallet anything, and a payout sent from one with the three values
Settings shows never passes through the page.

What the page does with each answer is real, and so is what the dashboard
records. Whether Coinbase's window ever sends such an answer, and with what
words, is not shown by this command: the refusal's words are EIP-1193's
generic ones, and whether Coinbase's window can answer after saying it closed,
or answer a new handshake while a request waits, I don't know. Coinbase's own
screens, its sign-in, passkeys and wallet creation, are not imitated at all.
The stand-in stays open between requests until it is closed; Coinbase's window
may close itself after answering, and when it does is not known here. It sends
the page no list of chains, so the move to the payout's chain reaches the
window rather than being settled in the page.

Nothing happens on a chain. An acknowledged payout sends nothing, so what the
network does with a payout, a reverted inner call among it, cannot be made
here; the page's words after an acknowledgement can be read, and the payout
contract holds what it held before. Evidence from this command is
controlled-provider evidence and is reported apart from what Coinbase's real
window did.

## Controlled Woo fault

The WooCommerce stories of the manual test plan need the shop to misbehave at
a known moment and need to show what the shop did about it: a product or
settings read that fails before a price is given, the order call whose answer
is lost after WooCommerce made the order, the connector stopped just before it
makes a chosen order while somebody changes the rate, and a shop order whose
total is a unit away from what was paid. The controlled Woo fault does this
from outside the product. It is the TLS edge of a local copy of the lab shop:
the dashboard's connector reaches the shop through it, so it can fail a chosen
request, hold the request that would create a chosen order until it is
released by that order's identifier, and add a fee line to a chosen order on
its way to the shop. The lab's `./lab.sh orders` counts the copy's orders and
names the ones that carry an Agentify order, which is how a run shows whether
WooCommerce made an order.

It works only against a copy of the lab on the organiser's own machine. The
shared lab on the fixture host is never behind it. The stack's application
resolves the shared lab's public name to the edge as well, whose certificate
names only the two .test names, so the connector refuses it and a merchant who
types the shared lab's address into the local dashboard reaches nothing.

### How the connector reaches it

The connector talks to a shop only at an https address whose name resolves to
public internet addresses, and it checks the shop's certificate; a proxy on
the loopback or a private Docker address is refused before a byte is sent, and
the connector honours no proxy setting. Nothing in the product was changed to
let the instrument in. Instead, [`woo-fault/stack.yaml`](woo-fault/stack.yaml),
laid over the root `compose.yaml`, gives the stack a network of its own,
`instr-woo-edge`, on 192.175.48.0/24. That range is public: the AS112 project
uses it to answer stray reverse lookups, and nothing in the stack asks it
anything. A range set aside for documentation or testing would be the natural
choice and cannot be used: the connector refuses 192.0.2.0/24, 198.51.100.0/24,
203.0.113.0/24 and 198.18.0.0/15 together with the private, loopback, shared
and link-local ranges, so the shop has to sit at an address that is ordinary
public space. The edge holds 192.175.48.10 on that network, the application's
container resolves the shop's name to that address, and Node trusts the run's
own certificate authority through `NODE_EXTRA_CA_CERTS`, which Node reads at
start-up. No route or trust store on the machine itself changes.

The shop is called `shop.woo-fault.test` and the dashboard
`agentify.woo-fault.test`. No public resolver answers a name ending in
`.test`, so a client the stack does not wire, such as the organiser's ordinary
browser or a container of another stack, fails to resolve the shop instead of
reaching a real one, and the edge refuses to start with names that do not end
in `.test`. The dashboard's address is https too, because the dashboard
connects a shop only from an https address and WooCommerce posts the shop's
keys only to one; the local copy of the lab resolves the dashboard's name to
the same edge. The edge sends every request for the dashboard's name to the
stack untouched: under `/dashboard` to the dashboard, everything else to the
gateway. It never fails, holds or logs those.

### Starting the stack and the copy

The certificates come first. `certs.sh` makes a new directory holding a
certificate authority for this run and the edge's certificate for both names,
and deletes the authority's key as soon as that one certificate is signed:

```sh
packages/slice/woo-fault/certs.sh "$HOME/woo-fault-run/certs"
export WOO_FAULT_DIR="$HOME/woo-fault-run/certs"
```

The stack is the root `compose.yaml` with the instrument's file laid over it.
It runs as the Compose project `instr-woo-fault`, builds its own image under
the name `instr-woo-app`, and publishes only on 127.0.0.1: the gateway on
18620, the edge's TLS on 18621, the edge's control commands on 18622 and
Postgres on 18623. Every Compose command on it names both files and the
run's certificate directory, and runs from the repository's root:
`-p instr-woo-fault` alone would read the root `compose.yaml` there, which
knows nothing of the edge, so a `down` would leave the edge running. A shell
function keeps that short, and is defined again in every terminal of the run:

```sh
woo_stack() {
  WOO_FAULT_DIR="$HOME/woo-fault-run/certs" \
    docker compose -f compose.yaml -f packages/slice/woo-fault/stack.yaml "$@"
}
woo_stack up -d --build --wait postgres migrate app woo-fault
```

The scanner, the documentation and the stand's mock merchant are not
started.

Then the lab copy, from the [lab README](../../deploy/woocommerce-lab/README.md)'s
"A local copy behind the controlled Woo fault", which needs the stack's
network to exist and so starts after it. A copy is wired to this edge and to
nothing else.

A browser reaches both names through the edge's published port. A Chromium
started with a profile of its own for the run, given

```
--user-data-dir=$HOME/woo-fault-run/browser
--host-resolver-rules="MAP shop.woo-fault.test 127.0.0.1:18621, MAP agentify.woo-fault.test 127.0.0.1:18621"
```

opens `https://agentify.woo-fault.test/dashboard/sign-in`. It does not know
the run's authority, so it warns about the certificate on each name once; the
run's own profile keeps that exception to itself. Sign-in links are in the
application's log, `woo_stack logs app`. The
dashboard's pages there lack the site's fonts and mark, which the stack's web
server would serve and this stack does not run.

From there the merchant connects `https://shop.woo-fault.test` as a merchant
connects any shop: the browser goes to the copy's approval screen, the copy's
administrator signs in with the password in the copy's `.env`, and WooCommerce
posts the keys back to the dashboard through the edge.

A purchase's card names the dashboard's https address for the purchase and
for the order's status, which only the run's network resolves and only the
run's authority vouches for, so the buyer runs inside the edge's container,
which has both:

```sh
woo_stack exec -e GATEWAY_URL=https://agentify.woo-fault.test woo-fault pnpm buy '<card name or id>'
```

### Another instrument on the same stack

The stack and the copy are not this instrument's alone: any run that needs
the local dashboard to sell from a local lab shop, in any profile, rupiah
included, connects it the same way and need not arm a fault. Another overlay
of the root `compose.yaml` joins by being named before this one, so that this
file's project name and the application's settings below win, and every
Compose command of the run then names all three files. For the dashboard's
outbound faults, whose overlay is `packages/slice/outbound/compose.yaml`:

```sh
woo_stack() {
  WOO_FAULT_DIR="$HOME/woo-fault-run/certs" AGENTIFY_APP_IMAGE=instr-woo-app \
    AGENTIFY_OUTBOUND_PORT=18624 docker compose -f compose.yaml \
    -f packages/slice/outbound/compose.yaml -f packages/slice/woo-fault/stack.yaml "$@"
}
woo_stack up -d --build --wait postgres migrate app woo-fault outbound outbound-tls
```

The outbound stand-in then listens on 127.0.0.1:18624 and shares the image. Node in the application reads one file
of extra authorities, once, as it starts, and this file names `trust.pem` in
the run's certificate directory, which `certs.sh` starts with the run's own
authority. An instrument with an authority of its own appends it there and
restarts the application; for the outbound stand-in, once its front has made
its authority on the first start:

```sh
woo_stack cp outbound-tls:/outbound-ca/root.crt "$WOO_FAULT_DIR/outbound-root.crt"
cat "$WOO_FAULT_DIR/outbound-root.crt" >>"$WOO_FAULT_DIR/trust.pem"
woo_stack restart app
```

### The commands

The control commands run from the repository's root and are posted to the
edge on 127.0.0.1:18622, or to the address in `WOO_FAULT_CONTROL`. Each prints
one sentence saying what it armed or why it armed nothing, and exits 1 when it
armed nothing. Nothing is armed when the edge starts, and what is armed lives
in the edge's memory: restarting the `woo-fault` service disarms everything
and drops whatever is in flight through it.

```sh
pnpm woo-fault status
pnpm woo-fault fail --method GET --path '/wp-json/wc/v3/products/*' --fault 503 [--count 3|all]
pnpm woo-fault hold --next | --order <Agentify order id>
pnpm woo-fault release --order <Agentify order id>
pnpm woo-fault shift --next | --order <Agentify order id> --by 1
pnpm woo-fault clear
```

`fail` names a method in capitals, a path pattern and a fault. The pattern is
matched against the whole path without its query string, quoted so that the
shell leaves it alone; `*` stands for any run of characters within one path
segment and `**` for any run across segments. The connector reads a product at
`/wp-json/wc/v3/products/<id>` and several at `/wp-json/wc/v3/products`, the
shop's settings at `/wp-json/wc/v3/settings/general`, `/wp-json/wc/v3/settings/tax`
and the paths under `/wp-json/wc/v3/settings/*/*`, the public catalogue at
`/wp-json/wc/store/v1/products`, a parcel's cart at
`/wp-json/wc/store/v1/cart` and the paths under `/wp-json/wc/store/v1/cart/*`,
creates a shop order with `POST /wp-json/wc/v3/orders`, and reads one back at
`/wp-json/wc/v3/orders/<id>` and its shipments under
`/wp-json/wc/v3/orders/<id>/fulfillments`. Pressing Connect asks for
`/wc-auth/v1/authorize`, and a buyer's download is
`/?download_file=…`, served from the path `/`. The rule fails the
next matching request, or the next `--count` of them, or every one until
`clear` with `--count all`. Several rules may be armed at once, and the first
armed that matches a request is the one that fails it. The copy's own
scheduled calls, WP-Cron at `/wp-cron.php` and WooCommerce's background work
under `/wp-admin/`, reach the shop through the edge as well, so a broad
pattern such as `/**` with a count can be spent on one of them; patterns under
`/wp-json/wc/` meet only the connector's and a browser's requests. A cut whose
request could not reach the copy at all cut nothing and stays armed.

The fault decides where the request ends:

- A status from 400 to 599 is answered by the edge with that status and a
  WordPress-shaped error whose code is `woo_fault`; the shop never sees the
  request.
- `malformed` is answered by the edge with a 200 whose JSON document breaks
  off midway; the shop never sees the request.
- `drop` closes the connection with no answer at all, which the connector
  meets as a shop that went away; the shop never sees the request.
- `cut` sends the request to the shop, reads the shop's whole answer and then
  closes the connection without writing a byte of it. For an order call that
  means WooCommerce made the order and the connector never learned of it.

`hold` arms a hold for the request that creates the shop order of one
Agentify order, given with `--order`, or, with `--next`, for whichever order
the next such request names; `status` then names the order it caught. A held
request waits at the edge and the shop does not see it until `release --order`
names that order. While a hold is armed it catches every request creating that
order. A release sends on each one whose caller is still waiting and disarms
the hold; a request whose caller gave up while it was held is never sent, so a
release cannot make an order that nobody is waiting for. A held request then
meets any `fail` rule armed for it, as any other request would.

`shift` adds one fee line, named "Controlled Woo fault: total shifted by …",
to the request creating the chosen order, or the next order with `--next`, so
that the order WooCommerce records totals the amount the connector sent plus
the shift. The amount is in the shop's currency, written with a dot and
without separators, and may be negative: `--by 1` and `--by -2` on the rupiah
shop, `--by 0.01` on the dollar shop. A positive fee is untaxed, so the
order's tax stays as it would have been. WooCommerce taxes a negative fee
whatever the line says, so on a shop that calculates tax a negative shift also
lowers the order's tax and can move its total by more than the amount: on the
hard profile `--by -1` gave a total one rupiah lower and 0.11 rupiah less tax.
Read the order with `./lab.sh orders` before taking its total as the shift. A shift is spent on the first request it
changes, and is applied only to a request that is sent to the shop. To shift
an order whose identifier is not known in advance, hold it with `--next`, read
its identifier from `status`, arm the shift with `--order` and release it.

`clear` disarms every failure, every shift and every hold with no request
still waiting at it; a hold with a request waiting stays until it is
released, and one whose callers all gave up is disarmed without sending them.

### What a hold meets

The connector gives an order call fifteen seconds from the moment it sends
it, and the shop's own work on the order counts against them. A request held
past that loses its caller, and the connector treats the call as one whose
outcome it cannot know: it keeps its record that it tried, and from then on
answers that order as unknown rather than calling the shop again. Releasing
it afterwards sends nothing, as above, but a release that comes so late that
the shop's answer misses the fifteen seconds sends the order to a caller that
then gives up, and WooCommerce makes an order the connector never learns of.
A story that changes something while an order is held, such as saving a rate,
does it and releases with seconds to spare; on the lab copy a hold of three
seconds, during which a rate was saved, left the shop four tenths of a second
of work. Saving a rate runs an import through the edge too, which a hold does
not stop, and a release need not wait for it. The calls made while Connect is
pressed give up after ten seconds, but nothing holds them.

While its order call is held, the gateway may hand the same order to the
dashboard again. The connector meets its own record of the call in progress
and answers that repeat by its rules; which answer it gives is what the story
reads, and the edge's log and `status` show how many requests to create that
order arrived and how many went on to the shop.

### The log and the evidence of an order

The edge's log is the stack's log of the `woo-fault` service:

```sh
docker compose -p instr-woo-fault logs -f woo-fault
```

It has one line for every request to the shop, and more for one that is held
and released: the time, a sequence number, the method, the path without its
query string, for an order call the Agentify order it creates, and what
happened. A request that reached the shop says so with the shop's status and
size, and for an order call the shop order its answer named. A request the
edge answered or closed says that the shop never saw it, and so does one the
edge could not deliver because the copy did not accept the connection; such a
request is not counted as sent and spends no shift. A cut says both that
the shop answered and that the caller got nothing. The log never prints a
header, a body or a query string, because the connector's keys travel in
headers and an order's body carries the merchant's address and the buyer's
delivery address. Agentify order identifiers do appear, and as with the cut
proxy's log, a log from a run belongs with that run's private evidence. In a
copy of the lab the edge's log is also the shop's request log: the copy's
Caddy only stands in for `lab.sh`, so `./lab.sh requests` there shows nothing.

`status` adds, for every Agentify order an order call has named, how many
such calls arrived at the edge and how many were sent on to the shop. The
shop's own answer is `./lab.sh orders <Agentify order id>` in the copy, which
reads the orders through WooCommerce and lists every one that carries the
identifier, with its status, total and fee lines; it exits 3 when none does,
and fails with a sentence when the shop could not be asked. Without an
identifier it counts the shop's orders by status. A story proves that
WooCommerce made an order by both: the edge's line saying the shop answered
the call, and the order in the shop.

### What it cannot do

It fails a request by its method and path alone, so it cannot fail the read of
one product while passing the read of another with the same pattern, beyond
the order of arrival. It does not change what the shop answers: a product or
setting answered with another object's identifier, a public price that differs
from the authenticated one, or a challenge page from bot protection, which
H-09 and H-17 ask for, are not among its faults. A shift changes an order on
its way into the shop and cannot change an order the shop already holds. It
fronts a local copy only, so the stories it serves run on the local stack's
sandbox facilitator, which accepts pretend payments and proves nothing about
settlement. And it holds nothing but the shop's side: a stand-in for a merchant
that stops at a moment, or a lost gateway answer, is the stand's and the cut
proxy's.

### Stopping

The copy goes first, because it is attached to the stack's network, and then
the stack with its volumes. The copy keeps its profiles in its data directory
until that is deleted too.

```sh
(cd <the copy> && docker compose --profile realistic down)
woo_stack down -v
```
