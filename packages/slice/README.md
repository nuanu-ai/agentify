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
which is put in front of every path the caller asks for. It is refused if it
carries a user name or a password, since the caller's own credentials travel
in its headers and the proxy passes those on as they are. The proxy listens on
`127.0.0.1:8788`, or on the port given with `--port`, and only on loopback. The
caller is then pointed at the proxy instead of the gateway: the buyer with
`GATEWAY_URL=http://127.0.0.1:8788 pnpm buy`, a merchant's code with
`baseUrl: "http://127.0.0.1:8788"` in its SDK client. The pattern is quoted so
that the shell does not expand the `*`. The first line the proxy prints says
where it listens, where it forwards and which answer it will cut; a malformed or
missing flag is refused with one sentence naming the flag, and the command then
exits without listening.

The rule names a method, a path pattern and a phase. The method is matched
exactly and is written in capitals. The pattern is matched against the whole
path without its query string, and `*` stands for any run of characters within
one path segment. A buyer's purchase of any product is `POST /x402/*/purchase`;
the SDK's answer for a handler's result on any order is `POST
/v0/orders/*/answer`, and a merchant's delivery and refusal are the same path
ending in `deliver` and `refuse`; a publish is `POST /v0/catalog/publish`. The
other routes are listed in
[`packages/contracts/src/api.ts`](../contracts/src/api.ts).

Only an answer the gateway gave with a 2xx status counts, because a refusal is
not a commitment. The unpaid first call of a purchase is answered with a 402
challenge; it passes through untouched and is not counted, which is why the
rule above cuts the paid answer that follows it and not the challenge. `--nth`
picks which counted answer is cut, the first by default. Three other answers
pass without being counted, and the log says why each time: an answer shorter
than two bytes, which has no middle to cut midway; an answer whose caller had
already left by the time it was complete, since nobody would see the cut; and
an upstream that could not be reached or broke off its answer, which the
caller receives as a 502 naming the upstream and the network code.

The phase decides what the caller sees. With `before-headers` the proxy writes
nothing and closes the connection, so the caller has no status at all; curl
reports an empty reply from the server. With `mid-body` it writes the status
and the headers, with a content length that promises the whole body, then half
of the body, and closes the connection once those bytes are sent; curl reports
the transfer closed with bytes remaining. A rule cuts once. After the cut, the
proxy passes everything through, as it does for every request the rule does
not match, with the status, the headers and the body unchanged except that the
headers describing the connection are dropped and the length is restated.

The log is one line per request on standard output: the time, a sequence
number, the method, the path without its query string, the upstream's status,
the size of the body, and the order a JSON answer names in a top-level
`order_id`. The line for the cut adds the phase and how many body bytes reached
the caller, and the line after it says that the rule is spent. The log never
prints a header, a body or a query string, because merchant keys and payment
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

### The two pause points

The pause is set on the Orders tab, in the Paused panel. It is kept in memory,
starts as "Do not pause" every time the stand starts, and applies to every
arrival from the moment it is set, repeats included. Turning it off releases
nothing already paused.

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

The stand answers every post with a redirect for the browser, and the body of
that redirect carries what the stand said back, so curl prints either that the
order was released or why nothing was. An identifier that is not paused at this
stand releases nothing and is answered in those words.

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
it, and a record already written stays.

### What a long pause meets

Three clocks run while an order is paused, and a pause outlasts all of them.
The gateway waits about three seconds for one hand-over before sending the
order again; a synchronous order's goods are due ten seconds after the payment;
and the agent is promised an answer within twenty. While a stand's handler is
paused, that stand takes nothing else, because the SDK hands orders to its
handler one at a time. The repeat therefore goes to another stand of the same
merchant if one is polling. With none, it waits behind the paused order, and
the gateway does not hand out an order that has moved on since its repeat was
queued, so once the released answer has closed the order nothing more arrives.
Every repeat counts toward the order's attempts, and an order is sent again
only while it has attempts left and its deadline allows.

A synchronous order paused past its ten seconds is over by the time it is
released, and its late answer is told that the purchase has closed. An
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
