# The product card

*This page describes `@nuanu-ai/agentify` {{sdk-version}}. A change to the public contract arrives in a new package version.*

Your SDK integration writes and publishes the cards, and remains their source
when a product or price changes. The whole path, from an empty project to a
test sale, is on [The first test sale](/quickstart).

The working words handler, order and agent are defined on [The first test
sale](/quickstart).

A card is the description of one product in a catalogue: everything the agent
sees before buying, and everything it decides to buy from. One requirement
follows from that and runs through every field: an agent has to be able to buy
from the card, which means assembling a correct purchase and getting back what
it expected.

The page begins at the smallest card that sells and adds one field at a time,
each of them under the need that asks for it. If what you came for is a lookup
rather than a first reading, [every field of a card](#every-field-of-a-card) is
in one table at the end.

## The smallest card that sells

<<< @/examples/card/access-monthly-short.json

That is a whole card, and there are three facts in it: what you sell, at what
price, and what the agent receives. Published as it stands, it sells: an agent
finds it in a catalogue, buys it, and your handler delivers against it. Nothing
further down this page is needed for a product that works like this one.

All five of its fields are required, and no card goes without them.
`merchant_item_id` is your own key for the product. `title` and `description`
are what the agent reads while it is choosing. `price` is what it pays.
`result` is the shape of what it receives once you have delivered.

The five sections below take those fields one at a time, and the last of them
is where a declared field grows a longer spelling. After that the card itself
starts to grow, and every addition arrives under the need behind it: input the
agent has to send you, goods that leave later than the answer to the purchase,
a price worked out at the moment of purchase, and words that help an agent find
the card at all.

### Two identifiers

A product has two keys, and they appear at the same moment. Our catalogue `id`
is issued when the card is published, and it is what lives in the catalogues,
in the orders and in the receipts. Your `merchant_item_id` is set by you: it is
the identifier the product already has in your database.

The second key saves you a lookup table. An order arrives carrying your own
key, so there is nothing to translate from our numbering into yours. It is also
the point of connection that survives you publishing your cards again.

### Title

A short line by which the product is told apart from its neighbours in a
listing. It reaches the agent in our own catalogue, beside the description and
the price; a catalogue outside ours carries the description alone.

A title has to be there, it has to be more than blank space, and it is [plain
text](#the-words-on-a-card-are-plain-text) on one line. No length is measured
and nothing is shortened or rewritten, so what you write is what an agent is
shown, whole, and a title long enough to be a paragraph is one nothing on our
side will stop. What the limit on its length ought to be is not settled.

### Description

The description is read by the buying program, so you write it differently from
one meant for a person. A program needs facts that distinguish: what exactly
the buyer receives, what task it is good for, what is not included, what the
limits are. "The best offer on the market" is empty to a machine, while
"incoming messages only" settles whether the product fits.

A description is at most 500 characters. That ceiling is the one the discovery
catalog documents, not ours and not the payment protocol's: the description is
the one field of your prose that goes out to a catalog whole, and a card longer
than this is refused at publication rather than being cut to fit somewhere you
would never see it happen.

A description is [plain text](#the-words-on-a-card-are-plain-text) as well, and
it may run to several lines.

### Price

A price in the card is required in every case: it is what the agent sees in a
catalogue while it is choosing, and it is what ends up in the receipt when the
sale goes through at it. For a product with a fixed price nothing more is
needed: the price is true until you change it.

A price is an amount and a currency, and `'5.00 USD'` above is those two
written as one string, with a single space between them. Either spelling can be
written on a card; the longer one is in [the same card, written out in
full](#the-same-card-written-out-in-full).

Five kinds of price are refused at publication, and each refusal names the
half of the price that is wrong and what it said:

- an amount with fewer than two digits after the dot, such as `500` or `5`. The
  amount is in dollars (five dollars is `5.00`, and a cent and a half for a
  product priced per call is `0.015`), so a number counted in cents is never
  listed as that many dollars;
- an amount with more than six digits after the dot, such as `5.0000001`. Six
  places are all USDC carries, so a longer amount has no exact charge, and we
  do not round one;
- an amount above zero and below `{{smallest-price}}`, such as `0.009` or
  `0.000001`, however many digits it has after the dot. `{{smallest-price}}`,
  in `USD` or `USDC` alike, is the smallest price we sell at, and it is a floor
  we set ourselves. The payment network refuses payments below a minimum it
  does not publish. On the test network a purchase at `0.01` test USDC was
  carried where one at `0.000001` was refused; on the live network the minimum
  has not been measured (see [What is not settled
  yet](#what-is-not-settled-yet));
- a currency other than `USD` or `USDC`, which buyers pay as the same number
  of USDC ([What they pay in](/money#what-they-pay-in)), because we hold no
  exchange rate to charge anything else at;
- a price of zero, because a request to pay nothing asks for something that
  cannot be done: a free item is offered from your own site, without a
  payment.

Where the price is not fixed but worked out when somebody buys, the card
carries a price check as well, and that is [further down this
page](#a-price-worked-out-at-the-moment-of-purchase).

### Delivery result

The shape of what the agent receives once the delivery has gone through: a
link, a key, a number, a set of fields. It sits in the card next to the
purchase parameters, and it is how the agent sees before paying what it is
actually buying.

A declared field is a name and a type, and the type may be `string`, `number`,
`integer` or `boolean`. Those four are the whole language, so a date, a list or
a choice from a set travels as one of them. Where the name says enough,
`access_url: 'string'` is the whole declaration. Where it does not, write the
field out and give it a `title`, a line of human words that the agent reads
beside the name. It is [plain text](#the-words-on-a-card-are-plain-text) on one
line, as the card's own title is:

```ts
result: {
  access_url: { type: 'string', title: 'The link to sign in with' },
  expires_at: { type: 'string', title: 'When it stops working' },
}
```

Those two spellings declare the same field. A title is worth writing wherever a
name such as `expires_at` could be read as a date, a duration or a number of
seconds, because the agent has your field name and nothing else to go on.

We pass the delivery to the agent as it is: the handler returns JSON to this
shape, and we neither rewrite it nor rename anything in it. So the declaration
has to match what the handler really sends, in both directions: a promised
field that does not arrive is a mismatch, and so is a field the card never
declared. A mismatch does not reach the agent: we refuse the delivery, name
the fields that are wrong and leave the order where it was, so your handler can
send the right thing. You find out about the mismatch, and the buyer does not.

Where that order has already ended, because its deadline ran out while the
handler was being fixed, the refusal names the ending as well as the fields
and does not invite another attempt at a sale there is nothing left to deliver
against.

Where a handler has got everything wrong at once, the refusal's sentence is held
to a single line rather than allowed to grow into a paragraph nobody reads. A
field your card declares and your handler got wrong is one item in that line,
and where there are more items than fit, the sentence names the first few and
says how many are left. Every field your card never declared goes into a single
item listing all of them at once, and that item is cut at a fixed length with
the cut marked, so a handler that sent a hundred names nobody asked for is told
the first several of them and that the text went on, without a count of what was
left out.

That cut is the sentence's alone. The same findings travel beside it as a list,
and the list leaves nothing out. A field your card declares and your handler got
wrong is one finding there, carrying the path to it, a code and words a person
can act on. The fields your card never declared are one finding between them,
with an empty path, since there is no path to a name the card never had, and
all of those names inside its own words ([when a call on an order does not go
through](/orders#when-a-call-on-an-order-does-not-go-through)).

Every field of the result is required until you mark it `required: false`. The
result is a promise, and a delivery missing a promised field does not go
through as a delivery. A promised string that arrives empty counts as missing,
because an empty access code gives the buyer nothing to use.

A card declares at least one field here, and at least one of them has to arrive
every time. A result that might be entirely absent tells the agent nothing
about what it is paying for, and a card carrying one is refused at publication.

## Input the agent has to send you

Some purchases cannot be carried out from the card alone. Whatever your
delivery needs that only the agent can give, such as an email address to send
the link to, a country, a period or a name to put on a licence, goes in
`params`, and the
agent is shown it before it buys. A product whose delivery needs nothing leaves
the field out, as the card at the top of this page does.

<<< @/examples/card/access-monthly-params.json

That is the same product with one parameter added. A parameter is declared in
the same small language as a delivered field: the same four types, and the same
choice between the type word alone and the field written out. This one is
written out because it carries two things a type word cannot: the mark saying
the agent has to supply it, and the line of words saying what it is for.
Everything else on the card is unchanged, which is the rule about the shorter
spellings: they belong to fields rather than to cards, so writing one field out
leaves its neighbours alone.

The `required` mark means the opposite here from what it means in the delivery
result. A declared result field arrives unless you say otherwise, because it is
a promise you made before the money moved; a parameter is one the agent may
leave out unless you mark it `required: true`, because it is something you are
asking for. A parameter the agent sends empty stays empty on its way to you,
since that is input it chose to give.

Nothing checks this field against your delivery, and it is where the card's
main requirement breaks. A parameter your delivery needs and the card does not
name produces a purchase you cannot fulfil, and you end up refusing it instead
of making a sale. No check of ours can see that, because neither we nor the contract
know what your delivery needs; getting it right is yours.

## Goods that leave later than the answer

A card that names no fulfillment mode is synchronous, and it is stored and
shown as though it had said so: the goods go to the agent in the answer to the
purchase, which is what both cards above do. Where they cannot go back that
quickly, the card names another mode, and the agent sees it before it pays.
The mode decides when the buyer is charged and how the sale behaves when
something fails, so the product decides it:

| Your product | `fulfillment` | When the buyer is charged |
| --- | --- | --- |
| Your API hands it over within {{sync-response}} of the payment check, every time: a key, a link, a document | `'sync'`, the default | after the goods came back |
| It takes longer, such as a profile to provision or a supplier to ask, and can be delivered a second time without loss | `'async'`, with a deadline of your own or {{default-async-fulfillment}} | at the moment of purchase |
| A physical product a carrier takes to the buyer | `'ship'` | at the moment of purchase, at the price with shipping and any tax your price handler names |
| A download from a WooCommerce shop | `'async'`, set by the connector | at the moment of purchase |
| A physical product from a WooCommerce shop | `'ship'`, set by the connector | at the moment of purchase |
| Every order has to be confirmed by hand before the buyer pays | none: no mode lets you confirm an order before the buyer pays | not offered |

What happens inside each mode is on [Orders and fulfillment modes](/orders),
and one handler can serve products in different modes, telling them apart by
`merchant_item_id`.

An asynchronous card can carry one deadline of its own,
`fulfill_deadline_seconds`: how long you may take to deliver. It runs from the
moment the buyer is charged, which for an asynchronous product is the moment of
purchase, so the clock is already going when the order reaches your handler,
and it covers every attempt we make to deliver that order to you. Name it, and
the agent sees it before it buys.

Leaving it out does not leave you off a clock. {{Default-async-fulfillment}} applies instead, the
agent sees that deadline on your card in the catalog as if you had named it, and an
order that runs past it is unfulfilled exactly as one past a number of your
own would. That deadline is ours to set rather than the card's, so naming your own
is the way to keep the time yours.

A synchronous card has no such field, because how long to wait for a
synchronous answer is set by us, the same for every product: {{sync-response}}, from
the moment the payment checked out. Every limit, and what happens when each
runs out, is in [Every time limit](/orders#every-time-limit).

## A parcel sent by a carrier

A physical product that a carrier takes to the buyer is a card with
`fulfillment: 'ship'`. The buyer is charged at the moment of purchase, as for
goods that leave later, and the order ends when you record that a carrier has
the parcel; how that goes is on [Orders and fulfillment modes](/orders).

Such a card differs from every other in four ways. It names
`ship_within_seconds`, the time you have to hand the parcel to a carrier,
counted from the charge and at most thirty days; the agent sees it on the card,
and on the order as the instant the parcel has to be shipped by. It declares no
`result` and no `fulfill_deadline_seconds`, because what the agent receives is
the record of the shipment rather than goods you describe. It asks for its
price with your price handler (`price_check: 'handler'`), and that answer is
the whole price with shipping and any tax, for the place the parcel goes: the
price on the card is the goods without shipping or a tax that depends on the
place. And it asks for no address among its
`params`, because the purchase carries the address in a block of its own.

Answering the price question with "not available" refuses the sale, and on a
parcel that can mean the product is gone, you do not ship to that place, or the
address lacks something your carrier needs; the agent is told the purchase did
not happen. The price an agent pays does not cover duties the recipient may owe
at the border, so say in the card's description where that can happen.

An asynchronous card and a parcel's card are published only once you have
given your shop's site, and are refused with `no_seller_site` until then. The
buyer pays before delivery, so it needs somewhere to read your cancellation and
refund terms and to ask about a purchase that did not arrive. You set the site
in your dashboard's Settings or with `POST /v0/seller-name` ([your seller name
and site](#your-seller-name-and-site)). Such a card published before you gave
a site leaves the catalogue and refuses new purchases until you give one, and
you do not have to publish it again when you do. Orders already paid for
continue to fulfillment.

## A price worked out at the moment of purchase

Where the price is not fixed, because it comes off a rate, a supplier's cost or
what is in stock this minute, you add a price check to the card, and the check
and the card's price work together. The check's answer is stronger than the
card's price: when it answers, the sale goes at the price it named; when it is
silent, we take the price from the card, and what follows depends on the
fulfillment mode ([What can go wrong](/failures)).

On an asynchronous product with a check, the card's price is there for exactly
one purpose: to show the agent roughly what the purchase will cost while it is
choosing in the catalogue. The sale itself goes only at the price the check
named, because the buyer is charged at the moment of purchase, so a silent
check starts no purchase and the card's price is not a fallback. Put the
ordinary price of the product there rather than a zero or a placeholder: the
agent decides from it whether to look any further.

The check answers what the product costs and whether it is there right now.
Agentify asks it before the buyer pays, and no order exists until a payment for
that price is verified. Until then, any change to the card, its price or its
title alike, cancels the price your handler named, and so does a change to
where you are paid, so the agent has to ask for a new price. Publishing the
same card again unchanged, as your process does each time it starts, leaves
the price standing. Once a payment is accepted, the order keeps the price and
the fulfillment terms it was sold under.

The question travels the same channel as the orders: you put a price handler,
the one you register under `on('quote', …)`, beside the order handler in the
same process. Nothing of yours faces outward: you need no public address and no
open port.

```ts
agentify.on('quote', async (q) => {
  const item = await lookupItem(q.merchant_item_id)

  if (!item.in_stock) {
    return q.unavailable(item.checked_at)
  }

  return q.available({ amount: item.price, currency: 'USD' }, item.checked_at)
})
```

The subscription channel is authenticated when it connects, so your side does
not have to check that a price question really came from us.

So a card's price check is always `price_check: 'handler'`. A second way of
asking is designed for a business whose price is worked out by a separate
pricing service the order handler cannot reach: a price hook, an https address
of yours that we would call instead. We do not call it yet. A card that
names an address is therefore refused at publication: accepted, it would be a
setting nothing acts on, and you would find out from a synchronous product
quietly selling at its listed price or an asynchronous one quietly refusing
every sale.

The question your price handler receives looks like this:

<<< @/examples/quote-request/purchase.json

The field `purpose` says why we are asking. Today it always reads `"purchase"`:
there is an agent behind the question, buying right now. A handler should
accept the other value, `"poll"`, all the same, though nothing sends it yet.

The field `price_id` identifies this one price question. At most one order
goes through under it, and it arrives again with that order, so you can
recognise the price you named. `expires_at` bounds how long the price you name
can still be paid for, and Agentify judges that by when the paid request
reaches it, rather than by when the agent signs or when the charge executes.

A price question opens no order and reserves no stock, so answer it without
setting goods aside or opening a checkout session for the buyer: an agent may
never pay for the price it asked for. The question lives only while Agentify
waits for your answer, and a restart of Agentify forgets it. Stock and
fulfillment begin with the paid order.

The answer carries these fields:

| Field of the answer | Type | Required | Example |
| --- | --- | --- | --- |
| `available` | boolean | required | `true` |
| `price` | an amount and a currency | required where `available` | `{ "amount": "5.00", "currency": "USD" }` |
| `as_of` | a timestamp, ISO 8601 | required | `"2026-08-26T10:15:00Z"` |
| `quote_reference` | 1 to 512 printable ASCII characters | optional where `available` | your own reference to the facts behind the price |

Agentify stamps `quote_reference` together with the price and returns it, byte
for byte, on the order once it is paid. The buyer can read it in the payment
request of the 402, and it may reach the facilitator or a discovery listing, so
put no secret, no personal data and no protected download address in it.
Keeping the facts behind your price in the reference lets your handler
recognise them later without storing a question nobody paid for. The SDK's
`q.available` takes no reference, so add it to the answer it builds:

```ts
agentify.on('quote', async (q) => {
  const item = await lookupItem(q.merchant_item_id)

  return {
    ...q.available({ amount: item.price, currency: 'USD' }, item.checked_at),
    quote_reference: `rate:${item.checked_at}`,
  }
})
```

In full it looks like this:

<<< @/examples/quote-response/available.json

The price in an answer is held to the rule a card's price meets at
publication: at least `{{smallest-price}}`, in `USD` or `USDC`, with two to
six digits after the dot. An answer that breaks it is refused with the reason in the refusal's own
words, and unless a corrected answer arrives while we are still waiting, the
purchase goes on as though you had not answered.

The mark `as_of` says which moment the answer is true for, and it separates
"went and checked just now" from "handed over what was in the cache". A price
handler is given it as the last argument; a call made without it stamps the
moment of the answer itself, which is right only if you really did look just
then. An answer out of a cache is dated by the moment that cache was filled, as
in the example above.

We carry the mark and we do not yet weigh it. It travels into the order your
handler is given and into the record of the sale, so whoever reconciles a
charge afterwards can see how old the number behind it was, but nothing
compares it against anything. An answer stamped a year ago is honoured for
exactly as long as one stamped a second ago, because a price's life runs from
the moment your answer reached us rather than from the moment it says it was
true. So nothing here catches a stale price on your behalf: a handler answering
out of a cache is the one deciding how old that cache may get.

The answer that there is none carries no price at all, and an answer carrying
both is refused rather than read one way or the other:

<<< @/examples/quote-response/unavailable.json

An `available: false` answer to a purchase closes it before any money moves,
and no order appears on your side. A price you name holds for {{quote-ttl}},
counted from the moment your answer reaches us; we set that number, and it is
the same for every card. The `expires_at` in the question is the outer edge of
that same term rather than a second number. It is worked out when the question
goes out, before anyone knows when your answer will land, so it falls a little
later. What happens once a price has run out is in [Time ran out](/orders).

We wait {{quote-response}} for your answer, counted from when we ask rather
than from when your process takes the question, and a question unanswered by
then counts as silence. Your price questions pass a gate of their own, which
hands your process only questions that can still be answered in that time and
never one whose wait has ended. Paid orders are handed out before price
questions. The SDK handles up to four unfinished messages at once, and more
instances divide that work further.

When all of your price questions are taken, a new one waits briefly for a
place, within the same {{quote-response}}. If no place comes, a synchronous
card sells at its card price without asking your handler, and your order
handler can still refuse before the charge. An asynchronous card or a parcel is
refused with `seller_busy`, HTTP 429, with `Retry-After: 2`, before your price
is asked, and the agent asks again two seconds later. When your handler is
asked and names no price in time on such a card, the purchase is refused with
`seller_busy` as well, with `Retry-After: 10`, and the agent is told that a
silence which repeats means your price check is not answering. An answer that
the product is unavailable refuses the purchase with `not_selling`, which the
agent is told not to retry, and nothing is charged. Another seller's price
questions never take your places. The same rules hold for a WooCommerce shop,
and [What can go wrong](/failures) lists them with the other refusals.

Agentify keeps no stock counts: only you know how much of anything there is. So
a product that can run out is worth listing with a check, because without one
we sell at the card's price and hear that it has run out only from your refusal
at delivery.

## Words that help an agent find the card

The catalogues outside ours are listings other people run, where an agent
searches for what it needs. A card can carry `tags`, words describing the
product for that search, and they go out with the card into those listings,
beside the description.

A card carries at most five of them, each between 1 and 32 characters of plain
typewriter text (unaccented letters, digits, spaces and the punctuation on a
keyboard, so a curly quote or a long dash is refused), with no space at either
end, and no two the same but for their case. Those limits belong to the
listings rather than to us, and they are checked here because what a listing
does past them is drop the word without telling anybody.

A card with no tags leaves the field out rather than sending an empty list, and
we invent none for it.

## The words on a card are plain text

The title, the description and the `title` of each declared field are read by
the buying program exactly as you write them, and nothing between you and it
renders HTML. So they are plain text: the characters themselves, with no HTML
markup, no HTML character references and no control characters in them. A
card is refused at publication where one of them carries any of these:

- HTML markup: a tag such as `<p>`, `</p>`, `<br/>` or `<a href="…">`, or the
  opening of a comment, `<!--`;
- an HTML character reference: an ampersand, a number or a name of two or
  more letters and digits, and a semicolon, such as `&amp;`, `&nbsp;`,
  `&#8217;` or `&#x2019;`;
- a control character: a tab, a carriage return, a line break in a title, or
  anything else from U+0000 to U+001F, U+007F, and U+0080 to U+009F.

A description may carry line breaks, written as a line feed (U+000A), because
it may run to paragraphs. A title, and the title of a declared field, is one
line.

The characters markup is made of are not refused on their own. `Tea & coffee`,
`AT&T`, `5 < 10`, `a -> b` and an address written as `<jane@example.com>` are
text, and they are published and shown as you wrote them.

A refusal names the field, what was found in it, how many times, and the
character where the first of it begins, counted from one in the same units as a
description's length, where an emoji counts as two. Nothing is cleaned or
rewritten for you: stripping tags or decoding references on our side would put
words in front of an agent that you never wrote, and you would not find out.
Write the characters themselves, `&` rather than `&amp;` and `’` rather than
`&#8217;`, and leave the markup out.

The rule is checked when a card is published. Reading a card back, and showing
it in a catalogue, does not check it.

## The same card, written out in full

Three fields on this page have a shorter spelling and a longer one, and a card
that uses none of the shorter ones says exactly what the card at the top says.
Here is that product again with nothing written short:

<<< @/examples/card/access-monthly.json

Three spellings have changed and nothing about the product has. The price is
the amount and the currency, which is what `'5.00 USD'` stood for. Each field
of `result` is `{ type: 'string' }`, which is what a bare type word stands for.
And `fulfillment: 'sync'` is written down instead of left silent.

The two are also one card after we accept it: the short spellings are opened
out when the card arrives, so what we store, what an agent reads in a catalogue
and what your delivery is held to are the long form either way. Reading a card
back gives you the long form, whichever way you wrote it.

Write whichever suits the way your cards are made. A card assembled by a
program has no use for the shorter spellings and is easier to generate without
them; a card written by hand is shorter and plainer with them. Neither is a
mode you switch on, and one card mixes them field by field: write the price
short and the purchase parameters in full, put a title on the field that needs
one and leave its neighbours as type words.

## Every field of a card

The sections above unfold these one at a time, each with an example. Here they
are together, the required fields first.

| Field | Type | Required |
| --- | --- | --- |
| `id` | string | not yours to fill in: we issue it at publication |
| `merchant_item_id` | string | required |
| `title` | plain text, one line | required |
| `description` | plain text, up to 500 characters, the discovery catalog's ceiling and not ours | required |
| `price` | an amount as a string, and a currency; or the two as one string | required |
| `result` | the shape of what the agent receives on delivery | required, except on a parcel's card, which has none |
| `params` | the shape of the purchase parameters | required where the delivery needs input |
| `fulfillment` | `'sync'`, `'async'` or `'ship'` | optional; a card that names no mode is `'sync'` |
| `fulfill_deadline_seconds` | how long you may take to deliver | optional, and only on an asynchronous card |
| `ship_within_seconds` | how long you have to hand a parcel to a carrier, from the charge, at most thirty days | required on a parcel's card, and only there |
| `price_check` | `'handler'`: your price handler is asked the price and availability at the moment of purchase | optional |
| `tags` | words describing the product for an agent's search, at most five | optional |

## How large a card may be

An agent is asked to pay in one HTTP header, `PAYMENT-REQUIRED`. Node's HTTP
client and `fetch` read at most 16,384 bytes of a response's headers in all; we
keep half of that as a margin for the response's other headers and for whatever
stands between us and the buyer, so a card is published only if its header
stays within 8,192 bytes. A card whose header could grow past that is refused
with the finding `challenge_too_large`, which says how large the header would
get.

A priced purchase also carries Agentify's price stamp in that header, and the
stamp takes part of the 8,192 bytes. At its widest, with a `quote_reference` of
512 characters that JSON has to escape, the stamp is 2,173 characters and
takes about 2,900 bytes of the encoded header; with no reference it takes about
1,100. A card is measured with the widest stamp before it is published, so
those 2,900 bytes are set aside for every card, whatever reference your handler
sends, and the card's own fields have the rest.

The header is the challenge's JSON in base64, which turns every three bytes into
four. It carries the description and the tags once, and the name of each
declared field: a required purchase parameter's name three times, an optional
one's twice, and a result field's once, so a description of 500 Chinese
characters, 1,500 bytes as text, takes about 2,000 bytes of the header. To bring
a refused card within the limit, declare fewer fields, give them shorter names,
or shorten the description.

## Refusal codes

A handler's refusal carries a short code and a reason a person can read. Both go
to the buyer's agent, with the order's status and word for word: the code is
what it branches on, the reason is what it shows a person. Write the reason for
that stranger rather than for your own logs. What happens to the order after a
refusal is on [Orders and fulfillment modes](/orders); here is the vocabulary of
codes.

These are the words you send us about an order you cannot fill, and they are a
different set from the ones we send you when a call of yours does not go through
at all ([when a call on an order does not go
through](/orders#when-a-call-on-an-order-does-not-go-through)).

The set is open, and a code of your own is fine where none of the common ones
fits. Three we understand the same way every time, and those are the ones to
prefer.

| Code | When to send it |
| --- | --- |
| `out_of_stock` | there is none: sold out, no places left, the supplier did not hand it over |
| `invalid_params` | the purchase parameters are no good for the delivery |
| `cannot_fulfill` | it cannot be delivered, for some other reason |

Prefer `out_of_stock` for "there is none": the share of purchases that run
into missing goods is meant to be measured by that code, and nothing counts it
yet ([What is not settled yet](/failures#what-is-not-settled-yet)).

## Who checks a card before it is published

Two of us: the check we ship, run on your side, and we ourselves before the
card goes into the catalogues. Both sides look at the same thing, whether an
agent can assemble a correct purchase from this card, and both read the card
by the same contract, so a card the first accepts is not turned away by the
second for its shape or its price.

They answer in the same shape as well. The check hands you a list of findings,
each naming the field it is about and what is wrong with it; a publish we refuse
carries that same list under `problems`, inside the `error` its answer comes
back with, and that error's code is `card_rejected`. Four findings can stand in
our list that no check on your side can see, and all of them are about you
rather than the card: no name set for buyers to read (`no_seller_name`), no
wallet set for your share of the sales wherever a payment settles
(`no_payout_wallet`), on the live channel only, no approval from the operator
yet (`no_operator_approval`), and on an asynchronous or a parcel's card, no
site set for your shop (`no_seller_site`) ([publishing a card](/quickstart)). The check on
your side cannot measure the header a card is paid through either, so a card it
passes can still be refused for its size ([how large a card may be](#how-large-a-card-may-be)).

## Your seller name and site

Of the findings about you rather than the card, the operator's approval is the
operator's to give, and the others are fixed in your dashboard's Settings, the
name and the site also with a call: `POST /v0/seller-name`
with your key as `Authorization: Bearer <key>`, which the SDK has no method
for. Its body names `seller_name`, `seller_site` or both, and a field you leave
out stays as it was. Your code can read the wallet with `GET /v0/payout-wallet`,
which on the live channel also names a replacement waiting to take effect, and
no call sets it.

The name is at most 32 characters of printable ASCII with no space at either
end, and it is plain text: HTML tags and codes such as `&amp;` are refused,
and an ampersand written as text passes. The site is `https://` and the domain
name of your shop in lower case with nothing after it, such as
`https://yourshop.example`. Every agent reads both beside each of your cards
and on the status of each order, as where to take what an order cannot
answer, and is told that you gave them and we did not check them. Either can
be changed, and neither can be removed once given.

## Updating a card, and taking one off sale

Updating is the call that created it. Publishing again under the same
`merchant_item_id` updates the card that is there rather than creating a second
one: the key is yours, and we find what is already published by it. So a card
can be uploaded from a script without checking first whether we have it.

An update changes what the next sale is made under, never a sale already made.
An order is held to the result its card declared when the agent asked to buy,
and the order does not carry that declaration to you. So while orders sold
under an older result are still open, deliver to them what they were sold
with, or leave the result as it is until they have closed: a delivery in the
new shape is refused for them with `delivery_does_not_match_card`.

Taking a card off sale is a pause, on Products in your dashboard or
with a call: `POST /v0/cards/<id>/pause`, where `<id>` is the catalogue `id`
the publish returned, takes one card off sale, and `POST /v0/selling/pause`
stops all of them. Each is called with your key as `Authorization: Bearer
<key>`, and the SDK has no method for either. Paused,
the card stops being visible in the catalogues, and the orders still open
against it play out in the ordinary way. Nothing removes a card altogether.

## What is not settled yet

- The maximum length of a title.
- The limits on a description beyond its length: the language it is written in,
  and the ban on addressing the buying program or instructing it.
- The exact shape that describes the purchase parameters and the delivery
  result.
- How long a delivery deadline may be, and whether an asynchronous card ought
  to be required to name one at all, rather than fall to a default of ours.
- The shape of the field a card declares a price check in.
- Whether the vocabulary of recommended codes grows beyond three: we decide
  that from the refusals the pilot actually turns up.
- How a card is removed altogether rather than paused, and how long that
  takes.
- The scheduled refresh of price and availability between purchases. It is
  designed, and nothing runs it yet: a poll's answer would take a card out of a
  catalogue's listing until the next poll, and no sale would go through on a
  poll's answer alone, because a question with money behind it is asked again.
- Whether the bounds on your price questions, four at once and sixteen started
  in any one second, are the right ones: they have not been measured against
  real shops.
- Whether an answer whose `as_of` is too old is refused rather than honoured,
  what counts as too old, and what a sale does when one arrives.
- The price hook, an address of yours that we would call instead of your price
  handler. A card cannot name one yet, and when one can, your side will need
  something to check a request against to know that it came from us. A price
  handler has neither question, because the subscription channel is
  authenticated when it connects.
- The smallest payment the live payment network carries. It does not publish
  its minimum, and a payment of `0.01` has not been tried on the live network,
  so a price at or above `{{smallest-price}}` could still be refused when a
  buyer pays. The
  buyer is then told that the payment network will not carry that amount and
  that neither paying again nor buying again at that price will pass.
