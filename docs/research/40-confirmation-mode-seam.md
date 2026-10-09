# The confirmation mode: built inside, closed at the door

A card names one of four fulfillment modes. In three of them the merchant is
handed the order itself, and the money moves at the moment the mode fixes,
before the goods or after them. The fourth, `fulfillment: "confirm"`, asks the
merchant first: they are asked whether they will deliver, nothing is charged
until they say yes, and the agent pays only after that. It exists for a
merchant who answers by hand, and no merchant on the platform does yet. This
note is for whoever opens the mode: what is already built, what holds it shut,
and what opening it touches.

## What is built

The order machine carries the mode completely. `fromAwaitingConfirmation` and
`fromConfirmed` in `packages/core/src/orders/machine.ts` are real arms: a yes
moves the order to `confirmed` and asks for the agent to be invited to pay, a
no or silence past the deadline closes it with nothing charged, and a payment
that fails after a yes closes it with an event to the merchant. The two
deadlines of the mode, the merchant's time to answer and the agent's time to
pay after a yes, are real deadlines in `deadlines.ts`, and the machine counts
redeliveries of the confirmation request the way it counts an order's. The
tests beside those files hold the behaviour, and the portal's order tables,
which are test fixtures of the machine, already include the mode's endings.

The merchant's side is described on the portal's orders page: the request to
confirm arrives on the same subscription as orders, marked as such, carrying
the purchase parameters and the price, and the handler answers with one of the
two answers that hand nothing over, taking it on for yes and a refusal for no.

## What holds it shut, and why loudly

Nothing on the wire can carry the request. The worker stream has three kinds
of envelope (`packages/contracts/src/envelope.ts`) and none of them is a
confirmation request, so a merchant's handler could not tell one from a paid
order. Publishing a `confirm` card would sell the merchant a mode that cannot
be served, and the first they would hear of it is a request they mishandled.

Two doors therefore refuse it, and both say why. The card rules in
`packages/contracts/src/card.ts` refuse to publish a card whose fulfillment is
`confirm`, with the reason in the refusal and in the descriptions a client
generator reads (`FulfillmentSchema` and the card's rules text). The value
stays in the enumeration, because the mode exists in the model; what is
missing is its shape on the wire. Behind that, the gateway's runner
(`apps/gateway/src/app/runner.ts`) throws on the mode's two effects,
`invite_payment` and `dispatch_confirmation_request`, rather than invent a
message: a document on a merchant's stream that no contract describes is worse
than a stopped process, and reaching either means the first door failed.

The agent's side is the larger gap. How an agent is told that it may now pay
is not designed; the portal lists it among the things not settled.

## What opening the mode touches

The kinds of envelope are a closed list that several readers branch on, and
not all of them branch the same way. The SDK is guarded: `REGISTERED_AS` in
`packages/sdk/src/worker.ts` is typed over the contract's kinds and `dispatch`
ends in an exhaustiveness check, so a fourth kind stops the SDK compiling until
it has a registration word and an arm. Two other readers are not guarded, the
gateway's hand-out and the WooCommerce worker, and a fourth kind would pass
them without a compiler error, which is why the inventory below names them.

- the contract: a fourth kind and its payload schema in `envelope.ts`, which
  also puts it into the registry the JSON Schema export is built from;
- the merchant's yes and no: the machine already reads them in
  `awaiting_confirmation` from the existing answer, accept and refuse calls,
  and the portal describes them that way, but the descriptions of those routes
  in `packages/contracts/src/api.ts` speak only of orders; whether the answers
  need a route of their own is not settled;
- the publish gate in `card.ts`, the refinement and every description that
  names it, and the fulfillment row on the portal's cards page;
- executors for `invite_payment` and `dispatch_confirmation_request` in the
  runner, and with the first of them the agent-side design above;
- the gateway's hand-out in `apps/gateway/src/app/gateway.ts`, which treats
  every envelope that is not an order as finished once handed out, while the
  machine expects the confirmation request to be redelivered like an order;
- the WooCommerce worker in `apps/dashboard/src/woo-worker.ts`, which answers
  price questions and orders and skips every other kind;
- a handler arm and its affordances in the SDK;
- the portal: the confirmation section and the open list on the orders page,
  and, if the mode opens together with a messaging channel, the lines on the
  front page that say delivery by a message confirmed by hand is not
  available.

## When to open it

The trigger is a merchant who answers by hand, since that is what the mode is
for. A merchant reached through a messaging channel rather than through code is
the same trigger in other clothes: the third connection question in
`05-merchant-contract.md` and the order bridge in `06-prior-art-web2.md`
describe that idea, and if it is taken up the mode is opened with it rather
than twice. Parcels are the same case (ADR-0033): a shop that checks stock by
hand before a parcel is paid for is this trigger, and shipping with
confirmation is opened together with the mode rather than on its own.

Until then the product owner's position holds: the mode is provided for in
the architecture and not opened. The arms are not deleted for being
unreachable, and the wire is not opened for being nearly ready.
