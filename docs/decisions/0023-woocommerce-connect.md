# 0023. A connected WooCommerce shop is a credential we hold and fulfill with

Date: 2026-09-14
Status: accepted; equal terms with the SDK (the product owner, 2026-10-11), one
integration at a time (ADR-0036), every channel (2026-10-26). Cart retirement,
separate paid resources and at most one replacement per shop per ten minutes
are the product owner's decision of 2026-10-28.

## Context

Stock WooCommerce can grant a key, read products, create orders, grant protected downloads and
calculate shipping without a browser. Connecting a shop gives us its write credential and a duty to
deliver actual goods, not an order number. Research: [Connect](../research/33-woo-connect-probe.md),
[parcels](../research/41-woo-parcel-probe.md), [resource
bounds](../research/90-unpaid-price-questions-design.md).

## Decision

The dashboard keeps the issued shop key and secret on the merchant's account, never in a screen
response. This protects against the network, not the host; the shop owner can revoke access. A
callback consumes only the latest Connect, within fifteen minutes, for its recorded root origin.
Requests use that checked, pinned public address, TLS host verification and no off-shop redirects.

The merchant guide defines the imported simple products and safe shop settings. Other products are
named and skipped. Each purchase gets an offer; successful product reads may be cached for five
seconds and settings for three minutes. The generic authenticated `quote_reference` carries
product/settings and pricing facts without a quote ledger. Fulfillment compares fresh shop data with
them. A virtual download has one non-public file on the shop origin, unlimited safe download
permission and an async card. Its permission URL is a bearer secret.

A physical parcel uses enabled shipping not forced to the billing address and ships within seven
days, Agentify's constant (the owner, 2026-10-09; ADR-0033). The price includes the cheapest cart
rate for the locality; no rate means no price. The chosen rate is not retained with the offer:
fulfillment asks again and matches what was paid before creating the shop order. Acceptance requires
the shop to return the address as sent; Completed records shipment. The full address is neither
logged nor retained afterward. Tax and one-cent matching follow ADR-0041; merchant conversion rates
follow ADR-0044.

Engineering choice: four handlers, with two carts per inclusive-tax calculation, require eight paid
and eight free slots per shop origin. Paid bundles are reserved before polling; a capacity wait
spends no fulfillment attempt. Free cleanup cannot borrow paid carts. Idle tokens are encrypted
under a key derived from the dashboard's existing authentication secret; budgets, slot entitlements
and ownership survive restart and reconnect. Stale owners cannot modify them.

A doubtful identity is permanently retired. Its replacement, including a failed or tokenless
opening, spends the shared ten-minute creation permission first. With standard two-day guest
sessions, the bound is the pool plus about 288 replacements (about 304 unexpired sessions). Expired
SQL rows may await the shop's cleanup; its actual purge timing is unverified. No new merchant
setting or SDK worker option is introduced. Account credentials and caches stay separate.

The connector runs beside the gateway; live publication requires ordinary merchant approval. One
paid shop-order ledger advances from precreate_refused to create_unknown before the request, then to
placed only on a correlated answer. Unknown creation is never resent automatically. Placed downloads
return stored goods; parcels are followed until shipment or closure. Merchant recovery may retry a
pre-create download refusal once after reconnect, while unfulfilled and still eligible. Unknown
creation requires a merchant-supplied shop order, matched on all sale facts. Parcels cannot recover
an erased address (ADR-0032).

## Consequences and alternatives

Shop customer mail uses the merchant's dashboard email; buyer email policy remains open. No staffed
recovery queue is required. Rejected: our own plugin, raw file URLs or order numbers as goods,
inferred absence after unknown create, shop credentials in the gateway, retained shipping-rate
columns and zone logic of our own. Permanent exhaustion after a transient cart failure is rejected;
reusing an identity whose mutation is unknown is unsafe.
