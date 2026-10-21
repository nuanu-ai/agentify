# Census: how many real WooCommerce shops could connect

Date: 2026-10-21. A pre-registered census. The sampling, the measures, the
verdict on each shop, the predictions and the rule that turns the results into
decisions are fixed here and committed before any shop's catalogue is
measured, and they are executed as written. The results are appended under
their own heading once the census ends; nothing above that heading changes
after this commit.

The note was amended once, on the same day and before any catalogue was read,
after a review of the first version. The amendment adds three things. The
census also sends the listing request exactly as the connector sends it,
without a User-Agent, because the first version could only say that the two
might be treated differently. It reads each shop's `robots.txt` before the
listing and respects it. And it says that the test host's Indonesian network
is a kinder vantage point than the one the live channel would call from.
Nothing in the first version had been measured when it was amended.

It was amended a second time, also on that day and before any shop's catalogue
in any group was read, to add a third group of shops in Europe at the product
owner's request. The European group has its own queries, origin rule, target,
predictions and one decision of its own; it uses the same candidate,
screening, conduct and measures as the others. The method for the Indonesian
and American groups is unchanged by it, and the European group decides
nothing about the Indonesian market.

## Why this census

Agentify lets AI agents buy from merchants, and a merchant who runs a
WooCommerce shop can connect it instead of writing code: the connector imports
the shop's eligible products as cards and fills paid orders in the shop
([ADR-0023](../decisions/0023-woocommerce-connect.md); the merchant's view is
the documentation page "Selling through a WooCommerce shop"). The connector
imports a product only when it is a published, purchasable, in-stock simple
product, without managed stock and not sold individually, priced in US dollars
written with two decimals, in a shop whose tax calculation is off and whose
permalinks are not plain. The product is then either a virtual download
carrying exactly one file, downloadable without limit or expiry, or a parcel,
a physical product that ships, from a shop whose shipping is on. The import
reads the shop's public catalogue through WooCommerce's Store API, the keyless
public interface WooCommerce's own storefront blocks use, at
`/wp-json/wc/store/v1/products`. It reads at most 200 products and refuses a
larger shop whole.

Every test of the connector so far ran against one shop, the integration lab
the project keeps (`deploy/woocommerce-lab/`), which was built to exactly
those rules: prices in US dollars, tax calculation off, no plugins, simple
products without managed stock. That shop proves the connector does what it
says on a shop made for it. It says nothing about how many shops in the
market could connect at all, nor about the plugins, caches and firewalls a
real shop puts between the connector and WooCommerce. The product owner
approved measuring this on real shops. The results decide what a second,
realistic lab looks like and whether the rule that a shop prices in US
dollars goes to the product owner as a product decision.

## The question

Of the WooCommerce shops in the market where Agentify looks for its first
merchants, Bali and the rest of Indonesia, with a smaller control group of
shops in the United States and a third group in Europe, what share could
connect and have at least one product imported by the connector as it stands
today, and what stops the rest?

Three secondary questions ride on the same requests. Which plugins and which
hosting set-ups, meaning a content-delivery network in front of the shop, bot
protection and caching, are common enough among these shops that a realistic
lab must have them. Whether a server, rather than a browser, can read a shop's
public catalogue at all. And, as a by-product of finding the shops, what share
of the merchants found sell from WooCommerce rather than another platform.

## What was looked at before this note

To check that the method can work, five merchant sites were requested on
2026-10-21 from the test host, the server that runs Agentify's test channel
where money is not real. Each got one request to its catalogue address, and
one of them a second after a redirect. All five are brands named in one
public guide to Bali beauty brands. One redirected its bare domain to its
`www` address and then answered the catalogue address with a page of its own,
because the site is not WordPress. One runs on Squarespace and answered 404
with an HTML page. Two answered from Shopify behind its content-delivery
network, and the network's timing header named the requesting country as
Indonesia. One, a Bali shop selling incense and homeware, answered the Store
API with a JSON list and the header `X-WP-Total: 225`, so it is a WooCommerce
shop over the 200-product ceiling. Its products carried `type`,
`is_purchasable`, `is_in_stock`, `is_on_backorder`, `sold_individually`,
`low_stock_remaining`, `stock_availability`, `prices` with `currency_code` and
`currency_minor_unit`, `price_html`, `weight`, `dimensions` and `extensions`,
and the availability text read "3 in stock" and "24 in stock", which
WooCommerce writes only for a product whose stock it counts. These five sites
are candidates like any other and are screened again under the rules below
if a query names them; what was seen during this look counts for nothing.

Three facts from that look shape the method. The test host leaves the
internet from an Indonesian network (autonomous system 45701), not from a
foreign datacentre, so "a server can read it" is measured from inside the
market. Many brands that sell online do not run WooCommerce, so the sample
has to be screened from a larger list of merchants. And the public catalogue
carries no field for virtual, downloadable or managed stock, which is why
several of the connector's rules can only be inferred or left unknown below.

The Store API's fields were also read in WooCommerce's source
(`ProductSchema` and `WC_Product::get_availability_text` on the WooCommerce
trunk branch, 2026-10-21), which is where the inferences below about managed
stock and tax come from.

## Sampling

### Where candidates come from

Candidates come from web searches run with the web search built into Claude
Code, in its standard mode, on one day, with the queries below typed exactly
as written. The tool searches from the United States,
which shapes what it returns for Indonesian queries; that is a property of the
sample and is said with the results. Every result list is saved, in the order
returned, with the raw data kept outside the repository.

The Bali stratum is fed by these queries, in this order:

1. `best Bali fashion brands to shop online`
2. `Bali swimwear brands online store`
3. `Bali jewellery brands online shop`
4. `Bali skincare brands`
5. `Bali coffee roasters online shop`
6. `Bali chocolate brand online shop`
7. `Bali homeware brands online store`
8. `Bali surf shop online`
9. `Bali yoga wear brand`
10. `Bali leather bag brand online shop`
11. `Bali artisan crafts online store`
12. `Bali essential oils brand shop online`
13. `Bali spa gift voucher buy online`
14. `brand fashion lokal Bali belanja online`
15. `toko oleh-oleh Bali online`
16. `kopi Bali toko online`
17. `perhiasan perak Bali toko online`

The rest of Indonesia is fed by these, in this order:

18. `Indonesian local fashion brands online store`
19. `brand lokal Indonesia toko online resmi website`
20. `batik online store Indonesia`
21. `Indonesian skincare brands official website`
22. `Indonesian coffee roasters online shop`
23. `Indonesian furniture brand online store`
24. `Jakarta online boutique`
25. `Yogyakarta handmade brand online shop`
26. `Bandung clothing brand official website`
27. `Indonesian tea brand online shop`
28. `toko buku online Indonesia`
29. `jual ebook Indonesia`
30. `Indonesian hijab brand official website`

Reserve queries for Indonesia, used in this order only if the queries above
are exhausted before the stratum's target: `Surabaya brand lokal toko
online`, `Lombok handmade online shop`, `Indonesian snack brand order online`.

The control group in the United States is fed by these, in this order:

31. `best independent clothing brands small business USA online`
32. `small batch coffee roasters USA online shop`
33. `independent jewelry brands USA handmade online store`
34. `indie skincare brands USA`
35. `independent bookstores that sell online USA`
36. `small business home decor online store USA`
37. `craft chocolate makers USA buy online`
38. `independent surf shop online USA`
39. `handmade leather goods USA online shop`
40. `digital planner shop small business USA`

Reserve queries for the United States, in this order:
`indie tea company USA online shop`, `small farm shop online USA`.

The European group is fed by these, in this order, which takes one query per
country in turn so that no country fills the group before the others are
asked:

41. `nachhaltige Modemarke Online-Shop Deutschland`
42. `Nederlandse duurzame merken webshop`
43. `marque française artisanale boutique en ligne`
44. `marcas españolas sostenibles tienda online`
45. `brand italiani artigianali negozio online`
46. `polskie marki odzieżowe sklep internetowy`
47. `independent UK brands online shop small business`
48. `kleine Kaffeerösterei online kaufen`
49. `Dutch independent brands online shop`
50. `petite torréfaction café vente en ligne France`
51. `tienda online artesanía España`
52. `torrefazione artigianale caffè vendita online`
53. `polska ceramika rękodzieło sklep online`
54. `best independent jewellery brands UK`

Reserve queries for Europe, in this order: `unabhängige Buchhandlung online
bestellen`, `boutique en ligne créateurs belges`, `Irish craft brands online
shop`.

The categories follow what Bali's merchants sell, goods and gift vouchers and
a few digital products, so that the census does not only find the kind of shop
the lab already resembles. No public directory of WooCommerce shops is used.
The one free directory tried, BuiltWith's list of WooCommerce sites in
Indonesia, sits behind a browser verification that a script does not pass, and
the paid lists cannot be checked by a reader of this note.

### From a result to a candidate

Each result is one of three things. A merchant's own site is a candidate. A
page about merchants, such as a guide, a list of brands or a news article, is
fetched once with an ordinary GET, and every link on it to another site is a
candidate, in the order the links appear in the page's HTML, except links to
the publisher's own domains and links to the excluded kinds of site listed
below. Anything else, a marketplace listing, a social network or a page with
no merchant on it, yields nothing. The result pages themselves are fetched
from the Mac; only shops are requested from the test host.

The excluded kinds of site are social networks and messaging (Facebook,
Instagram, TikTok, X and Twitter, Pinterest, YouTube, LinkedIn, Telegram,
WhatsApp links), marketplaces (Shopee, Tokopedia, Lazada, Blibli, Bukalapak,
TikTok Shop, Etsy, Amazon, eBay, Faire, Zalora), maps and travel sites
(Google Maps, TripAdvisor, Booking.com, Agoda, Klook, Traveloka, Airbnb),
search engines and font, image or script hosts, and the publisher's own
sister sites. A link to a site of none of these kinds is a candidate even if
it turns out not to be a shop; it is then screened out and recorded as such.

Candidates are identified by host name after redirects. A host seen before is
not screened again; the first query that named it is its source.

### Screening a candidate

A candidate is screened by the requests described under "Conduct towards the
shops": its front page and its Store API listing. It is a WooCommerce shop
when the listing answers with a JSON list, at the root's `/wp-json/`, under a
sub-path or at `?rest_route=`, or when the front page's HTML carries a
WooCommerce marker (a path under `/wp-content/plugins/woocommerce/`, or the
`woocommerce` class on the body), whatever the listing answered. A candidate
that challenges or rate-limits the front page itself cannot be identified, is
recorded as "blocked before identification", and is counted beside the
results so that the reader sees how many shops this method lost that way.

A WooCommerce shop is included when it is a real business that sells to
customers. It is excluded, with the reason recorded, when its host name
carries a label `demo`, `staging`, `dev` or `test`; when it belongs to a theme
or plugin vendor showing off its product; when the front page says the shop
is coming soon, under maintenance or closed; or when its public listing holds
no product at all. Nothing that the verdict below depends on, such as the
currency, the product types or the size of the catalogue, is a reason to
exclude a shop. A shop selling for several vendors (a marketplace built on
WooCommerce) is included and flagged.

A shop is Indonesian when its address ends in `.id`, or its front page gives
an Indonesian address, a `+62` telephone number or a WhatsApp link to a `62`
number. It is a Bali shop when it is Indonesian and the address or contact
text on its front page names Bali or a place in Bali (Denpasar, Badung,
Gianyar, Tabanan, Bangli, Klungkung, Karangasem, Buleleng, Jembrana, Ubud,
Canggu, Seminyak, Kuta, Legian, Sanur, Uluwatu, Jimbaran, Nusa Dua,
Kerobokan, Pererenan, Singaraja, Amed, Lovina), or, when the front page gives
no address, when the page that named it presents it as based in Bali. An
Indonesian shop that neither rule places in Bali counts for Indonesia and not
for Bali. A shop is in the control group when it came from a query for the
United States and its front page gives an address in the United States or a
`+1` number with a state named. A shop is in the European group when it
came from a query for Europe and its front page gives an address in a
European country, or its address ends in that country's domain, or its
contact gives that country's calling code; Europe here is the member states
of the European Union, the United Kingdom, Norway, Switzerland and Iceland,
and the shop's country is taken from the address, then the domain, then the
calling code, in that order. A shop found by a query for one group that
belongs to another is placed by these rules, not by the query; a shop that
none of them places is excluded as "origin undetermined".

### How many, and when to stop

The Indonesian group aims at about forty shops, with as many in Bali as the
Bali queries find. The Bali queries are worked through to the end, and Bali's
intake stops early only if it reaches forty. The queries for the rest of
Indonesia are then worked through until the Indonesian shops outside Bali
number at least fifteen and the Indonesian group as a whole numbers at least
forty, so a strong Bali harvest does not leave the rest of the country
unmeasured. The control group in the United States aims at twenty shops.
With forty shops a share's 95% interval is still about fifteen points either
side, which is enough to tell a tenth from a half, and that is the size of
difference the decision rule below turns on; twenty is enough for a control
whose job is to show whether a difference is large, not to measure it
finely.

The European group aims at about twenty-five shops. So that one country does
not fill it, a country stops contributing once it has five included shops,
and its later candidates are recorded as "country's share reached" without
being requested. The group stops at twenty-five, or when its queries and then
its reserve queries run out, and the number of shops from each country is
reported.

Within a query, results are taken in the order the tool returned them, and
within a page about merchants, links in the order they appear. The stopping
condition is checked after each candidate, and the candidate that meets it is
the last one taken for its stratum. When the main queries of a stratum run out
before its target, its reserve queries are used in order; when those run out
too, the stratum ends short and the shortfall is reported, and no query is
added afterwards.

Every screened candidate is recorded with its source query, the page that
named it, the platform it was found to run, and the reason it was kept or
excluded. The counts of that record are published with the results.

## Conduct towards the shops

Every request to a shop is a GET to a public address: the front page,
`/robots.txt`, and the Store API's product listing. The census never sends a
POST and never touches
the Store API cart or checkout, because a cart leaves a session in the shop;
it never opens `/wc-auth/`, fills a form or signs in.

A shop receives at most seven requests, redirect hops included, at most one
per second and a half, and the census moves to the next shop only when it is
done with this one. The requests are, in order:

1. The front page at the candidate's https address, following at most two
   redirects to https addresses on the same registrable domain. The address
   the redirects end on is the shop's root address for everything below, as
   it would be what a merchant types into the connector.
2. `GET /robots.txt` at that address, following at most one redirect on the
   same registrable domain. Its rules are read the way RFC 9309 says: the
   group for a user agent whose name `AgentifyResearch` matches applies, or
   else the group for `*`; within it the longest matching `Allow` or
   `Disallow` path wins, and `Allow` wins a tie. An answer of 400 to 499
   means no rules. A challenge or 429 ends the shop's census as below. A 500
   or above, or no answer, means everything is disallowed, as the RFC says. A
   path disallowed for the census is not requested: a shop whose
   `robots.txt` disallows `/wp-json/wc/store/v1/products` gets no listing
   request at all, neither the honest one nor the connector's.
3. `GET /wp-json/wc/store/v1/products?per_page=100&page=1`, with the header
   `Accept: application/json`, following no redirect: the honest request.
4. `GET /wp-json/wc/store/v1/products?per_page=1`, sent the way the connector
   sends it (described below): the connector's own request. It is sent only
   when the shop is a WooCommerce shop by the front page or by the honest
   request.
5. Only when the honest request did not answer with a JSON list and was
   neither challenged nor rate-limited: when the front page's HTML loads
   `/wp-content/` under a sub-path and never at the root, the same listing
   under that sub-path with `per_page=1`; otherwise
   `GET /?rest_route=/wc/store/v1/products&per_page=1`, each only if
   `robots.txt` allows its path.
6. Further pages of the listing, at `per_page=100`, only when they are needed:
   page two when `X-WP-Total` is between 101 and 200, or when the header is
   absent and page one held a hundred products; page three when the header is
   absent and page two held a hundred too.

A request that is answered 429 or with a challenge page ends the census of
that shop, and the answer is recorded. When the budget runs out before a
needed page, that page is unread, and what depends on it is unknown.

Every request is HTTP/1.1, written byte for byte by the census's script over
a TLS connection to an address the shop's name resolved to, with no cookie,
no request for compression and `Connection: keep-alive`, and waits fifteen
seconds for an answer and ten megabytes for its body, which are the
connector's own limits. The honest requests carry the User-Agent
`AgentifyResearch/1.0 (WooCommerce shop census; +https://agentify.ad)`. The
connector's own request carries exactly what
`apps/dashboard/src/woo-request.ts` sends for a catalogue page and nothing
else: `accept: application/json`, `host` and `Connection: keep-alive`, in
that order, with no User-Agent, which is what Node 24 put on the wire when
the census checked it. So the honest listing request and the connector's
differ only in the User-Agent, the number of products asked for and the
second or two between them. The TLS handshake is made by Python's OpenSSL on
the test host, not by Node's, so a firewall that recognises clients by their
handshake may still tell the connector from the census; the census cannot
measure that.

The requests to shops run from the test host, the vantage the connector's
requests leave from on the test channel, as an ordinary user, without sudo,
with everything written to a temporary directory that is copied off the host
and removed when the run ends. If the test host cannot be reached on the day,
the run happens from the Mac, and the results say so, because a residential
address may be treated more kindly than a server's.

## What is measured, and what it can honestly say

Each measure is either observed, meaning read from a field or header whose
meaning WooCommerce or the server defines, or inferred, meaning read from a
sign that usually goes with the fact but could be produced another way.
Inferred measures are labelled as such wherever they are reported. "Unknown"
is recorded as unknown and never filled with a default.

### Access

The answer to the listing request is put in exactly one class. *Readable*: a
200 whose body parses as JSON and passes the connector's own schema for a
product list (`StoreProductsSchema` in `apps/dashboard/src/woo-catalog.ts`).
*Empty*: a 200 with an empty list. *Unreadable list*: a 200 with JSON that
fails the schema, or a 200 that is not JSON. *Challenged*: any answer carrying
a challenge, recognised by a `cf-mitigated: challenge` header, a title "Just a
moment..." or "Attention Required!", the text `sgcaptcha`, or the block
pages of Sucuri, Wordfence, Imunify360 or a hosting provider's bot check.
*Rate-limited*: a 429. *Refused by a firewall*: a 401, 403, 406 or 503 whose
body is not a WordPress error document. *Closed by the shop*: a 401 or 403
whose body is a WordPress error document (JSON with a `code`), which is what a
plugin that restricts the REST API answers. *No route*: a 404 whose body is a
WordPress error document with the code `rest_no_route`, meaning WordPress
answers but WooCommerce's Store API is not there. *Redirected*: any 3xx.
*Other*: anything else, including a 404 page that is not JSON. *Unreachable*:
no answer within fifteen seconds, a failure of DNS, the connection or TLS, or
a 503 whose page says the site is under maintenance. Where an answer fits two
classes, *Challenged* wins, then *Rate-limited*, then *Unreachable*, then the
rest as written. All of this is observed, from one vantage point and with the
census's User-Agent; whether a browser would get through is not measured.

The connector's own request is put in the same classes, and a shop is
**readable by the connector's own request** when that answer is *Readable*.
That is reported as a share of each group, beside the share readable by the
honest request, and every shop where the two differ in class is listed in
anonymized form with both classes.

The vantage point matters. The test host leaves the internet through an
Indonesian network, so to an Indonesian shop's host it looks local. The live
channel, if the connector reaches it, calls from a datacentre in Germany,
which a firewall is more likely to treat as foreign or automated. Every
blocked share this census measures for the Indonesian and American groups is
therefore a lower bound for what the connector would meet on the live
channel, and is reported as one. For the European group the comparison does
not run one way: a German datacentre is local to a European shop's host while
an Indonesian address is not, but a datacentre is more often treated as
automated than the test host's network, so the European blocked share is
reported as measured from Indonesia, with no claim about the live channel.

The front page's answer is put in the same classes, so that a firewall
guarding only the API can be told from one guarding the whole site.

### The shop

The **currency** and the **number of decimals** are read from
`prices.currency_code` and `prices.currency_minor_unit` of the listed
products, observed. They are what the shop answered this vantage point: a
multi-currency plugin may choose a currency by the requester's country, and
the connector, requesting from the same host, would see the same. The
presence of such a plugin is recorded from the front page, and any shop whose
verdict turns on its currency while such a plugin is present is named in the
results.

The **number of products** is `X-WP-Total` on the first page, observed; where
the header is absent, it is counted from the pages read, and a third page that
is not empty means more than 200. When the header is absent and the budget
ends on a full page, the count is unknown.

**Plain permalinks** are observed when the listing answers with a JSON list at
`?rest_route=` but not at `/wp-json/`. A WooCommerce shop at a **sub-path**
rather than at the root of its address is observed when the listing answers
under the sub-path. Both stop the connector, which asks at `/wp-json/` at the
root of the shop's address.

**Tax calculation** is not visible from outside, and for nearly every shop it
stays unknown. There is one sign, and it points only one way: WooCommerce
prints a price suffix (an element with the class `woocommerce-price-suffix` in
`price_html`) only when tax calculation is on and the merchant has written a
suffix. A suffix in any listed product's `price_html` is recorded as "tax
calculation on, inferred from the price suffix". Its absence says nothing and
is recorded as "tax calculation unknown". A theme or plugin could print its
own suffix, which is why it stays an inference. When a suffix is seen, its
text is recorded. Beside it, and not used in any verdict, the census records
whether `price_html` carries tax wording outside a suffix (`MwSt`, `VAT`,
`BTW`, `TTC`, `HT`, `IVA`, `PPN`, `tax`), because a German shop often
prints "inkl. MwSt." through a plugin rather than through WooCommerce's
suffix. For the European group the suffix is the one place where tax
calculation shows from outside, since European shops usually show prices with
tax included, and the share of European shops that print one is reported in
its own right.

**Shipping**, the shop's **download settings** (the download method, a login
to download, access after payment, the redirect fallback), and whether the
shop can grant the connector its key through `/wc-auth/` and send it back,
are not visible from outside, and are not measured. Neither is whether the
shop's host passes the `Authorization` header that the connector's later,
authenticated requests need.

### Each product

For each product on the pages read, observed: `type`; `is_purchasable`;
`is_in_stock` and `is_on_backorder`; `sold_individually`; the price and its
digits; the name and the description; and whether `weight` or any of
`dimensions` is filled in. A product the public listing returns is taken to be
published, as the connector itself does.

**Managed stock** is inferred, from two signs that WooCommerce's source ties to
it. `low_stock_remaining` is filled only from a stock quantity, which a
product without managed stock does not have; and for a product in stock and
not on backorder, `stock_availability.text` is empty unless its stock is
managed, when it reads "24 in stock", "Only 2 left in stock" or "In stock"
depending on a setting. So a product in stock and not on backorder is recorded
as "managed stock, inferred" when `low_stock_remaining` is not null or the
text is not empty, and as "stock not managed, inferred" when both are empty. A
theme or plugin can rewrite the text, which is why the sign is an inference in
either direction. For a product out of stock or on backorder, managed stock is
not recorded, because it does not change that product's verdict.

**Virtual, downloadable and the number of files** are not in the public
listing, so whether a product would be a download or a parcel is unknown.
Weight or dimensions filled in suggests a physical product, and the share of
such products is recorded as a sign, labelled as such, and used for nothing
in the verdict.

### Plugins and hosting

**Plugins** are the distinct slugs in paths of the form
`/wp-content/plugins/<slug>/` in the front page's HTML, together with the keys
of `extensions` in the listing, which name plugins that extend the Store API.
Both are observed as present. Absence says little: a plugin that prints
nothing on the front page is invisible, and a cache that combines the page's
files hides the slugs of the plugins it combined. Plugins are reported as
"visible on the front page", never as "installed".

**Hosting** signals are read from the headers of the front page and of the
listing, observed: Cloudflare (`cf-ray`), Sucuri (`x-sucuri-id`), QUIC.cloud
(`x-qc-`), Amazon CloudFront (`x-amz-cf-id`), Fastly, Akamai or Varnish (their
`via` or `x-cache` values), a hosting provider's own cache (`x-kinsta-cache`,
`x-hcdn-`, `x-proxy-cache`, `x-ac`), LiteSpeed (`server: LiteSpeed` or
`x-litespeed-cache`), and the `server` header as given. A cache hit on the
listing (`x-cache`, `cf-cache-status`, `x-litespeed-cache` reading `hit`) is
recorded too, because a cached catalogue can be stale. The network a shop is
served from is read from DNS (its address's autonomous system through Team
Cymru's DNS service), which sends nothing to the shop.

**The platform of a candidate that is not WooCommerce** is inferred from the
front page by fixed markers: Shopify (`cdn.shopify.com`, or an `x-shopid` or
`powered-by: Shopify` header), Squarespace (`server: Squarespace`), Wix
(`x-wix-request-id` or `static.wixstatic.com`), BigCommerce
(`cdn11.bigcommerce.com`), Webflow (`data-wf-site`), Magento (`Magento` or
`/static/version` with `mage/`), OpenCart (`catalog/view/theme`), PrestaShop
(`prestashop`), WordPress without WooCommerce (`/wp-content/` with no
WooCommerce marker and a listing answering *No route*), and "other" when none
matches.

## The verdict on each shop

The verdict on an included WooCommerce shop is reached by the following steps,
in order, and the first step that decides it is final. Every reason that
applies is recorded, not only the deciding one. The verdict uses the honest
request's answers throughout; the connector's own request is reported beside
it.

0. **robots.txt.** If the shop's `robots.txt` disallows the listing path for
   the census, the verdict is **unknown (robots.txt)**, counted separately.
1. **Access.** If the listing was *Challenged*, *Rate-limited*, *Refused by a
   firewall* or *Unreachable*, the verdict is **unknown (blocked)** or
   **unknown (unreachable)**.
2. **The shop as observed.** If any of these is observed, the verdict is
   **cannot**: the listing was *Closed by the shop*, *Redirected*, an
   *Unreadable list*, *No route* or *Other* at the root's `/wp-json/`
   (including plain permalinks and a shop at a sub-path); more than 200
   products; a currency other than `USD`; a number of decimals other than 2.
3. **Tax.** If a price suffix was seen, the verdict is **cannot (inferred:
   tax calculation)**.
4. **The products.** Each product read is passed through the connector's own
   `cardsFromTheShop` (`apps/dashboard/src/woo-catalog.ts` at commit
   `d874a68f`), with the three fields the public listing lacks set to the
   values that let a parcel through: not virtual, not downloadable, stock not
   managed. A product that comes out as a card is then refused if it is sold
   individually, on backorder, or carries managed stock by the inference above.
   What remains are the **qualifying products**.
5. If at least one product qualifies, the verdict is **could, conditionally**.
6. If none qualifies and every page was read, the verdict is **cannot**; when
   the only thing that removed the last qualifying products was inferred
   managed stock, it is **cannot (inferred: managed stock)**.
7. If none qualifies among the pages read and a page was left unread, the
   verdict is **unknown (incomplete)**.

"Could, conditionally" is the best verdict this census can give, and it is
an upper bound: the shop would still need tax calculation off, and the
qualifying product would need to be a parcel from a shop whose shipping is on
or a download carrying one file under the right settings, none of which can be
seen from outside. Every result that reports this verdict says so in the same
sentence. Beside it, the census reports how many conditional shops have at
least one qualifying product whose description, as the connector would carry
it, fits the 500 characters a published card allows, because a product over
that length is imported but waits for the merchant to shorten it.

Beside the verdict, the census counts the shops that answer the honest
request with a JSON list and refuse the connector's own request, that is,
put it in any class other than *Readable*. That is its own line in the
analysis of sole blockers below, reported with the verdict each such shop
received from the honest data, because for those shops the connector would
stop at the door whatever their catalogue holds.

Every **cannot** is also read for its **sole blocker**: the one reason that,
treated as passed while everything else stays as observed, would turn the
verdict into "could, conditionally". The reasons tried are the currency
(passed together with the currency's own number of decimals), decimals other
than 2 in a dollar shop, more than 200 products (judged on the products read,
which for such a shop is the first hundred, and labelled so), plain
permalinks or a sub-path, the listing closed by the shop, a product type other
than simple, inferred managed stock, sold individually, out of stock or on
backorder, not purchasable, an empty description, and the price suffix. A
shop stopped by two reasons at once has no sole blocker. A shop can have more
than one when different products are each stopped by a single, different
reason, and then each is counted, so the shares of sole blockers can add up
to more than the share of shops that cannot connect.

## Predictions

These are written before any catalogue is read, each as a range for a share
of the included shops in a group. A prediction holds when the observed share
falls inside its range.

**P1.** Rupiah: 75–95% of the Indonesian shops, 55–85% of the Bali shops,
and at least 90% of the Indonesian shops outside Bali. Bali brands that sell
to visitors and abroad are the likeliest to price in dollars or Australian
dollars; elsewhere a local shop has no reason to.

**P2.** Of the shops pricing in rupiah, 40–75% write prices with no decimals.
Rupiah has no cents in daily use, but WooCommerce defaults to two and many
merchants never change it.

**P3.** At least 95% of the control group prices in US dollars with two
decimals, the default for a shop in the United States.

**P4.** More than 200 products: 10–30% of the Indonesian shops and 15–35% of
the control group. The guides that feed the search name established brands,
some with large catalogues of sizes and colours.

**P5.** Of all products listed, pooled within a group, the simple ones make
up 50–80% in Indonesia and 35–65% in the control group. Clothing, which the
American queries reach more often, is sold as variable products.

**P6.** Of the simple products in stock, 35–70% carry managed stock by the
inference, in both groups. A shop that ships goods tends to count them.

**P7.** A price suffix on at most 10% of the shops in each group. Indonesian
shops rarely calculate tax in WooCommerce, and American shops that do add it
at checkout rather than print a suffix, so the true share of American shops
with tax calculation on is expected to be much higher than this sign shows.

**P8.** Plain permalinks or a sub-path on at most 5% of the shops. Hosting
installers set pretty permalinks by default.

**P9.** The listing blocked (step 1) for 3–15% of the Indonesian shops and
5–20% of the control group. Cloudflare in front of a shop rarely challenges
an ordinary GET to the API, and the test host's Indonesian address is
unlikely to look foreign to an Indonesian host, while American hosting
firewalls refuse traffic from abroad more often.

**P10.** "Could, conditionally": 0–15% of the Indonesian shops, 5–25% of the
Bali shops, and 25–60% of the control group. The dollar rule removes most
Indonesian shops before their products are even looked at.

**P11.** The currency as the sole blocker: 15–45% of the Indonesian shops.
Rupiah shops with simple products and uncounted stock are expected to be
common among small Indonesian merchants.

**P12.** Of the screened candidates that sell online from their own site,
WooCommerce runs 20–45% in Bali, 25–50% in the rest of Indonesia and 15–35%
in the control group. Shopify is expected to lead among the brands that
guides write about, and WooCommerce to be stronger among Indonesian merchants
than American ones.

**P13.** Among the Indonesian shops, Elementor is visible on 35–65%, a
WhatsApp chat or order plugin on 20–50%, LiteSpeed (by header or plugin) on
30–60%, and Cloudflare in front on 25–55%. Indonesian shared hosting is
largely LiteSpeed, and Indonesian buyers order through WhatsApp.

**P14.** The shops that answer the honest request with a JSON list and refuse
the connector's own request: 0–15% of the Indonesian shops and 0–15% of the
control group. A request with no User-Agent is a common sign of a script, and
some hosting firewalls and Cloudflare's browser integrity check refuse it,
but most shops run neither in a mode that inspects requests to the API.

**P15.** For the European group, before its run. The euro is the currency of
55–80% of its shops, and a currency other than the euro or the US dollar
(the pound, the złoty) of 20–45%; a US dollar shop is at most 10%. At least
90% write prices with two decimals. Simple products make up 45–75% of all
products listed. Managed stock is inferred for 35–70% of simple products in
stock. A price suffix appears on 15–50% of the shops, fewer than European
habits suggest, because many German shops print the tax note through a legal
plugin rather than the suffix. The listing is blocked for 3–15%. The
connector's own request is refused where the honest one is answered for
0–15%. "Could, conditionally" is 0–5%, because almost no European shop prices
in US dollars.

## The decision rule

The rule is applied to the Indonesian group, because that is the market the
connector is for; the control group is reported beside it and decides
nothing. Shares are taken as observed, and the 95% interval is printed next to
each, but the thresholds are applied to the observed share and nothing else.

1. **Too few shops.** If the Indonesian group ends with fewer than 25
   included shops, none of the rules below is applied. The result is reported
   as insufficient, with the screening counts that explain why, and a new
   sampling method is proposed before anything is decided.
2. **The dollar rule.** If fewer than 20% of the Indonesian shops are
   "could, conditionally" and the currency is the sole blocker for at least
   10% of them, the rule that a shop prices in US dollars is brought to the
   product owner as a product decision, whether the connector sells in the
   shop's own currency, with these numbers beside it. If fewer than 20% are
   conditional but the currency is the sole blocker for less than 10%, the
   dollar rule is not what stops these shops, and the sole blocker with the
   largest share is brought to the product owner instead. If 20% or more are
   conditional, the dollar rule stays as it is and is treated as an edge case.
3. **Other sole blockers.** Every other sole blocker that stops at least 10%
   of the Indonesian shops gets a line in
   [`00-open-questions.md`](00-open-questions.md), with the product owner as
   the one who decides and this note as the source.
4. **The realistic lab.** Every plugin visible on at least 20% of the
   Indonesian shops, up to the eight most common (all of those tied at the
   eighth place are taken), enters the profile of a second, realistic lab
   shop, WooCommerce itself excepted. A multi-currency plugin enters at 10%.
   Every hosting signal seen on at least 20% of them enters the profile the
   same way: the content-delivery network in front, the server software and
   the cache layer, each by its most common provider. The profile also takes
   the median catalogue size of the Indonesian shops, their most common
   currency with its number of decimals, and their share of simple products,
   so that the lab's catalogue looks like theirs.
5. **Bot protection.** If at least 10% of the Indonesian shops are blocked at
   step 1, bot protection becomes a variant of its own of the realistic lab,
   using the protection most common among the blocked shops, and a test story:
   what the merchant reads when their shop refuses the connector. Between 3%
   and 10%, it is the test story alone. Below 3%, it is recorded and nothing
   follows. The share is a lower bound for the live channel, as said above,
   and is reported as one.
6. **The connector's missing User-Agent.** If even one included shop, in
   any group, answers the honest request with a JSON list and refuses the
   connector's own request, the missing User-Agent is recorded as a defect of
   the connector, to be fixed by sending an honest User-Agent, and not as a
   product question.
7. **Tax in Europe.** The European group, like the American one, decides
   nothing under rules 2 to 5, which are about the Indonesian market. Its
   share of shops printing a price suffix is reported as the measured lower
   bound of shops with tax calculation on in that market, with the suffix
   texts seen, and is handed to the separate probe that is studying whether
   shops with tax calculation on can be supported.

No change to the connector's code follows from this census directly; each
outcome above is a question put to the product owner or a lab built later.

## Publication

The repository is public. This note publishes aggregates, and examples only
in an anonymized form such as "a Bali surf shop, about 140 products, rupiah
at no decimals". The shops' addresses, the search results, the pages about
merchants and the raw answers are raw data kept outside the repository and
never enter git. The script that applies the verdict to the raw data names no
shop, and is kept beside this note in `55-woo-shop-census/` when the results
are added.

## Results

The census has not run yet.
