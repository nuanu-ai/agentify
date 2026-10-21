# `@nuanu-ai/agentify`

Agentify publishes a merchant's existing products in its own catalogue, which
AI agents read and buy from. Each product gets a card there and a paid address
of its own, `/x402/<item>/purchase`, where an agent pays for it with the x402
payment protocol. The buyer pays into the merchant's own payout contract, which nobody
owns and nobody can redirect. It keeps the money until it is paid out, which
the merchant can do at any time, and then sends 99.9% to the merchant's wallet
and 0.1% to Agentify ([Money](https://agentify.ad/docs/money)).

This package is the merchant's side of it. It publishes the cards, receives
paid orders and price questions through one outgoing connection, and closes
each order with the goods or with a refusal. Nothing of the merchant's has to
be reachable from outside — the process opens that connection itself, so no
public address and no open port are needed.

## Before the first call

The key comes from the test channel's dashboard at
[test.agentify.ad/dashboard](https://test.agentify.ad/dashboard): sign in with
your email, and on API Keys issue a key, which is shown once. Before your first
card can be published, the dashboard also needs the seller name buyers will
see and, in Settings, the wallet your share of each sale is paid out to; a
publish without them is refused with findings that name what is missing.

## Install

```sh
npm install @nuanu-ai/agentify
```

Node.js 24 or newer is required. What arrives with it is our own contracts
package and zod underneath that, and nothing else.

## Test or live: the address decides

```ts
import { createClient } from '@nuanu-ai/agentify'

const agentify = createClient({
  apiKey: process.env.AGENTIFY_API_KEY,
  baseUrl: process.env.AGENTIFY_URL,
})
```

There are two channels, one address each. At `https://test.agentify.ad` you
build: payments settle on a test chain and the money there is not real. At
`https://agentify.ad` you sell, and it is. A key issued on one does not open
the other, and the key says which one you are holding: `csk_test_` for the
first, `csk_live_` for the second. This package picks neither address for you,
and your process's first log line names the one it started against and whether
the money there is real.

## A card, and the handler that fills the orders

The card is the whole of what an agent reads before it buys: what you sell, at
what price, and what the buyer receives. This one is complete.

```ts
await agentify.catalog.publish({
  merchant_item_id: 'access-monthly',
  title: 'One month of access to the service',
  description: 'Access for 30 days from delivery, renewal not included',
  price: '5.00 USD',
  result: { access_url: 'string', expires_at: 'string' },
})
```

Then say what this process answers with, and open the subscription. Paid
orders, price questions and order events all travel that one connection.
`grantAccess` below is the seller's own delivery; the handler returns its
answer and this package sends it, because an answer that has to be returned is
one nobody can forget to send.

```ts
agentify.on('order', async (order) => {
  const access = await grantAccess({ idempotencyKey: order.id })

  if (!access.ok) {
    return order.refused({
      code: 'out_of_stock',
      message: 'No seats left on that plan',
    })
  }

  return order.delivered({
    access_url: access.url,
    expires_at: access.expiresAt,
  })
})

await agentify.start()
```

The same order can arrive twice, after a dropped connection or a restart of
yours, so its `id` is also its idempotency key: pass it into your own delivery
system and the second arrival hands back the first result instead of delivering
again.

Up to four messages can be unfinished at once. Handlers for different orders
may overlap and finish out of order, so one slow order need not hold up the
next purchase or price question. An event waits for earlier handlers for its
order, and a repeat already running in this process shares that attempt.
Once all four places are occupied, polling waits for one to finish; price
questions can still expire under saturation. `stop()` waits for work already
started, including events waiting on their order, and draws nothing more.

A card we would not publish comes back as `ok: false`, with a code, a sentence a
person can read, whether repeating could change the outcome, and its findings
under `problems`. `deliver`, `refuse`, `accept` and `close` hand every failure back in
that same envelope, and throw only on a client built with no address. `catalog.publish`, `orders.get` and
`orders.list` throw an `AgentifyError` whenever no publish result or order came
back — a refused key included — with the same codes, the flag and the call it
happened on.

To stop Agentify accepting deliveries for an order, call its `close` method.
The optional message is your statement to the buyer, which their agent reads
as your words: plain text of at most 2000 characters, with no markup and no
control characters. A message that breaks that rule is refused before anything
is recorded.

```ts
const order = await agentify.orders.get(orderId)
const closed = await order.close({ message: 'Please contact our shop to continue.' })
```

Closing cannot be undone, moves no money and confirms no refund; you and the
buyer handle any refund or other agreement outside Agentify. A repeat of the
call keeps the first closure time and message. Two refusals leave the order as
it was: `fulfillment_complete` where the goods were delivered or the parcel's
shipment is recorded, and `nothing_to_close` where the order ended with
nothing charged.

An order read back carries `payment_status` for its original payment and
`merchant_closure` for your closure. Closing does not cancel a charge Agentify
had already sent to the facilitator. If that charge completes after you
closed, you receive `order.unfulfilled` with the reason `paid_after_closure`,
and the order stays on `orders.list({ open: true })` until you close it again;
that second closure records its own time and message. The whole rule is on
[Orders](https://agentify.ad/docs/orders#closing-fulfillment).

## The check that needs no key

```sh
npm exec --offline --package=@nuanu-ai/agentify -- agentify verify card.json
```

It reads a card the way we read it at publication and names what is wrong,
offline: no key, no address, no order raised, nothing asked of us. The same
check is exported as `checkCard`, for cards assembled in code rather than kept
in files.

That is one half of checking yourself. The other half — whether your handler
holds against a real order — is a test purchase you make yourself on the test
channel, buying your own card with an x402 client and test USDC; the
[quickstart](https://agentify.ad/docs/quickstart#_6-make-your-first-test-purchase)
walks you through one.

## Where the rest of it is written

The merchant documentation is public. [The first test
sale](https://agentify.ad/docs/quickstart) walks from an empty project to
a test purchase you make yourself. Beside it are [the product
card](https://agentify.ad/docs/cards) field by field, [orders and fulfillment
modes](https://agentify.ad/docs/orders) for delivering later rather than in
the answer to the purchase, and [what can go
wrong](https://agentify.ad/docs/failures). For whoever decides whether to
connect at all, [Connecting to Agentify](https://agentify.ad/docs/),
[Money](https://agentify.ad/docs/money) and the [common
questions](https://agentify.ad/docs/faq) are written for the owner rather
than the engineer.

## Versions

This is an early `0.x` pilot surface and the names in it can still change. A
release keeps working when Agentify adds to what it sends: a field it does not
know beside an order is left out of what your code receives, an event of a kind
it does not know is skipped with an `event_skipped` problem, and an order's
status or payment word, an event's reason, a call's result word or a price
question's purpose it does not know reads `unknown`
([details](https://agentify.ad/docs/orders#when-agentify-is-newer-than-your-package)).
What an order delivers is read exactly, and an unknown field or address shape
there fails loudly rather than reaching your handler narrowed. A rename, a
removal, a changed meaning or anything added to what an order delivers moves
the contract version, and a
process whose version Agentify does not share stops before it takes an order.
Every call names the package's release in its `user-agent`. What changed in each
release is in the
[changelog](https://github.com/nuanu-ai/agentify/blob/main/packages/sdk/CHANGELOG.md). Register `agentify.on('problem', …)`, which is where you
hear about that and about everything else that did not get through.

## License

Licensed under the Apache License 2.0. Distributions that include this package
must retain the notices required by that license, including the attribution to
Nuanu AI in `NOTICE`.
