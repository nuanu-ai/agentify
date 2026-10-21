# Selling from a WooCommerce shop priced in another currency, at the merchant's own rate

Date: 2026-10-21. A design proposal. It decides nothing by itself: what the
product owner has already said is marked as his word, and every other point is
a proposal that waits for his word or for the decision record drafted at the
end.

## Why this note

Agentify lets AI agents buy from merchants. The buyer pays in USDC, a dollar
stablecoin, on the Base network, and every price Agentify handles is written in
US dollars or in USDC, one for one: a card's price, the answer to a price
question, the order and the receipt (`packages/contracts`, the documentation
page "Money"). A merchant who runs a WooCommerce shop can connect it instead of
writing code, and the connector imports the shop's eligible products as cards
and fills paid orders in the shop ([ADR-0023](../decisions/0023-woocommerce-connect.md);
the merchant's view is the documentation page "Selling through a WooCommerce
shop"). Today the connector imports only from a shop priced in US dollars
written with two decimals.

A census of real WooCommerce shops (`55-woo-shop-census.md`) found that of 29
Indonesian shops one could connect, and that the currency alone, with the
shop's own number of decimals allowed, is the sole reason for nine of them
(31%). Of the Indonesian shops whose catalogue could be read, 85% price in
rupiah, and 22 of the 23 rupiah shops write their prices with no decimals.

On 2026-10-21 the product owner decided first that such shops sell, converting
at the exchange rate at the moment of purchase. The same day he changed the
design: **the merchant sets the exchange rate in the connector's settings, the
dashboard shows Coinbase's public rate beside it as a reference while it is
set, and every rate the merchant sets is kept as history.** He also decided the
scope: **any currency for which Coinbase gives a reference rate and whose
minor unit is zero or two; other currencies are refused at Connect with plain
words.** Those two are his word. The rest of this note proposes how to do it.

Tax support for the connector is being finished separately and is measured in
`56-woo-tax-probe.md`. Where WooCommerce calculates tax, the connector sells a
download at its price with the tax inside it and a parcel at the total the
shop's cart charges for the buyer's place, and takes an order on when its total
equals what was paid. Everything below works on those amounts as the shop
writes them, so a price that already includes tax stays one amount, converted
once.

## Where the conversion lives

The conversion lives in the connector, and nowhere else. The connector already
stands between the shop and Agentify's public contracts: it reads the shop's
prices, answers price questions with an amount, creates the shop's order and
holds that order to what was paid. Each of those steps gains one translation,
from the shop's own currency into US dollars on the way out and a comparison in
the shop's currency on the way back, and the gateway, the SDK, the cards, the
price answers and the receipts go on carrying US dollars exactly as they do
now. The price rule in `packages/contracts/src/price-rule.ts` keeps refusing
every currency other than USD and USDC, which stays true of every price that
reaches the gateway. Nothing in the public contract changes, and a merchant who
integrates through the SDK never meets a rate.

This follows the rule that a shop connector adapts the shop to the public
contracts while the core and the SDK acquire no shop-specific business rules.
A shop priced in rupiah is a fact about that shop, and the merchant's rate is a
setting of that connection, as its key and its shop address are.

Three other places were considered and rejected. Putting a currency and a rate
into the public contract, so that a card could be priced in rupiah and the
gateway would convert, widens the surface every integrator must learn and
gives the gateway a rate it must source, keep and defend, for the benefit of
one kind of merchant whose shop already knows its own prices. Converting in the
gateway without changing the contract has the same cost without the honesty of
saying so. Asking the merchant to install a multi-currency plugin so the shop
itself answers in dollars fails on the facts: such plugins were visible on 7%
of the Indonesian shops in the census, several of them choose the currency by
the visitor's country, so the connector reading from a server in Germany could
be shown a different currency from the merchant's own customers, and the shop's
orders would then be written in dollars beside a ledger the merchant keeps in
rupiah.

## Which shops, and how the connector knows their currency

The merchant does not choose a currency. The shop's currency is a fact the
connector already reads: the public Store API's `prices.currency_code` and
`prices.currency_minor_unit` when the merchant presses Connect and at every
import, and the `woocommerce_currency` and `woocommerce_price_num_decimals`
settings in the price check, whose answers go into the fingerprint a price is
bound to. A shop in US dollars sees no rate and nothing about it changes.

A shop in another currency is admitted when the currency is within the scope
the product owner set. This note reads "minor unit zero or two" as two
conditions, and that reading needs his confirmation. The first is the
currency's own: ISO 4217 writes it with zero or two decimals, which admits the
rupiah, the euro, the pound, the yen and the like and refuses the three-decimal
dinars of Kuwait, Bahrain and Jordan. The second is the shop's: its Number of
decimals setting, the precision every WooCommerce total is written at and the
connector matches at, is zero or two. A rupiah shop at no decimals and one at
two both qualify, and so does a euro shop that writes no cents. Coinbase's own
list of currencies (`/v2/currencies`) gives the same smallest units for the
currencies checked (IDR, EUR, GBP 0.01; JPY, VND 1; KWD, BHD 0.001), but the
connector would read the ISO table rather than lean on Coinbase for it.

The other condition of the scope is that Coinbase gives a reference rate for
the currency. Connect asks Coinbase once. A currency Coinbase does not list is
refused with plain words: the shop sells in that currency, Agentify can sell
only from shops in currencies it can show a reference rate for, and nothing
was changed. A Coinbase that does not answer at Connect is a different
statement from "no reference exists", and the proposal is to say so and ask
the merchant to try again, rather than admit a currency nobody has checked. The
Connect-time refusal of every shop not priced in dollars, which is being added
on the branch that finishes tax support, is replaced by this check rather than
kept beside it.

Because the scope is any currency of zero or two decimals, the variable the
tests must cover is the shop's number of decimals, zero and two, rather than a
list of currencies. Limiting the scope to rupiah would have saved little
testing, since the dollar path stays and a rupiah shop at two decimals exists,
and would have added a list someone keeps.

A shop in scope connects, and its import publishes nothing until a rate for its
currency is set. The WooCommerce screen says that the shop sells in, for
example, Indonesian rupiah (IDR), asks how many rupiah one US dollar buys, and
shows Coinbase's rate beside the field. If the shop's currency changes later,
the price check sees a different currency in the settings it reads, and every
purchase of that shop's cards is answered "not available" before payment until
a rate for the new currency exists; a rate set for the old currency is never
applied to the new one.

## The rate the merchant sets

The rate is the merchant's own price decision, and it is written the way it is
said in Indonesia: how many units of the shop's currency one US dollar buys,
"18,000 rupiah per dollar". The same direction is used for every currency, so
for the euro and the pound it is the inverse of how those rates are usually
quoted ("1.12 dollars per euro"). The reference beside the field is written in
the same direction, and the guard below catches an entry made the other way
round, since 1.12 against a reference of 0.89 is 26% away.

A connection holds one current rate per currency. Saving a rate adds a version
to an append-only history and never edits or deletes one, so every price ever
answered can be traced to the version it used. The proposed fields of a
version are these: its own identifier; the merchant account and the shop
origin it belongs to; the currency code; the rate exactly as typed, as a
decimal string, with at most six digits after the dot so a euro rate such as
0.890545 can be written; the moment it was saved; the person whose session
saved it; the reference rate shown at that moment, its source and the moment it
was read, or a note that no reference could be read; the difference between
the two as shown; and whether the merchant confirmed a rate past the guard. The
current rate of a currency is its latest version.

Agentify never sets, adjusts or suggests a rate on the merchant's behalf, and
takes no currency margin: the buyer pays the US dollar amount the merchant's
rate gives, and Agentify's commission is the same 0.1% of that payment it is
for every sale.

### The reference rate and where it comes from

The product owner's question was where the rate comes from. In this design it
comes from the merchant, and the reference is there to catch a mistake, not to
price anything. The reference is Coinbase's public exchange-rates endpoint,
`GET https://api.coinbase.com/v2/exchange-rates?currency=USD`. It is read only
when the merchant opens the WooCommerce screen of a shop in another currency or
saves a rate, from the dashboard's server, never in the purchase path. A
Coinbase that is slow, down or wrong therefore cannot stop, delay or change a
sale.

What was checked on 2026-10-21 between 13:12 and 13:19 UTC, with read-only
requests and no key: the endpoint answered 200 with 659 rates for a dollar,
IDR among them at 18,046.29; with `currency=USDC` it gave 18,045.11. Coinbase's
documentation says the endpoint needs no authentication and that its rates are
for one unit of the base currency, and says nothing about how often the rates
change, a rate limit, or terms of use. The answer carries no time of its own:
its `last-modified` header is the moment of the answer, and `cache-control` is
`no-store`, with an inner header suggesting a sixty-second cache. Sampled every
fifteen seconds for five minutes, the IDR value changed twice, at about 13:14:51
and 13:18:12, by less than a rupiah each time. An unknown base currency is
answered with an error document, "base currency not recognized", rather than
an empty list. Coinbase's developer platform terms of service could not be read
(the page answered 403 to both an automated fetch and a plain request), so
whether showing its rate inside another product is permitted is not known; a
person should read those terms before this is built. The general rate limit
Coinbase publishes, 10,000 requests an hour, is stated per key or signed-in
user and does not say what applies to an anonymous request; a reading per
screen opened is far below any limit of that kind.

On the day, Coinbase's rate stood close to the others: 0.34% above the rate the
European Central Bank published for 20 October (17,985 rupiah per dollar,
derived from its euro rates), 0.54% above the price at which the Indonesian
exchange Indodax was buying USDC for rupiah (17,949), and level with Indodax's
last trade (18,040).

Because Coinbase's answer has no time of its own, the screen says when Agentify
read it, not when Coinbase computed it.

### Sources considered for converting live, and why none is used

The first design converted at a market rate read at the moment of purchase,
and several sources were checked for it. None is needed once the merchant sets
the rate, and each had a reason against it as the price itself.

Bank Indonesia's JISDOR is the official reference rate for the dollar against
the rupiah, a volume-weighted average of interbank trades. Bank Indonesia's
page says it is published at 15:15 Jakarta time on business days, so it is up
to a day old and absent at weekends; no machine interface for it was found, and
the bank's site reset the connection to every request sent from here.

The European Central Bank publishes euro reference rates that include the
rupiah, around 16:00 Central European time on working days; at 13:12 UTC on
the 21st its file still held the 20th. The bank states that the rates are for
information only and that using them for transactions is strongly
discouraged. Frankfurter, a keyless mirror of those rates, answered 17,986 for
the 20th with a one-day cache, and marks its first version deprecated in favour
of a second.

A Chainlink IDR/USD price feed exists on Base mainnet, updated when the rate
moves 0.3% or at least every hour, during foreign-exchange market hours; Base
Sepolia, where the test channel runs, has no such feed, only USDC/USD. Reading
it means a call to the chain in the purchase path and a feed the test channel
cannot exercise.

Indodax's public ticker answers USDC/IDR and USDT/IDR without a key, cached for
thirty seconds: on the day USDC bought at 17,949 and sold at 18,040, with about
134,000 USDC traded in a day against about 6.8 million USDT. It is the rate a
merchant could actually sell at, but it is one exchange's thin market, its
terms for use by another product were not found, and the merchant may sell
elsewhere.

Two commercial services were tried for comparison. ExchangeRate-API's keyless
endpoint answered 18,001.60, updated once a day at about midnight UTC; its
terms of use, linked from the answer, were not read. Open Exchange Rates
refused a request without a key with a 403 and "missing_app_id", asking for a
sign-up.

Underneath all of them is the question of who bears the gap between a
mid-market rate and what the merchant gets when selling USDC. With a rate
Agentify chose, the merchant would bear a spread set by somebody else's
choice of source; with the merchant's own rate, the merchant prices that gap
in, as they price everything else.

### The guard against a typo

A rate more than 10% away from the reference needs the merchant's explicit
confirmation of that exact number before it is saved. The threshold is this
note's proposal, not the product owner's word. Its reasons: the
mistakes worth catching are a digit too many or too few, which move the rate
tenfold, and an entry made the wrong way round, which moves a euro rate by a
quarter; a merchant who prices in the spread and fees of their own exchange
moves the rate by a few percent, and the sources above differed from each
other by about half a percent on the day. A threshold of ten percent catches
every slip of the first kind and leaves the second alone. It does not catch
two digits swapped inside the number, 18,405 for 18,045, which is 2% away;
nothing that leaves a merchant free to set their own rate can.

On the screen, for a rate typed with a zero missing, the guard would read:
"1,800 rupiah per dollar is 90% below Coinbase's 18,046, read at 13:12 UTC, so
a product priced Rp 250,000 would sell for 138.89 USD instead of 13.86 USD;
type the rate again to save it." When the
reference cannot be read, the rate is saved, and the history and the screen
say "Coinbase's rate could not be read just now, so this rate was not compared
with anything."

A rate is a price lever, and it is a new one in Agentify's dashboard: today a
dashboard session cannot change what a WooCommerce card costs, and with this
design it can. A session taken over by somebody else could set an absurd rate,
confirm it past the guard, and buy the shop's goods for cents. The payout
wallet, the one setting that sends money elsewhere, is protected by a message
to every account of the merchant and a 48-hour wait. A wait would be wrong for
a rate, which a merchant must be able to correct at once, but the message is
cheap: the proposal is that every saved rate is announced to every account of
the merchant, as the first saved wallet is. Whether a rate far outside the
guard, say more than half away from the reference, is refused outright rather
than confirmed is for the product owner; it cannot apply while the reference is
unreadable.

### The rate's age

The screen shows when the rate was set, the reference now and the difference
between them: "Your rate, 18,000 rupiah per dollar, was set on 9 October;
Coinbase's rate read just now is 18,046, 0.3% above it." The difference is
shown more prominently once it passes the guard's threshold. This is a warning
and nothing more: age never stops a sale, because a setting that silently
takes a merchant off sale is a defect of the setting, and a merchant who sells
at an old rate is making a pricing decision the shop's own prices make as
well. The screen is the only place the age is shown; nothing is mailed about
it.

## The arithmetic

The connector matches amounts at two decimals today, because a US dollar shop
writes its totals in cents (`USD_SCALE` and its helpers in
`apps/dashboard/src/woo-catalog.ts`). The shop's own currency and its number of
decimals, zero or two, replace that fixed scale wherever the connector reads or
compares a shop's amount: the product's price, the cart's total, the shipping
rate and the order's total are read and compared in the shop's currency at the
shop's precision, character for character as now. Only the amount sent to
Agentify is in US dollars.

That amount is the shop's amount divided by the rate, rounded up to the cent.
The arithmetic is in integers, scaling the rate by its digits after the dot,
so no floating-point fraction ever decides a cent. A product priced Rp 250,000
at 18,000 rupiah per dollar is 13.888… dollars and sells for 13.89; the buyer
pays at most one cent more than the exact conversion, and the merchant gains
that fraction, at most a cent a purchase, which at that rate is Rp 180. On a
cheap product the cent is a larger share: Rp 5,000 is 0.2777… and sells for
0.28, about 0.8% up. A result always has at least one cent, so a price never
rounds to zero; the smallest amount the facilitator settles is a separate open
question.

Card prices may carry two to six decimals, and the proposal uses two. Six would
put the buyer within a millionth of a dollar of the exact conversion, but
"13.888889 USD" reads like an error to the person behind the agent, and the
cent the buyer gives up at two is the smallest amount a dollar price is
normally written in. Rounding down was rejected because it would have the
merchant receive less than their own price at their own rate, and rounding to
the nearest because it does so half the time.

Nothing is ever converted back. The paid dollar amount is compared with the
dollar amount bound to the price, and the shop's order is compared with the
shop's amount bound to the price, so a rounding cent never meets a rupiah
total.

## The flow

**At import.** For each eligible product the import converts the shop's price
at the current rate and publishes it as the card's price, with the card's
`as_of` the moment it was published, as every card has. The card already says
its price is checked at purchase, and the catalogue's contract already says the
number shown may not be what the sale goes through at, so the converted price
is the indicative number an agent compares while choosing, and nothing new is
promised. Saving a new rate runs the same import the Import button runs, so
the cards follow the rate; a shop without a rate publishes nothing and the
screen says why.

**At purchase.** The price question is answered as it is now, from the shop's
current price for a download or the cart's total for the buyer's place for a
parcel, in the shop's currency, and the connector converts that amount at the
current rate. Where the shop calculates tax this is the amount with tax
inside it, exactly as research 56 established, converted once. The current
rate is read from the dashboard's own database, so the conversion adds no
request to the four seconds the connector has to answer. The record that binds
the `price_id` to the product's fingerprint (`dashboard_woo_quotes`) also binds
the amount in the shop's currency, the rate version and the dollar amount
answered, and the fingerprint covers the shop's currency and its decimals in
place of the literal "USD" it holds now. A shop with no rate for its current
currency answers "not available"; nothing is ever priced at a guessed or
remembered rate.

**At the order.** The shop's order is created as it is now, the line naming the
product, so the shop computes its own total in its own currency. It is taken
on when that total equals the shop's amount bound to the price and the payment
equals the dollar amount bound to it. A parcel's shipping rate is still not
bound: the order asks the shop again and ships at the rate that makes up the
bound amount in the shop's currency. The cart's and the order's currency must
equal the currency the rate was set for, so a currency switcher answering in
another currency is refused rather than converted.

**What the order records.** The connector's ledger of the order keeps, among
its sold facts, the amount in the shop's currency, the rate version, the rate
itself and the dollar amount, and the gateway's order already records the
USDC paid. The WooCommerce order already carries Agentify's order identifier,
the commission and the payout contract in its metadata; it would also carry the
USDC paid and the rate with the moment it was set, so the merchant's own shop
shows what the rupiah total was paid with.

A rate changed between a price answer and the order is honoured at the rate
bound to the price. Refusing such a purchase before the shop order is created,
as a product changed after its price is refused, was considered and is
rejected, because a WooCommerce card is charged before
its goods: by the time the order reaches the connector the buyer has paid, so
refusing leaves a paid order unfulfilled for a merchant's routine edit made
seconds earlier, and the 30 seconds a price lives make the case rare but real.
A changed product is refused because the goods are no longer what was priced;
a changed rate leaves the goods and the shop's amount as they were, and the
merchant agreed to the bound rate when the price was answered. This point needs
the product owner's word.

## What each party is told

**The buyer** is told a price in US dollars and pays it in USDC; the price
answer and the receipt say the amount and the moment, as they do for every
card. Nothing tells the buyer a market rate, and nothing should: the dollar
amount is the seller's price, set by the seller's own rate, and claiming
anything about a market would be a claim Agentify cannot stand behind. The
proposal is to say nothing more to the buyer. If the product owner wants the
buyer told "at the seller's rate of 9 October", the contract has no place for
it today: the price answer carries an amount and a time, the receipt a sale
price, and the card's description is the merchant's own text, which the import
does not edit and which must fit in 500 characters, a limit some shops'
descriptions already exceed (`55-woo-shop-census.md`).
Saying it means an optional field on the sale price in the order and the
receipt, such as the amount in the seller's currency and the moment the
seller's rate was set, which is an addition to the public surface and would
need its own decision. This is the product owner's to decide.

**The merchant's Orders screen** shows, for an order from such a shop, the
amount in the shop's currency, the USDC paid and the rate it was paid at with
the date the rate was set: "Rp 250,000 in your shop, paid as 13.89 USDC at your
rate of 18,000 rupiah per dollar, set on 9 October".

**The merchant's guide** says that a shop priced in another currency sells at
the rate the merchant sets, how many units of their currency one dollar buys;
that the buyer pays the dollar amount their rate gives, rounded up to the cent;
that they receive USDC, and what that is worth in their currency when they sell
it depends on their exchange and its spread, which their rate should allow
for; that Agentify takes no currency margin, and its 0.1% commission is of the
USDC paid; that the Coinbase rate on the screen is a reference shown to catch
a mistyped rate, read when the screen is opened, with no time of Coinbase's
own; and that an old rate keeps selling, so keeping it current is theirs. The
guide's sentence that a shop must be priced in US dollars goes, and the Money
page's sentence that there is no exchange-rate conversion is kept true by
saying that a connected shop's own currency is converted at the merchant's own
rate before any price reaches Agentify.

**"No rate"** reads on the screen as "Your shop sells in Indonesian rupiah
(IDR). Set how many rupiah one US dollar buys; nothing is published until you
do." To an agent, a card whose shop has no rate for its current currency
answers "not available" before payment, the seller's no, which a shop's
readable answer has ruled out; it is not the silence that means nobody knows.
How a "not available" gives its reason is already an open question.

## Risks and limits

A wrong rate is the merchant's, and the guard catches only the large ones. A
rate that drifts because the merchant does not update it is also the
merchant's: if the rupiah weakens and the rate stays, dollar prices are higher
than the merchant needs and sell less; if it strengthens, the USDC received is
worth less in rupiah than the shop's price. The age shown on the screen is the
only defence, by design.

A wrong or manipulated reference cannot price anything. At worst it makes the
guard ask for a confirmation it should not, or fail to ask for one it should,
and the history records what was shown.

A Coinbase outage removes the reference and the guard with it while it lasts;
rates are still saved, with the note, and sales go on.

The window between a price answer and the order is the 30 seconds a price
lives, and the binding closes it: the price, the shop's amount and the rate
version are fixed together.

A large order changes nothing in the rounding, which is bounded by a cent
whatever the amount, but it is where an old rate costs the merchant most. Each
order is one product today.

The import's ceiling of 200 products is the other large blocker: 37% of the
Indonesian shops in the census have more products than that, and it was the
first reason recorded for 10 of the 28 that cannot connect. It is a separate
matter and this note does not address it.

## The legal frame

What follows are facts with their sources, not advice. They bear on any
Indonesian merchant accepting USDC through Agentify, with or without a
conversion, and they are a question for the product owner's legal counsel.

Indonesia's Currency Law, Law 7 of 2011, requires the rupiah in every
transaction whose purpose is payment, in the settlement of other obligations
paid in money, and in other financial transactions within Indonesia (Article
21(1)), with limited exceptions such as certain state budget transactions,
grants to or from abroad, international trade, foreign-currency bank deposits
and international financing (Article 21(2)). It forbids refusing the rupiah
offered as payment (Article 23), and as enacted it punishes using another
currency in such a transaction by up to a year's confinement and a fine of up
to Rp 200 million (Article 33); one secondary source says the penalties have
since been adjusted by Law 1 of 2026, which this note did not read. The
articles were read in secondary summaries, not in the official text, whose
portal refused the request. Sources: [Hukumonline on Article
21](https://www.hukumonline.com/klinik/a/lt4e1ec7bb46b8a/), [Hukumonline on
Articles 23 and 33](https://www.hukumonline.com/klinik/a/sanksi-hukum-jika-menolak-pembayaran-dengan-uang-receh-lt54b5dda19ea9d).

Bank Indonesia's position, stated on 13 January 2018, is that virtual
currencies including bitcoin are not legal tender and cannot be used as a
means of payment in Indonesia, citing the Currency Law, and that payment
system operators and financial technology operators, banks and non-banks,
including payment gateways and e-wallets, are prohibited from processing
transactions in virtual currency under Bank Indonesia Regulations
18/40/PBI/2016 and 19/12/PBI/2017. Source: [the Cabinet Secretariat's
publication of Bank Indonesia's
warning](https://setkab.go.id/en/bank-indonesia-warns-all-parties-not-to-sell-buy-or-trade-virtual-currency/).

Crypto assets were regulated as commodities traded on futures exchanges by
Bappebti, the commodity futures regulator. Under Law 4 of 2023 on the
financial sector, supervision passed to the Financial Services Authority (OJK)
on 10 January 2025, under Government Regulation 49 of 2024 and OJK Regulation
27 of 2024 on trading digital financial assets including crypto assets, which
treats them as digital financial assets traded through licensed exchanges.
Source: [OJK's press release on the
transfer](https://ojk.go.id/en/berita-dan-kegiatan/siaran-pers/Pages/Bappebti-Transfers-Regulation-and-Supervision-Duties-on-Digital-Financial-Assets-Crypto-Assets-and-Derivatives-to-OJK-BI.aspx),
[SSEK on the change](https://ssek.com/blog/from-bappebti-to-ojk-indonesias-crypto-regulation-just-changed/).

The merchant-set rate changes nothing in this frame. The shop shows rupiah
prices and its orders record rupiah totals, but the buyer pays in USDC either
way, and whether that is a payment within Indonesia in another currency, and
whether Agentify's part in it is processing a payment in virtual currency, are
the questions counsel would answer. Neither depends on who chose the rate.

The sentence proposed for the Money table of `00-open-questions.md`, not added
by this note:

| Whether an Indonesian merchant may accept USDC through Agentify for goods priced in rupiah, given the Currency Law's requirement of the rupiah for payments in Indonesia and Bank Indonesia's position that crypto assets are not a means of payment, and what that makes of Agentify's own part; answered before an Indonesian shop sells on the live channel | product owner, with legal counsel | `58-woo-shop-currency.md` |

## What it would take

### The decision record

A new decision records what money means for a connected shop, and ADR-0023's
sentence that products are imported "in US dollars" is edited in the same
change. The draft of its decision, not accepted:

> Agentify charges in US dollars paid as USDC, and no public contract carries
> another currency. A connected shop priced in another currency, one ISO 4217
> writes with zero or two decimals and Coinbase gives a reference rate for,
> written by the shop at zero or two decimals (the product owner, 2026-10-21),
> sells at a rate its merchant sets: how many units of that currency one US
> dollar buys, kept per currency as an append-only history of who set it,
> when, and the reference shown. Agentify never chooses, adjusts or applies a
> market rate and takes no currency margin; the reference is shown to the
> merchant when the rate is set, never read in a purchase. A price converts the
> shop's own amount at the current rate, rounded up to the cent, and binds its
> `price_id` to the shop's amount, the rate version and the dollar amount; the
> shop's order is made and matched in the shop's currency and is held to the
> bound rate. A shop with no rate for its current currency has no price.
>
> Rejected: a market rate read at purchase, which makes a feed's outage or
> error a stop or a wrong price in every sale and leaves the spread to whoever
> chose the source; a currency in the public contract, which every integrator
> would learn for one kind of shop; conversion in the gateway; a multi-currency
> plugin in the shop.

### The connector, in outline

At Connect, the refusal of shops not priced in dollars is replaced by the scope
check above, with plain words for a currency outside it and for a Coinbase
that did not answer. A new append-only table holds the rate versions, and the
WooCommerce screen gains the rate field, the reference read from Coinbase with
a short timeout, the guard, the rate's age, and the notice sent to the
merchant's accounts on every saved rate. The fixed dollar scale and its helpers
become helpers of a scale given by the shop. The eligibility check compares the
shop's currency with the connection's currency and its decimals with zero or
two, the Store API's `currency_minor_unit` with the shop's decimals setting,
and the cart's currency with the rate's; the fingerprints carry the shop's
currency and decimals. The import converts and publishes nothing without a
rate, and saving a rate runs it. The price answer converts and records the
shop's amount, the rate version and the dollar amount with the `price_id`. The
order and its recovery are matched in the shop's currency against the bound
amount, a parcel's shipping rate is found against the bound amount, and the
order's metadata and the ledger's facts gain the rate and the amounts. The
Orders screen, the merchant guide and the Money page change as described, and
so do the comments in the price rule that say Agentify holds no exchange rate.
Before the first external merchant, fingerprints already recorded need not
stay valid, so the old shape is removed rather than kept beside the new one.

The tests follow the rules already in force: the conversion and its rounding at
both of the shop's scales, including the cent that rounding up adds and a
product whose conversion is exact; the guard on both sides of the threshold
and with no reference; the history never rewritten; a shop with no rate, and a
shop whose currency changes, answered "not available" before payment; a rate
changed after a price answer, honoured at the bound rate; a cart answering in
another currency refused; and a dollar shop unchanged.

### A check before building

The probe of live rate sources that the first design needed is not needed
now, since no source is read in a purchase. What the reference still needs is
small and is not an experiment: a person reads Coinbase's developer platform
terms of service, which could not be read from here, and says whether showing
its rate on the merchant's screen is permitted; if it is not, the reference
moves to another keyless source from the list above under the same rules. The
facts measured on the day, that the endpoint answers without a key, covers
every currency in scope that was tried, changes every few minutes and answers
an unknown currency with an error, are enough for a reference read when a
screen opens.

## What needs the product owner's word

His word so far covers the merchant-set rate with Coinbase's reference and its
history, and the scope of currencies. Still his to decide: the reading of
"minor unit zero or two" as both the currency's and the shop's; what Connect
does when Coinbase does not answer; the guard's threshold of 10% and whether a
rate far outside it is refused rather than confirmed; the notice to every
account on a saved rate; rounding up to the cent; honouring the bound rate when
the rate changes after a price answer; whether the buyer is told anything
about the seller's rate, which would mean a field in the public contract;
saving a rate re-running the import; and the decision record drafted above.
The legal frame is for his counsel.
