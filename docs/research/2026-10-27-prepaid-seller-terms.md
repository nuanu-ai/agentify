# ENG07: merchant terms before a prepaid purchase

Date: 2026-10-27. The product owner approves requiring the existing shop site
for asynchronous purchases, together with buyer instructions about payment
timing. A separate machine-readable settlement and remedy policy is deferred.
ADR-0034 records the rule.

An `async` or `ship` card requires `seller_site` to be published. An existing
card without it leaves the catalogue and refuses both a discovery probe and a
new purchase. No order is opened and no price question reaches the merchant.
The same check runs before verifying the first payment for a previously quoted
prepaid order. Both SDK and WooCommerce cards use this admission rule. Giving
the site restores eligibility without republishing; a merchant's own pause is
preserved. Publication reports the existing `no_seller_site` finding and names
the existing setting call. Purchase refusal uses the existing `not_selling`
code with an explanation that nothing was charged.

Already paid orders continue to fulfillment and can be recovered. Payments
accepted for execution, including those whose outcome remains unknown, keep
their existing handling. A synchronous card may sell without a site. The site
remains nullable on public cards and order statuses because synchronous sales
and historical orders can legitimately lack one.

The buyer instructions in `llms.txt` explain that synchronous purchases charge
after goods reach Agentify, while asynchronous purchases and parcels charge
before delivery or shipment. They direct the buyer to the merchant's
cancellation, refund and support terms before authorizing payment. Missing
terms remain unknown. A syntactically valid site proves neither ownership nor
the presence or quality of a policy, and Agentify does not confirm refunds.
Requiring the site therefore does not establish machine-verifiable remedies.

The smaller choice reuses one merchant setting and its public `seller.site`.
There are no new API fields, error codes, client namespaces, database columns
or contract-version changes. Merchant docs, the SDK README and published
finding descriptions state which cards need it. A patch changeset records
those package documentation changes. Local example merchants explicitly set
their own fixture site; production merchant seeding does not invent one.

The new HTTP cases cover missing-site publication, combined card findings,
legacy catalogue and probe behavior through both integrations, restoration
after setting a site, a synchronous sale without one, first-payment refusal,
paid recovery with delivery and an unresolved payment. Existing tests for
missing sites request that state explicitly; ordinary ready-merchant fixtures
provide one. A separate purchase walk builds its own gateway without the
shared harness, first sees async publication refused, sets the site through
HTTP, and completes the purchase.

Four applied mutations are killed: allow publication without a site; omit the
catalogue and purchase check; omit the first-payment check; and incorrectly
apply that check to paid and unresolved recovery. The source is restored byte
for byte after each. An independent static reviewer finds no blocking issues;
two obsolete descriptions are corrected. The reviewer does not run tests.

The final offline run passes 7429 tests in 381 files and 14 operational-script
checks. The separate PostgreSQL 17 run passes 583 tests in 26 files against a
new disposable loopback database. Settings presentation passes 101 tests after
its wording update. Repository-wide types, changed-source formatting, decision
and retired-claim checks, unused-code checks and portal build/render checks
pass on Node 24.22.1. The portal render check finds all seven included examples
and programs. No chain funds are spent and no deployment tag moves. TEST and
production do not run this change yet.

Private raw outputs are kept in `2026-10-27-eng07-jaonlcte` under the operator's
Agentify acceptance directory.

## Draft reply for ENG07

We require a shop site for asynchronous products as well as parcels and tell
buyers when payment precedes delivery. Existing cards without a site stop
taking new purchases until the merchant supplies one; already paid orders
continue. Before paying, buyers are directed to the merchant's cancellation,
refund and support terms there. We are deferring a separate structured policy
contract: it would add fields and promises for every merchant integration,
while the existing site provides a place to read those terms. We do not claim
that a site guarantees a remedy, or that Agentify verifies a refund.
