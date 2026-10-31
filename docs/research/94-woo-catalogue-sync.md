# How a connected WooCommerce shop is checked and synchronized

This note describes how the dashboard reads a connected WooCommerce shop's
products after the merchant connects it, how it publishes them as Agentify
cards, and when it takes a published card off sale. The decision it serves is
[ADR-0023](../decisions/0023-woocommerce-connect.md), which keeps the rule that
only the shop's own direct answer about a product withdraws its card; this note
holds the mechanics, which change more freely than the rule. The merchant's
side of the same behaviour is in the WooCommerce guide
(`apps/docs/woocommerce.md`).

## Jobs

The dashboard does this work in jobs it stores in its own database. A check
reads the shop and sorts its products into groups without publishing anything;
a publication, which the screen calls a sync, reads the shop the same way and
publishes or withdraws cards as it goes. A merchant has at most one job queued
or running at a time, which the database enforces, and a request made while
another job runs is answered with that job. Finished jobs are kept, one of each
kind per merchant, so the Products screen can show the latest result after the
merchant leaves and comes back.

Four workers in the dashboard process take queued jobs in the order they were
asked for. A worker owns the job it took through a database session of its own,
with a session advisory lock on the job; if that session dies, the worker's
writes stop landing, and recovery, which runs at start and every thirty
seconds, marks a running job whose owner is gone as interrupted. A job that
stops before it finishes keeps every product it recorded, and the rest stays
unknown.

The same recovery round also asks for a check of every shop connected with
read and write access that has no job for its current connection yet, unless
the merchant already has one running. That covers a renewed grant or a first
exchange rate saved while another job was running, and it means that the first
start after this feature reaches a channel checks each shop already connected
there once, in the background. A connection is checked once per grant; a check
that stopped for a missing exchange rate is asked for again when the rate
appears.

## Reading the catalogue

A job reads the shop's protected REST list of published products,
`wc/v3/products?status=publish`, a hundred to a page in order of id, together
with the shop settings every product is judged by. It counts published products
because the estimate shown before connecting counts the public Store API list,
which is published products too. The two differ in one case: a shop set to hide
out-of-stock products leaves them out of its public list, while the job still
reads them. Drafts, pending and private products are not read; a published card
whose product is no longer published is reached through its own read, described
below.

The shop's count of published products comes in a header on each page. A job
reads at most 2,000 products and stops with "Your shop has more than 2,000
published products." when the count says more. A count that changes between
pages, or that the products read so far outgrow, is dropped, and the result
says the total is unknown rather than showing a number it can no longer stand
behind.

Pages are cut by offset. If a product below the page being read is deleted and
another is added, the count holds and every later page moves by one, so one
product is never read. Before calling a read complete, the job therefore asks
for the ids of the whole list again, a hundred to a page and without the
product documents, and compares them with the products it read. Any difference
stops the job with "Your catalogue changed while it was being read. Check
again." The second pass costs at most twenty-one small requests for the largest
shop the connector reads.

## Judging a product

Each product is judged by the same rule the price question applies at purchase.
A product can be ready, need a fix in the shop, not be for sale in the shop, use
something the connector does not support, or have no answer from the shop. The
screen groups the results under those headings and shows ten rows per reason,
fifty more at a time on request.

## Withdrawing and returning cards

A sync withdraws a card only after a complete read of the list and only on the
shop's own direct answer about that product: deletion, a product no longer
published or purchasable, an unsupported product type, stock tracking, or
changed file and download limits. Temporary lack of stock, whole-shop settings,
missing text, a download the shop names without a usable id, name or address,
and card validation errors leave the last published card on sale; every
purchase still asks the shop for its current price and availability. A
partial read, an answer that broke off or a product the list merely left out
withdraws nothing.

A known card whose product is missing from the list is read directly, all such
cards together through the same batch read the import uses: each setting once,
products a hundred to a request, at most four requests in the shop at once. A
card the connector has already withdrawn is not read again; if its product is
published again, the list brings it back and the sync returns the card to
sale. Rereading it at every sync would repeat the shop's answer and, for a shop
with many deleted products, spend thousands of requests.

The dashboard records which card pauses the connector made, apart from the
gateway's ordinary card pause. A sync returns to sale only a card the connector
paused and never one the merchant paused. When the merchant pauses or resumes a
card the connector paused, the card is written first and the connector's claim
is dropped only once that write stands, so a failed write cannot turn the
shop's withdrawal into the merchant's own pause. In PostgreSQL a trigger on the
card's pause column drops the claim in the same transaction.

A sync takes one snapshot of what is on sale at its end, so a pause or resume
made during the walk shows in the result: a card the merchant resumed during
the sync is shown on sale, without the note that the merchant paused it.

## How a job ends

A job ends completed, or stopped with one of these reasons: the connection or
rate changed, the shop needs reconnecting, an exchange rate is required, the
shop's catalogue could not be read, a publication's outcome is unknown, the
work was interrupted, or Agentify stopped on its own side. The last one covers
a publication that cannot read the merchant's own account before it starts, and
a restart or an internal error before the first product is read. Those are not
the shop's doing, so the screen, the approval email and the analytics event
never describe them as an unreadable shop: the merchant reads "Agentify stopped
on its side before reading your shop. Nothing was published.", and analytics
records the generic reason rather than `catalogue_unavailable`.

## Reading progress

While a job is queued or running, the Products screen asks the server for it
once a second and shows only its counts, which the database computes without
sending the product rows. Once the job ends, the screen reads the finished
result once, with its rows, and stops asking. The operator's view of a
merchant keeps reading every five seconds after a job ends, so it can see the
next job the merchant starts.
