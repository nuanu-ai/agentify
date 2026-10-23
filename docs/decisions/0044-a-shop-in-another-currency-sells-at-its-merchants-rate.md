# 0044. A WooCommerce shop priced in another currency sells at a rate its merchant sets

Date: 2026-10-21
Status: accepted; the merchant's own rate with Coinbase's beside it, the kept
history, the shop's currency read from the shop, the scope of currencies and
the one-unit match read in the shop's currency are the product owner's word of
2026-10-21; a rate keeps when its saving session signed in rather than an
address, revised 2026-10-23 (the product owner); the mechanics below are the
proposal's
([research 58](../research/58-woo-shop-currency.md)).

## Context

Agentify charges in US dollars paid as USDC, and every public contract carries
dollars alone. Most Indonesian WooCommerce shops price in rupiah, written with
no decimals, and the currency was the only thing keeping nine of the 29 the
census measured from connecting ([research 55](../research/55-woo-shop-census.md)).

## Decision

A connected shop priced in another currency than US dollars sells at a rate its
merchant sets in the connector's settings: how many units of the shop's currency
one US dollar buys. The currency is the shop's own setting, read from the shop
and never chosen by the merchant; a dollar shop is asked for no rate. The scope
is any currency Coinbase's public exchange-rates endpoint gives a rate for,
written by the shop at no decimals or two. Connect refuses any other in plain
words, and asks again when Coinbase does not answer, which says nothing about
the currency.

Every saved rate is a row added to `dashboard_woo_rates`, never edited or
removed: the account and the shop origin it belongs to, the currency, the rate
as a decimal of at most six places, when it was saved and when the session that
saved it signed in (nothing, where that is not recorded), Coinbase's rate as Agentify read it while saving, with
that moment (or nothing, where none could be read), and whether it was typed a
second time because it stood more than a tenth from that reference. Its version
rises with every row; a shop's current rate for a currency is its highest. A
rate is written only after a notice of it, with the rate before it, has been
handed to the mail for the account's address. Coinbase is read on the screen
and at Connect, never while a buyer waits; it catches a mistyped rate and
prices nothing. No address is kept or shown as who saved a rate: every session
of the account carries the account's address, a stolen one included, so an
address would read as proof of who did it while proving nothing. The screen
and the notice give the moment the rate was entered and when its session
signed in, and say that such a moment does not prove it was the owner.

A price converts the shop's own amount, a product's or a cart's total, once at
the current rate, with no request made for it, rounded up to the cent, so the
buyer pays at most a cent over the exact conversion. Its `price_id` binds the
amount in the shop's currency, the dollars answered and the rate version. A
shop with no rate for its current currency has no price, so a currency changed
in the shop stops its sales before payment until a rate for the new one is set.
The paid order is held to what was bound, whatever the rate is by then, because
the buyer has paid at it: the shop's order is made in the shop's currency at the
bound amount and taken on at it or one of its smallest written units either
side, a cent or a rupiah, which is ADR-0041's one cent read in the shop's
currency (the product owner, 2026-10-21). The connector's record of the sale
and the shop order's metadata carry the shop's amount, the USDC paid, the rate
and its version.

The buyer is told a price in US dollars and nothing more: cards, price answers
and receipts are unchanged, and so are the SDK and the public contracts. The
merchant's Orders screen shows the shop's amount and the rate the buyer paid
at. Agentify takes no currency margin; its commission is of the USDC paid.

## Alternatives rejected

A market rate read at purchase, from Bank Indonesia's JISDOR, the European
Central Bank, a Chainlink feed or an exchange such as Indodax: each source's
outage or error becomes a stopped or wrong sale, the test channel cannot
exercise the feed on Base, and the gap between a mid-market rate and what the
merchant gets for USDC is left to whoever chose the source. A currency setting
the merchant chooses, which can disagree with what the shop charges. A price in
dollars per product, which the shop has no field for and the merchant would
keep beside every rupiah price. A currency in the public contract, or a
conversion in the gateway, which every integrator would learn for one kind of
shop. A rate changed after a quote refused like a changed product, which would
leave a paid order unfulfilled for a routine edit made seconds before it.
