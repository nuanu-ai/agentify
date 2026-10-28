# ENG04: purchase response cache protection

Date: 2026-10-27. The product owner approves extending the status route's
`Cache-Control: no-store` policy to purchase and recovery replies. A purchase
reply can carry the buyer's private order address and goods. The report shows
an absent header, not a cache leak.

The purchase handler sets the header once on entry. Its responses keep the
same policy while pricing a purchase, returning goods, reporting an unfinished
or closed order, recovering an earlier answer or refusing a request. Discovery
probes on the purchase address also receive the header. This changes no JSON
fields, payment logic, database schema or SDK package.

Four checks first fail on the missing header: synchronous purchase,
asynchronous purchase, an order-bearing refusal and recovery of a closed paid
order. The successful purchase checks also exercise recovery with a fresh
signature, preserve the order and show one verification and one charge.
The full gateway HTTP suite passes 507 tests in 18 files on Node 24.22.1.
Gateway type checking and formatting of the changed files pass.

A temporary mutation removes the purchase header and is killed by the
synchronous and asynchronous purchase checks. The source is restored byte for
byte and the three affected suites pass 75 tests again. No mutation survives
or fails to apply.

A separate Node run uses the unchanged buyer example, a real loopback HTTP
server and the merchant SDK, with the gateway's memory adapters and scripted
facilitator. It checks `no-store` on eight purchase-route responses, loses the
first paid answer, recovers the same order without another settlement and
makes an intentional second purchase with a different file. GET and empty
POST probes return 402 without creating an order. An unknown product returns
404 with the header. No chain or external merchant is contacted.

The implementation is on the follow-up branch and is not deployed to TEST or
production. The check establishes the outgoing header and preserved purchase
behavior; it does not establish how every external cache handles directives.
