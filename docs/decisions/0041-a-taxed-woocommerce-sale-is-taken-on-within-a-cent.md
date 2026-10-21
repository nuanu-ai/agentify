# 0041. A sale from a WooCommerce shop that calculates tax is priced by the shop and taken on within a cent

Date: 2026-10-21
Status: accepted; selling from shops that calculate tax at all, where it is
clear what to do, is the product owner's word of 2026-10-21, and so is the
one-cent match.

## Context

The WooCommerce connector (ADR-0023) quotes an agent a fixed price and, once it
is paid, creates one paid order in the shop that must charge what was paid. Tax
is a setting of the whole shop, so refusing shops with tax on leaves out most
shops that charge it. A probe of a shop with tax on
([research 56](../research/56-woo-tax-probe.md)) found that an order line naming
only the product lets WooCommerce split the tax out of a gross price exactly,
that the Store API cart quotes what the order made for it then charges, and that
a download's order, which has no address, is taxed at the shop's own address.

A review of the connector built on it found five ways for the two to part, one
class: the order made through `wc/v3` and the cart that priced it compute
shipping and tax with different arithmetic, and the cart does not show where. A
half cent of tax rounded per line, a compound rate on a parcel and on a
download, and a shipping cost finer than a cent each came to a cent; one gross
price kept by a filter behind a single tax total moved a parcel to another
country's rate and came to seventeen cents.

## Decision

A shop's tax is off or calculated by WooCommerce itself; tax from an outside
service is not sold from. Where WooCommerce calculates tax, a download sells
only where prices are entered including tax, at its price, and its order records
the tax of the shop's own address inside that price. A parcel sells at its
cart's total for the locality, goods, cheapest rate and tax together, only where
tax is based on the shipping address; where prices include tax, only to a
locality whose cart taxes the goods as a cart at the shop's own address does,
since a filter no outside reader sees can keep one gross price that the order
does not. Either sells only where tax is rounded at the subtotal, because
rounded per line a cart and its order can round a half cent of tax apart. A shop
whose catalogue shows prices otherwise than they are entered is not sold from,
because the import reads the price as shown and a buyer pays it as entered.

An order from any shop, tax on or off, is taken on when its total is what was
paid or within one cent of it, either way (the product owner, 2026-10-21). The
difference is recorded on the shop's order, which carries what was paid beside
its own total, and in the connector's record of the sale, which the merchant's
Orders screen reads. An order further from what was paid is not taken on. A
taxed order's tax is recorded as the shop wrote it, and with tax off an order's
tax must be nothing.

## Consequences

A merchant may have to change a setting that applies to every customer, rounding
above all, and the guide (`apps/docs/woocommerce.md`) says what each change
does; a shop's books can differ by a recorded cent from the USDC received.

Rejected: order lines carrying amounts before tax that the connector computes,
which at two decimals miss the price by a cent and at six need the shop's rate
read beforehand; a quote with no address for a download whose prices are entered
before tax, which matches its order but charges every buyer the tax of the
shop's own city; predicting the half cent from the cart, which a compound rate
defeats because the cart's tax lines do not say which rate is compound; and
withdrawing parcels from shops that calculate tax, which would refuse them all
for cases that come to a cent: a small inaccuracy is no reason to stop selling
them (the product owner, 2026-10-21). Two ways that would close the class rather than
bound it, having the shop's own Store API checkout build the order from the cart
it priced, or creating the order unpaid and marking it paid only once its total
matches, are not taken now; research 56 keeps them as directions for later.
