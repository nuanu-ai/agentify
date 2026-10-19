# @agentify/slice

This package is the repository's own test equipment, not a product surface:
nothing in it is published, and no merchant or agent ever runs it. It holds the
mock merchant and the buyer behind the offline gate, the `buy` and `smoke`
commands, the stand, and the proxy described below, all of which drive the
real gateway and the real SDK from the outside so that a test sees what a
merchant or an agent would.

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
