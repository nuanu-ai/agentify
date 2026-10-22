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
