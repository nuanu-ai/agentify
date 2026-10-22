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

### How the run went

The census ran on 2026-10-21, from the test host, as written above: every
shop was requested from the test host's Indonesian network and nothing was
requested from the production host. The scripts that did it, none of which
names a shop, are kept beside this note in `55-woo-shop-census/`: the screener
that sent the requests (`screen.py`, with `run.py` around it), the inclusion
and origin rules (`include.py`), the extraction of the raw answers
(`extract.py`), the verdict (`verdict.ts`, run against the connector's own
`cardsFromTheShop` at `d874a68f`), the counts (`stats.py`) and the network
lookup (`asn.sh`). The search results, the candidate lists, the shops'
addresses and their answers are raw data kept outside the repository. The
host's temporary directory was copied off and removed when the run ended.

All 62 queries were run: the 54 main ones and all eight reserves, because the
Indonesian, the American and the European groups each ran out of main queries
before their target. They returned 574 results, of which 440 were pages about
merchants; 312 of those pages could be read, and the rest answered with an
error or a block of their own. The pages yielded 1,675 candidates. The census
requested 1,716 sites, counting the targets of front-page redirects to another
domain, and sent them about 5,800 requests, never more than seven to one site.
A further 41 European candidates were recorded as "country's share reached"
without being requested, because their domain belonged to a country that
already had five shops.

Of the requested sites, 86 turned out to run WooCommerce and 54 of those were
included: 22 in Indonesia, 15 of them in Bali, 7 in the United States and 25
in Europe (five each from the Netherlands, Belgium and Italy, four each from
Spain and the United Kingdom, one each from Poland and Ireland; none from
Germany or France, whose queries named no WooCommerce shop the rules could
place). Twenty-seven WooCommerce shops were excluded because the origin rule
could not place them from their front page, two because their listing held
no products, and three because their country already had five. Another 157
sites, about one in eleven of those requested, answered the front page with a
Cloudflare challenge, or in a few cases with a 429, so their platform is
unknown; 92 of those came from the American queries. That is the main reason
the American group is small.

**The Indonesian group ended with 22 shops, below the 25 that rule 1 of the
decision rule requires**, and the American group with 7 against a target of
20. Both are reported as measured and neither was stretched.

### Decisions the note did not foresee

The strata were run partly in parallel on the host to fit the day, so the
American and European queries were screened while the Indonesian ones were
still running. Afterwards the inclusion and stop rules were applied again to
every record in the note's order, Bali, the rest of Indonesia, the United
States, Europe; no record had to be discarded and no candidate before a stop
had been left unrequested.

Link shorteners and affiliate trackers found on pages about merchants (for
example `bit.ly` and the networks that redirect to a shop for a commission)
were dropped as candidates, because their own address leads to no merchant. A
publisher's sister sites were taken to be the domains linked from every
distinct page of that publisher that the census read, when it read two or
more. When a front page redirected to another domain, the target was screened
as the next candidate.

A shop's group was decided by the origin rules alone, whichever query found
it, so two American coffee roasters named by a Bali guide count in the
American group. The note's address rule was implemented as code reading the
front page's visible text. Three corrections were made to that code after the
first tables had been computed, each to make it follow the rule as written
rather than to change a result: a holding page is now recognised by its title
or by a short page that says little else, because "accessories coming soon" on
a Bali surf shop's front page had excluded a working shop; a postal address is
now read anywhere on the page when a postcode, a town and a separator precede
the country's name, because three Italian roasters print their address in the
footer away from the word "contact"; and a calling code is now read only from
a number written in international form, because an American shop's local
number beginning with 30 had been placed in Greece. The corrections left the
Indonesian and American groups as they were. In Europe they moved one shop
from Malta back to the Netherlands, removed the American shop from Greece and
let an Irish shop take the last place; the first table had shown one European
shop as "could, conditionally", and it was that misplaced American shop.

Question P12 counts a candidate as selling from its own site when it runs
WooCommerce, Shopify, BigCommerce, Magento, OpenCart or PrestaShop, or runs
Squarespace, Wix or Webflow with a cart on its front page; the note did not say
how to decide it.

### The verdicts

| Group | Shops | Could, conditionally | Cannot | Unknown |
| --- | --- | --- | --- | --- |
| Bali | 15 | 1 | 14 | 0 |
| Indonesia outside Bali | 7 | 0 | 7 | 0 |
| Indonesia | 22 | 1 (5%, interval 1–22%) | 21 | 0 |
| United States | 7 | 6 (86%, interval 49–97%) | 0 | 1 |
| Europe | 25 | 0 (0%, interval 0–13%) | 20 | 5 |

"Could, conditionally" means that at least one product passed every check the
public listing allows, and it remains an upper bound: tax calculation, the
product's class and its shipping or download settings cannot be seen from
outside.

In Indonesia the first reason recorded for the 21 shops that cannot connect
was the currency for 11, more than 200 products for 7, prices in dollars
written with no decimals for one, a WooCommerce shop whose Store API does not
answer for one, and a listing that answered with a page of its own for one.
The currency alone, with its own decimals allowed, is the sole blocker for 7
of the 22 shops (32%), and the dollar decimals for one more; no other reason
alone stops any Indonesian shop. The one Indonesian shop that could connect,
conditionally, is a Bali surfboard shaper selling 13 boards in US dollars as
simple products whose stock is not counted; they would sell as parcels.

In the United States six of the seven shops could connect, conditionally, and
the seventh answered the listing with a 429. Four of the six have a
qualifying product whose description fits the 500 characters a card allows.

In Europe the first reason for the 20 shops that cannot connect was the
currency for 11 and more than 200 products for 7; one shop closes its REST API
to visitors and one has no Store API. The currency alone is the sole blocker
for 9 of the 25 (36%). Of the five unknown, two disallow the listing path in
`robots.txt`, two did not answer the hundred-product page within fifteen
seconds or reset the connection while answering a one-product page at once,
and one answered 429.

### What the shops look like

The table gives the measures per group. A share is of the shops in the group
unless it says otherwise; currency and catalogue size are of the shops whose
listing could be read (20 in Indonesia, 6 in the United States, 20 and 18 in
Europe).

| Measure | Indonesia (Bali) | United States | Europe |
| --- | --- | --- | --- |
| Currency | rupiah 80% (86%), dollar 15%, pound 5% | dollar 100% | euro 75%, pound 20%, złoty 5% |
| Rupiah written with no decimals | 15 of 16 | — | — |
| More than 200 products | 35% (29%) | 0% | 39% |
| Median catalogue size | 123 | 21.5 | 121 |
| Simple products, of all listed | 72% (59%) | 38% | 58% |
| Managed stock, inferred, of simple products in stock | 38% | 22% | 66% |
| Sold individually, of all listed | 6% | 5% | under 1% |
| Weight or dimensions filled, of all listed | 51% | 44% | 15% |
| Price suffix | 0% | 0% | 0% |
| Tax wording elsewhere in the price | 0% | 0% | 0% |
| Plain permalinks or a sub-path | 0% | 0% | 0% |
| `robots.txt` disallows the listing | 0% | 0% | 8% |
| Listing blocked (step 1) | 0% | 14% | 4% |
| Readable by the honest request | 91% | 86% | 72% |
| Readable by the connector's own request | 91% | 86% | 72% |
| Multi-currency plugin visible | 9% | 14% | 24% |
| Listing served from a cache | 5% | 0% | 4% |

The blocked shares above are measured from an Indonesian network. For the
Indonesian and American groups they are a lower bound for what the connector
would meet calling from Germany on the live channel; for the European group
they make no claim about the live channel.

No included shop, in any group, printed a price suffix, and none carried tax
wording elsewhere in its price. Two WooCommerce shops outside the sample did:
a Spanish shop printing "IVA incluido" and an Italian one printing "IVA
inclusa", both excluded because the origin rule could not place them from
their front page.

The plugins visible on at least a fifth of the Indonesian shops, WooCommerce
itself aside, are Elementor (45%), Contact Form 7 (36%), the Xendit payment
plugin for Indonesian virtual accounts (32%), Elementor Pro (27%) and Google
Site Kit (23%); a WhatsApp chat or order plugin of some make is visible on 32%,
though no single one reaches a fifth. Among hosting signals, Cloudflare is in
front of 36% of the Indonesian shops and LiteSpeed serves 32%; no other
reaches a fifth. By the networks their addresses resolve to, 7 of the 22
Indonesian shops are served from Indonesian networks and 11 from American
ones, mostly Cloudflare. The European shops' most common plugin is Contact
Form 7 (24%), and their servers are mostly nginx (44%) and Apache (32%);
Cloudflare is in front of 8%. The plugin `extensions` the Store API reported
were few: a Google Analytics integration and a tag manager.

Some anonymized examples: a Bali jewellery shop with 174 simple products in
rupiah at no decimals, stopped by the currency alone; a Bali ceramics maker
with more than 6,000 products, refused whole for size before its currency is
even read; an Indonesian furniture shop pricing in US dollars with 341 products,
stopped by the 200-product ceiling alone; an Indonesian tea exporter pricing
in pounds; five Italian coffee roasters, each with between 33 and 162 products
in euros, each stopped by the currency alone; a Dutch shop whose REST API
answers only signed-in users.

### The connector's own request

In Indonesia and the United States the connector's own request, without a
User-Agent, was answered exactly as the honest one. In Europe two shops, a
Dutch wholesaler of scarves and bags and a Polish pottery shop, both served by
Apache, answered
the honest request with their product list and the connector's request with a
bare Apache 403 page: 2 of the 25 European shops (8%, interval 2–25%). Both
have more than 200 products and price in their own currency, so their verdict
does not change, but for a shop like them the connector would be refused at
the door whatever its catalogue held. Two more European shops failed the
honest hundred-product request, one by a fifteen-second timeout and one by a
reset connection, and answered the connector's one-product request at once;
that difference is the size of the page, not the User-Agent, and the
connector's own import asks for a hundred products per page under the same
fifteen-second limit, so it would fail there too.

### The predictions

Held: P1 for Indonesia as a whole (rupiah 80%); P3 (all six readable American
shops in dollars at two decimals); P5 in both groups (72% and 38% simple); P6
for Indonesia (38%); P7 (no suffix in either group); P8 (no plain permalinks
or sub-path anywhere); P9 for the United States (14%); P10 for Indonesia (5%)
and Bali (7%); P11 (currency the sole blocker for 32%); P12 for Bali (25%) and
the rest of Indonesia (37%); P13 in full (Elementor 45%, a WhatsApp plugin 32%,
LiteSpeed by header or plugin 36%, Cloudflare 36%); P14 in both groups (0%);
and every part of P15 but one (euro 75%; pound and złoty 25%; no dollar shop;
all at two decimals; 58% simple; 66% managed stock; 4% blocked; the
connector's request refused for 8%; none could connect).

Failed: P1 for Bali (86% against 55–85%) and for the rest of Indonesia (67%
against at least 90%, from six readable shops); P2 (15 of 16 rupiah shops at no
decimals against 40–75%); P4 in both groups (35% of Indonesian shops over 200
against 10–30%, and none of the American ones against 15–35%); P6 for the
United States (22% against 35–70%); P9 for Indonesia (none blocked against
3–15%); P10 for the United States (86% against 25–60%); P12 for the United
States (10% against 15–35%); and the suffix part of P15 (none against 15–50%).

### The decision rule, applied

1. **Too few shops.** The Indonesian group ended with 22 included shops,
   fewer than 25. Rules 2 to 5 are therefore not applied: the result is
   reported as insufficient, and nothing about the dollar rule, other sole
   blockers, the realistic lab or bot protection is decided from it. The
   numbers above stand as observations. The screening counts say why the
   group is small: guides about Bali and Indonesian merchants link far more
   often to Shopify (47 of the 84 Indonesian merchants found selling from
   their own site) than to WooCommerce (23), most of what they link to is not
   a shop at all, and six WooCommerce shops found by the Indonesian queries
   were lost to the origin rule. The proposal for the next method, for the product owner to accept or
   change before anything runs, is to keep this method's conduct, measures and
   verdict and change only how Indonesian shops are found: take candidates
   from the Indonesian merchants who list a website on the payment gateways
   and couriers Indonesian WooCommerce shops use (the Xendit plugin is visible
   on a third of the shops found here), add queries for Indonesian product
   categories in Indonesian, and let the origin rule read one more page, the
   shop's contact page, when the front page gives no address.
2. **The dollar rule**, 3. **other sole blockers**, 4. **the realistic lab**
   and 5. **bot protection**: not applied, by rule 1.
6. **The connector's missing User-Agent.** Two included European shops
   answered the honest request with a JSON list and refused the connector's
   own request. The missing User-Agent is therefore recorded as a defect of
   the connector, to be fixed by sending an honest User-Agent, and not as a
   product question.
7. **Tax in Europe.** No included European shop printed a price suffix: the
   measured lower bound of European shops with tax calculation on is 0 of 25
   (interval 0–13%), with no suffix text in the sample. This lower bound is
   uninformative, since it means only that these shops do not use
   WooCommerce's suffix to say their prices include tax, and the two suffixes
   seen ("IVA incluido", "IVA inclusa") come from shops outside the sample.
   Both are handed to the separate probe that is studying whether shops with
   tax calculation on can be supported.

## Second Indonesian sample: pre-registration

Date: 2026-10-21. Rule 1 left the Indonesian group at 22 shops, and the
product owner accepted the proposal the rule called for. This section fixes,
before any catalogue of the second sample is read, how the second sample is
found, the one change to the origin rule, the target, the stop rule, how the
two samples combine, and the predictions. Nothing above this heading changes:
the first sample's numbers stay as reported, and the second sample's results
are appended under a heading of their own after this one.

### What the second sample keeps

Everything about conduct, measures and verdict is as written above: GET only,
the front page, `robots.txt`, the honest listing request, the connector's own
request, the same seven-request ceiling and spacing, the same classes,
inferences and verdict steps, the same scripts beside the note with the
corrections the first results describe, and requests from the test host only.
A site screened in the first sample is not screened again.

### Where its candidates come from

The proposal named Indonesian payment gateways' and couriers' public merchant
lists as the first source. Their public pages were checked on 2026-10-21,
before this section was written, and none carries a usable list: Duitku's and
iPaymu's merchant pages show logos without links, Xendit's customer page
refuses a request from a script with 403, the customer or merchant pages tried
at Midtrans, DOKU, Tripay, Faspay and Biteship do not exist, and the WordPress
support forums of the Indonesian payment and shipping plugins hide the address
of the shop a user asks about from visitors who are not signed in. That source
is therefore replaced by search queries that name the gateways and couriers
shops show their buyers, so that a result is more often a shop that takes
Indonesian payments on its own site.

Candidates come from the same search tool and the same rules for turning a
result into candidates as the first sample. The queries are, in this order:

63. `toko online batik tulis resmi`
64. `jual kopi arabika online website resmi`
65. `toko online perlengkapan bayi lokal`
66. `jual madu hutan asli online`
67. `sepatu kulit lokal toko online resmi`
68. `jual tas anyaman rotan online`
69. `toko online skincare lokal BPOM resmi`
70. `jual keramik handmade online`
71. `toko buku online terbitan lokal`
72. `jual kain tenun ikat online`
73. `toko online perhiasan perak Celuk`
74. `jual teh herbal kemasan online`
75. `toko online mainan kayu edukasi`
76. `jual sambal kemasan online resmi`
77. `toko online tanaman hias`
78. `jual dupa dan aromaterapi online`
79. `toko online peralatan selancar Bali`
80. `jual cokelat artisan Indonesia online`
81. `toko online furnitur jati Jepara`
82. `jual pakaian muslim lokal website resmi`
83. `toko online oleh-oleh Bali kirim seluruh Indonesia`
84. `jual minyak atsiri online`
85. `toko online kerajinan tangan Lombok`
86. `jual kaos desain lokal online`
87. `toko online produk UMKM Bali`
88. `toko online pembayaran Xendit virtual account`
89. `toko online bayar dengan Midtrans`
90. `toko online cek ongkir JNE otomatis`
91. `pembayaran Duitku toko online`
92. `belanja online bayar QRIS website toko resmi`

Reserve queries, used in this order only if the queries above run out before
the target: `jual produk organik online Indonesia`, `toko online alat musik
tradisional`, `jual lukisan Bali online`.

For the Bali rule, queries 73, 79, 83 and 87 count as Bali sources, as the
Bali queries of the first sample did.

### The origin rule's extra read

When a WooCommerce shop's front page does not place it by the origin rules,
the census reads one more page from it: the first link on the front page to
the same host whose address or link text contains `contact`, `kontak`,
`hubungi`, `tentang`, `about` or `alamat`, if `robots.txt` allows it and the
seven-request ceiling leaves room after the listing's pages. The origin rules
are then applied, in the same order, to the front page and that page together.
A shop with no such link, or no room left, stays "origin undetermined". This
read is made only for the second sample; the first sample's shops are not
revisited.

### Target, stop rule and how the samples combine

The second sample counts only Indonesian shops, Bali and the rest together. It
stops when the combined Indonesian group, the first sample's 22 and the
second's, reaches 40 included shops, or when its queries and then its reserve
queries run out. A shop the rules place in the United States or Europe is
recorded and not added, so those groups stay as reported. If the combined
group ends below 25, rule 1 applies again and nothing more is run without a
new proposal.

The decision rule is applied to the combined Indonesian group exactly as
written above, rules 1 to 5, with every share taken over the combined group.
The second sample's own numbers are reported beside the combined ones, so a
reader can see how much the change of method moved them.

### Predictions for the second sample

Each is a range for the second sample's own shops, and holds when the observed
share falls inside it.

**Q1.** The combined Indonesian group reaches between 30 and 40 shops. The
first sample found about 15 Indonesian WooCommerce shops per hundred merchant
sites, and Indonesian-language queries should reach more shops directly than
English guides did.

**Q2.** Rupiah: 85–100% of the shops, and of those 80–100% at no decimals. The
queries ask in Indonesian for goods sold to Indonesians.

**Q3.** More than 200 products: 20–45%. The first sample's share was 35%.

**Q4.** Simple products, of all listed: 60–85%; managed stock inferred for
30–55% of simple products in stock.

**Q5.** "Could, conditionally": 0–10%; the currency the sole blocker for
20–45%.

**Q6.** Listing blocked at step 1: 0–10%; the connector's own request refused
while the honest one is answered: 0–10%.

**Q7.** Of the merchant sites selling from their own site that the second
sample's queries find, WooCommerce runs 30–55%.

**Q8.** The extra contact-page read places 30–70% of the WooCommerce shops
whose front page did not place them.

**Q9.** Visible on the second sample's shops: Elementor on 35–60%, an
Indonesian payment-gateway plugin (Xendit, Midtrans, Duitku, iPaymu or
Tripay) on 25–55%, an Indonesian shipping plugin on 10–40%, a WhatsApp plugin
on 20–50%; LiteSpeed (header or plugin) on 25–55% and Cloudflare on 20–50%.

## Second Indonesian sample: results

### How the run went

The second sample ran on 2026-10-21 from the test host, under the conduct
above and its pre-registration. All 30 of its queries and its three reserve
queries were run, because the main queries ran out before the target. They
returned 310 results. Most were marketplace listings, university theses and
news, and none was a gateway's or courier's list of merchants. The pages about
merchants yielded 127 candidates that the first sample had not screened. The
census requested 130 sites, counting the targets of front-page redirects, sent
them 477 requests, never more than seven
to one site, and removed the host's temporary directory afterwards. The
runner that adds the contact-page read and the combined stop, `run2.py`, is
kept beside the note with the other scripts.

Twelve of the requested sites run WooCommerce. Seven were included, all
Indonesian: two in Bali and five elsewhere. Four were Malaysian shops that the
origin rule could not place, and one was a German shop, recorded and not
added. The contact page was read for two of the four unplaced shops. It placed
neither, which is right for shops in Malaysia, and the other two had no
contact link the rule could follow. Four more sites answered the front page
with a Cloudflare challenge.

Five of the seven new shops came from a single page: a blog post on an
Indonesian gadget retailer's site about surfing in Bali, linking to five shops
that share a theme and a set of plugins and look like one company's
storefronts. The sister-site rule did not catch them, because the census read
only that one page of the publisher. They are counted as the rules say, and
the measures below that they weigh on are pointed out.

**The combined Indonesian group has 29 shops**: the first sample's 22 and the
second's 7, 17 of them in Bali. That is at least the 25 rule 1 requires, so
rules 2 to 5 are applied to it.

### The verdicts

| Indonesian shops | Shops | Could, conditionally | Cannot | Unknown |
| --- | --- | --- | --- | --- |
| Second sample | 7 | 0 | 7 | 0 |
| Combined | 29 | 1 (3%, interval 1–17%) | 28 | 0 |
| Combined, in Bali | 17 | 1 | 16 | 0 |

All seven new shops price in rupiah at no decimals. For four, the currency is
the first reason they cannot connect, and for three it is more than 200
products. The currency alone is the sole blocker for two of the seven.

In the combined group, the first reason recorded for the 28 that cannot
connect is the currency for 15 and more than 200 products for 10. One shop
prices in dollars written with no decimals, one has no Store API, and one
answers its listing with a page of its own. **The currency alone, with its own
decimals allowed, is the sole blocker for 9 of the 29 (31%)**, and the dollar
decimals for one more. No other reason alone stops any shop. The one shop that
could connect, conditionally, is still the first sample's Bali surfboard
shaper.

### What the shops look like

| Measure | Second sample | Combined Indonesia |
| --- | --- | --- |
| Currency, of shops whose listing was read | rupiah 7 of 7 | rupiah 85%, dollar 11%, pound 4% (27 read) |
| Rupiah written with no decimals | 7 of 7 | 22 of 23 |
| More than 200 products | 3 of 7 | 37% |
| Median catalogue size | 113 | 113 |
| Simple products, of all listed | 79% | 74% |
| Managed stock, inferred, of simple products in stock | 15% | 30% |
| Price suffix | 0 | 0 |
| Listing blocked (step 1) | 0 | 0 |
| Readable by the connector's own request | 6 of 7 | 26 of 29 (90%) |
| Honest request answered, connector's refused | 1 of 7 | 1 of 29 (3%) |
| Multi-currency plugin visible | 0 | 7% |

The one shop whose two requests differed answered the honest request with its
list and dropped the connection on the connector's request without sending a
byte. That looks like a broken connection, not a refusal of a request without
a User-Agent. It still counts under the note's definition, which takes any
class other than *Readable*.

The plugins visible on at least a fifth of the 29 shops, WooCommerce aside,
are Elementor (38%), Contact Form 7 (34%), the Xendit virtual-account plugin
(28%), Click to Chat for WhatsApp (24%), Elementor Pro (24%) and Google Site
Kit (21%). Three of the seven shops showing Click to Chat are from the
five-storefront cluster. Cloudflare is in front of 45% of the shops and
LiteSpeed serves 45%. No cache layer of a hosting provider reaches a fifth.
Among the second sample alone, LiteSpeed serves six of the seven and
Cloudflare fronts five, much of it the cluster again.

### The predictions for the second sample

Held: Q2 (all seven in rupiah, all at no decimals); Q3 (three of seven over
200); the simple-product half of Q4 (79%); Q5 (none could connect; the
currency the sole blocker for two of seven, 29%); the blocked half of Q6
(none); Q7 (WooCommerce runs 12 of the 22 merchant sites the second sample's
queries found selling from their own site, 55%, at the top of its range); and
the shipping-plugin part of Q9 (one shop, 14%, shows an Indonesian courier
plugin).

Failed: Q1 (the combined group reached 29, against 30–40); the managed-stock
half of Q4 (15% against 30–55%); the connector half of Q6 (one of seven, 14%,
against 0–10%); Q8 (the contact page placed none of the four unplaced
shops, against 30–70%); and the other parts of Q9 (Elementor one of seven, a
payment-gateway plugin one of seven, a WhatsApp plugin four of seven,
LiteSpeed six of seven, Cloudflare five of seven, all outside their ranges).

### The decision rule, applied to the combined group

1. **Too few shops.** The combined Indonesian group has 29 shops, at least
   25, so the rules below are applied.
2. **The dollar rule.** One of the 29 shops (3%) could connect, conditionally,
   which is fewer than 20%, and the currency is the sole blocker for 9 (31%),
   which is at least 10%. The rule that a shop prices in US dollars is
   therefore brought to the product owner as a product decision: whether the
   connector sells in the shop's own currency, here rupiah written with no
   decimals. It is entered in [`00-open-questions.md`](00-open-questions.md)
   with these numbers.
3. **Other sole blockers.** No other reason alone stops 10% or more of the
   combined group. The decimals of a dollar shop stop one shop (3%), and more
   than 200 products stops none alone, so nothing more is entered.
4. **The realistic lab.** The profile of a second, realistic lab shop takes
   the six plugins visible on at least a fifth of the combined group, which
   is fewer than eight, so all of them enter: Elementor, Contact Form 7, the
   Xendit virtual-account plugin (`woo-xendit-virtual-accounts`), Click to
   Chat for WhatsApp, Elementor Pro and Google Site Kit. No multi-currency
   plugin reaches 10% (two shops, 7%). The hosting set-up behind the profile
   is Cloudflare in front and LiteSpeed as the server; no separate cache layer
   reaches a fifth. The catalogue is 113 products, the median, priced in
   rupiah at no decimals, with 74% simple products.
5. **Bot protection.** None of the 29 shops is blocked at step 1, which is
   under 3%, so bot protection is recorded and nothing follows. This share
   was measured from an Indonesian network and is a lower bound for the live
   channel. Separately, 161 sites across both samples answered the front page
   with a Cloudflare challenge before their platform could be seen.

Rules 6 and 7 stand as the first results gave them. The second sample adds
one more shop to rule 6's count, by a dropped connection, and no European
shop.

## The catalogue ceiling, read from these counts

Added on 2026-10-22, after both samples, when the product owner asked for the
connector's ceiling of 200 products to be raised so that it covers nine shops
in ten. No decision record says where 200 came from: it was a constant in the
connector's first commit, and the comment beside it gave as the reason that
every product was a separate publish while the merchant held the page open. This section is not part of the
pre-registered census and decides nothing the census's own rules decide.

The counts are the `X-WP-Total` of the first listing page of each shop whose
listing could be read and carried the header: 26 Indonesian shops across both
samples, 16 European and 6 American, 48 in all. The share of them a ceiling
covers is the share with at most that many products.

| Ceiling | Indonesia (26) | Europe (16) | United States (6) | All (48) |
| --- | --- | --- | --- | --- |
| 200 | 62% | 69% | 100% | 69% |
| 1,500 | 92% | 81% | 100% | 90% |
| 2,000 | 92% | 88% | 100% | 92% |

The ceiling is set at 2,000. At 1,500 the whole group is just under nine in
ten (43 of 48) and Europe at eight, so one shop more or less would move the
answer; 2,000 takes in 44 of 48, and no ceiling below 3,380 covers more. The
shops it leaves out are the four largest: 3,380 and 6,149 products in
Indonesia, 4,347 and 9,773 in Europe. Products are counted as the Store API counts them, so a variable
product is one, not one per variation.

### What a catalogue of that size asks of the shop

The import used to check each product with its own request and eleven
requests for the shop's settings beside it, four products at a time, so a
shop of 2,000 products would have been asked some 24,000 authenticated
requests with up to 48 at once. On a throwaway copy of the integration lab
holding 1,990 products, it made 23,995 requests over 122 seconds. The import
now reads the shop's settings once and the protected product documents a
hundred to a request, judged by the same code as the single check, with at
most four requests in the shop at once. On the same shop it made 146 requests
over about 5 seconds (20 listing pages, 11 settings, 20 protected lists and 95
checks that a download's file refuses a request without an order), and the
whole import, publishing included, answered in 8.6 seconds, 6.9 seconds when
run again. Both versions published the same 916 cards, set 92 products aside
to fix and passed over 982. A shop of 2,050 products was refused after 21
listing pages, with no protected request and its cards left as they were.

The lab is a local container with no other plugin and answers in a tenth of a
second, so these times are a floor. The census timed its own hundred-product
listing request, which is the request an import repeats once per hundred
products: across the 34 shops with at least a hundred products, from the test
host's Indonesian network, it took a median of 4.5 seconds, 6.4 at the
ninetieth percentile and 8.0 at most. The protected requests on real shops
were not timed. If they cost about what a listing page costs, an import of
2,000 products from such a shop would take about two minutes, mostly the 21
listing pages read one after another, and about three at the ninetieth
percentile; that is an estimate, not a measurement. The import runs inside
the merchant's request. Neither Caddy in front of the dashboard nor the
dashboard's own server limits how long a response may take; the test host's
ingress is configured outside this repository and was not read. Firefox gives
up on a response after five minutes by default; other browsers were not
checked. A shop slow enough to come near that is the case for moving the
import out of the request, which is the product owner's decision.
