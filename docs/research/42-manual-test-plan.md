# Manual product test plan: the merchant's path and the agent's, end to end

Date: 2026-10-10. A working protocol for a person who tests the product by
hand. It is rewritten freely between runs and is not a decision. The report of
each run is kept privately, outside this public repository; its template is
the last section here.

## What a run answers

In the week to 2026-10-10 the product changed in many places at once. The
gateway and the dashboard became one process. The merchant's side is called the
dashboard everywhere a person reads it, has a sidebar and an Integrations tab,
and a sign-in now returns a person to the section they were going to. An agent
now reads who sells — a seller name and the shop's own site — on every card and
every order. A card can describe a parcel: the buyer's address passes through
to the merchant and is erased once the merchant holds it, and the order ends
when the merchant records the shipment. A synchronous handler that answers
"accepted" is refused for its mode, a silence after an acceptance no longer
spends a delivery attempt, and the merchant's process receives one message per
poll. Dashboard forms refuse to act when the page was drawn for a different
signed-in address or the session ended. The scanner reads hostile sites safely
and obeys robots.txt. The automated suite checks each of these in isolation.
Nobody has yet walked the whole product after all of them landed together.

That walk is what this plan is for, and the question it answers is narrower
than "does it work". Can an engineer of modest experience, whom we have never
met, connect a shop through the SDK using only our public pages? Can a
stranger's agent buy from that shop without help? And does every order end in
a state that the agent, the merchant's code and the dashboard all read the same
way, and that tells the truth about where the money is? The people we expect to
integrate first are not senior engineers. Wherever the tester needs knowledge
that only the team has, that is a finding, even when the product behaves
correctly.

A run ends with one of three verdicts: ready for the first merchant we do not
control; ready once the named findings are fixed; not ready. The verdict names
the findings that decide it.

## The angles a tester looks from

Every case below is tagged with the angle it mainly serves, but any case can
produce a finding from any angle. These are the questions behind each tag.

**UX — a person in a browser.** The owner of a business or their engineer
using the site and the dashboard. Can a newcomer tell what to do next on every
screen? Is anything already known asked for again? Does a failure say what
happened and how to recover safely? Does a word appear that only the team
understands? Does the promise on the page match what the path then does? Are
reload, Back and a second tab intelligible? Is it clear before an action
whether money is real? Can "empty" be told apart from "unavailable",
"unknown" and "still processing"?

**DX — an engineer with the SDK.** How long from an empty directory to the
first card published, and to the first test sale. Where the engineer stopped,
and what they had to guess. How many separate ideas they had to learn before
the first sale, and whether each was needed for it. Whether each error names
the field or setting at fault and what to change. Whether the documentation and
the package agree: a code example that does not run as printed is a finding.

**AX — the buying agent.** An agent is a program, often a language model,
holding a task and a budget. Can it find the catalogue, read a card and decide
from the card alone what it will get, what it must send, when it pays and what
happens if the merchant fails? Does every error carry a code a program can
branch on and a sentence a model can act on? Does it know when to repeat a
call and when not to? Can it tell "I do not know yet" from "there is none"?

**State — the order's state machine.** After each action, the agent's view of
the order, the merchant's view (in the SDK and in the dashboard), the receipt
and the money must agree. Nothing is charged twice, nothing is delivered twice,
nothing that was charged disappears without a refund owed, and nothing waits
forever.

**Door — refused at once, or carried through.** The product's rule is that
what it cannot reliably finish is refused at the door with words a person can
act on, and what it accepts it finishes. For every input the tester tries,
decide which of the two happened. A refusal must name what to change. Anything
accepted that later fails quietly, or anything that accepts a setting and then
ignores it, is what this angle looks hardest for: such a finding is S1 where
money is involved and S2 otherwise (see "How to report").

**Claim — what goes outside.** A card, an order status, a receipt and the text
of an error are claims on which somebody else's agent moves somebody else's
money. For each of them ask four questions: what has been cut short and is that
said; what has been guessed and is it marked as a guess; what this turns into
with ten times the data (fifty cards, two hundred orders); and whether "I do
not know" sounds different from "I know there is none".

**Extra — entities nobody needed.** Keep a running list of every term, field,
button, setting and screen met on the way to a goal that the goal did not need.
Each one is something a stranger now has to learn. The list goes into the
report as it is, without judgement; the team decides what to remove.

## Who runs it, and with what

The plan is written for one tester who plays three parts in turn. First the
newcomer: a merchant's engineer who reads only the public site and the npm
package, knows enough Node.js to copy and run an example, and knows nothing
about stablecoins or x402. Then the agent: the buying program, played through
the stand console, through `curl`, and through a language model given only the
public addresses. Then the inspector, who drives the order's state machine on
purpose into each of its corners.

Two more people take part. The operator is the member of our team who runs
the test channel and the live one: they point the test channel at the build
under test, start the purchases that need real test funds, and own any account
made on the live channel. The product owner is the person who has the final
word on the product, and the only one who can allow Block G.

The order of these parts matters more than anything else in this plan. Block A
is a cold read and can be done honestly only once. Before Block A is finished
the tester does not open this repository — this plan included — its README, its
decisions or its research notes, and does not ask the team how anything works.
Whoever organises the run hands the tester Block A's "Do" column alone, and
the rest of this document once Block A is done; the expectations and the list
of suspicions further down would otherwise give the cold read its answers.
Every time the tester has to ask anyway, they write down what they asked and
why; that list is one of the most valuable things the run produces. From Block
B onward the repository is open to them.

What the tester needs:

- Three email addresses they can read, which can be one mailbox with
  plus-aliases (`name+main@`, `name+edge@`, `name+second@`). One address may request a
  sign-in link once a minute and three times an hour, so the aliases keep the
  sign-in cases from blocking each other.
- Two browser profiles and a private window; a phone, or the browser's
  responsive mode at 375 pixels wide.
- Node.js 24 and npm, and an empty directory outside any repository for the
  SDK path; for the local stack and the stand, also pnpm through
  `corepack enable` and `pnpm install` in the checkout.
- `curl` and `jq`.
- Docker with Compose v2, and a checkout of this repository, for the local
  stack and the stand console — from Block B onward.
- A chat with a language model that can fetch a URL, for the agent's
  cold-reading cases.

No wallet with funds is needed. Purchases on the test channel are started by
the operator; on the local stack nothing settles. The stand console needs a
buyer key all the same, written as `STAND_BUYER_KEY=0x…` with 64 hexadecimal
characters in `.env.stand` at the root of the checkout; any throwaway value of
that shape will do, since it holds nothing.

## Where it runs

| Environment | Address | What it is used for | Rules |
| --- | --- | --- | --- |
| Local stack | `http://localhost:8080`, started with `docker compose up --build` | The state machine, the agent's errors, everything that needs many purchases | Nothing settles and no money exists; sign-in messages appear in `docker compose logs app`; a merchant called `the_merchant` is seeded with two cards |
| Test channel | `https://test.agentify.ad` | The newcomer's path, real email, the npm package, real settlement on Base Sepolia with test funds | Shared and owned by the operator: ask before starting and do not move its deployment. Purchases are started by the operator, at most 0.01 test USDC each except a WooCommerce product at its shop's price; the plan needs about six of them, and the operator names the run's total before it starts. The operator's buyer never connects with the newcomer's merchant key, or it would take the newcomer's orders |
| Live channel | `https://agentify.ad` | Reading the public pages and the docs | Never a purchase. Block G runs here only on the product owner's word, and creates a real account |

Before the first case, record what is being tested. The test channel runs
whatever commit its `deploy-test` tag points at, and that is not always `main`:
on 2026-10-10 it pointed at a feature branch. Ask the operator to point it at
the commit under test, then record that commit
(`git ls-remote origin refs/tags/deploy-test`). Record the SDK version the
newcomer installed (`npm ls @nuanu-ai/agentify @nuanu-ai/agentify-contracts`),
and the commit the local stack was built from. The npm package can lag the test
channel, because the channel takes any commit while npm takes a release: the
parcel cases need an SDK release that carries parcels and their shipments, and
the newcomer installs whatever npm holds, as a stranger would. A case that
depends on a change not yet on npm is marked "blocked by release" rather than
failed.

## Order of work

The blocks run in this order. It goes from what every merchant and every agent
meets on every sale to what a few meet rarely, except that the cold read comes
first because it cannot be repeated. The priorities say what to keep when time
runs short: P0 blocks decide the verdict and are never skipped; P1 blocks are
skipped only with a line in the report saying so; P2 and P3 run when the run
has room for them.

| Block | What it covers | Priority | Where |
| --- | --- | --- | --- |
| A | The newcomer's path from the public site to the first test sale | P0 | Test channel |
| B | The agent's purchase: finding, reading, paying, collecting | P0 | Local stack, then test channel |
| C | The order's state machine in every mode and every way it can end | P0 | Local stack |
| D | What is refused at the door: cards, merchant settings, keys, client set-up | P1 | Local stack and test channel |
| E | The dashboard day to day: sign-in, cards, orders, receipts, keys, settings | P1 | Test channel, local stack for volume |
| F | Parcels: address, price by place, shipment, erasure | P2 | Local stack and test channel, after the SDK release |
| G | Rules that exist only where money is real | P3 | Live channel, only with the product owner's word |
| H | The WooCommerce connector, which is experimental | P3 | Test channel |
| I | The scanner, and the way from its report into the dashboard | P3 | Test channel |

The scanner comes last on the product owner's word: the product under test is
selling through the SDK, and the scanner is the front page a merchant may pass
through on the way. Block A still starts at the front page, but only to find
the way to selling; the scanner's own checks wait for Block I.

Exploratory time sits at the end of every block rather than in a block of its
own: once the listed cases are done, the tester spends some time trying to
break that block's promises in ways the plan did not think of, and records what
they tried even when nothing broke.

## How a case is read

Each block opens with the set-up it needs and closes with what to explore
freely. A case is one row: what to do, and what should happen. "What should
happen" comes from the public documentation, the screen's own words or the
product's rules; where the plan is unsure, it says "record" instead of
predicting, and the tester writes down what they saw. A mismatch between what
should happen and what happened is a finding even when the tester believes the
plan or the documentation is the one that is wrong; the finding then says
which of the two they believe and why.

After every case that moves an order, compare three views of it: what the agent
reads (the purchase answer, or the order's status address), what the merchant's
code reads (`agentify.orders.get(id)`), and what the dashboard shows on Orders
and Receipts. The dashboard words map to the agent's status words like this:
in progress — `in_progress`; delivered — `delivered`; shipped — `shipped`;
refused — `rejected`; payment outcome unknown — `payment_unresolved`; closed on
time limit — `expired`; closed when you left — `cancelled`; refund due —
`refund_due`; refunded — `refunded`; delivered, not paid — `delivered_unpaid`.
The three views disagreeing is a finding of the highest weight.

## Block A. The newcomer's path to the first test sale (P0)

Set-up: the main alias, a clean browser profile, an empty directory outside any
repository, and the operator on hand to start one or two purchases. The tester
has not opened the repository. Each purchase costs at most 0.01 test USDC, so
the card's price is `0.01 USD`.

The tester keeps two clocks for the report: from opening the front page to the
first card published, and from there to the first test sale. They also note
each stop: the moment they did not know what to do next, how long it lasted and
what got them moving again.

| ID | Do | What should happen | Angle |
| --- | --- | --- | --- |
| A-01 | Open `https://test.agentify.ad/` knowing only that "Agentify lets my shop sell to AI agents". Find how to start selling and how an engineer connects a shop. Do not type `/docs` by hand. | The front page offers a way to selling ("Came here to sell? How selling to agents works") and a header with Docs and Dashboard. Record every click and every word not understood on the way. | UX, Extra |
| A-02 | Read the documentation's front page as the owner of the business. Then answer, in writing and without looking back: what will I be asked, where does the money go, what do you take, what can I sell during the pilot, how do I stop. | Every answer is on that page or one link away. Record each question the page left open or answered in words the owner would not use. | UX, Claim |
| A-03 | Open the dashboard and sign in with the main alias. Follow the message to the end. | "Check your mail", then a message "Sign in to your Agentify dashboard", then a page "This link signs … in on this browser" with a button "Sign in as …". Opening the link alone signs nobody in; the button does. Then "Open a seller dashboard" with one button, "Open my seller dashboard", which asks for the seller name. | UX |
| A-04 | Choose a seller name. In Settings, give the shop's site and a payout wallet. The newcomer has no wallet: record what they do to get an address and whether the page helped. | The test channel's banner is on every page and says payments settle on Base Sepolia with test funds. A valid address is saved at once, shown in groups of four, and no message is sent. | UX, DX |
| A-05 | Issue a key named "first integration". Copy it. Reload the page that shows it. | The secret is shown once, starts with `csk_test_`, and a reload does not issue a second key. The list shows the key with "No calls recorded". | UX, Claim |
| A-06 | Follow the quickstart's install step exactly as printed. Then run `npm ls --all`. | One install command. The tree holds the SDK, its contracts package and zod, and nothing else. | DX |
| A-07 | Copy the client code from the quickstart into a file and run it as a newcomer would. | Record every change needed to make the printed example run: a file extension, a `"type": "module"`, a TypeScript runner, the environment variables. Each change the page did not mention is a finding. | DX |
| A-08 | Publish the smallest card from the quickstart, with the price changed to `0.01 USD`. | `ok: true` and a catalogue `id` beginning `item_`. The card appears on the dashboard's Cards with its product code, price, delivery "immediate" and state published. | DX, State |
| A-09 | Write the synchronous handler from the quickstart, register `on('problem', …)`, and start it. | The first log line says which gateway it started against and that the money there is not real. The process stays up and the problem handler stays quiet. | DX, Claim |
| A-10 | Run the card check exactly as the quickstart prints it, on the card from A-08 saved as `card.json`. | The card is reported complete as far as the contract can tell, the idempotency half says it could not be run, and the command exits 3. Record what the newcomer concludes from that exit code and whether a build script would treat it as a failure. | DX, Claim |
| A-11 | Ask for the first test purchase the way the documentation says. | The quickstart says an operator starts it and that there is no public way to ask. Record how the newcomer found an operator, and what they had to send. | UX |
| A-12 | The operator buys the card once. Watch the handler, the dashboard and, if the operator shares it, the buyer's output. | One order reaches the handler; the buyer receives the declared goods; Orders shows one delivered order tagged test; Receipts shows one receipt; the order reads `test: true`. Record the order and receipt identifiers. Optionally, find the transfer to the payout wallet on a Base Sepolia block explorer. | State, Claim |
| A-13 | Publish a second card, asynchronous: a new `merchant_item_id`, `fulfillment: 'async'`, `fulfill_deadline_seconds: 600`. Extend the one handler to tell the two cards apart by `order.merchant_item_id` — one client registers `on('order')` once, and a second process on the same key would split the orders — so that for this card it saves `order.id` and answers `accepted`; a separate step calls `agentify.orders.forId(savedId).deliver(...)` a minute later. The operator buys it once. | The buyer gets an order in progress with an address to read it at, then the goods at that address after the delivery. The receipt appears only after the delivery. | DX, State |
| A-14 | Stop. Write down the two clocks, every stop, every question asked of a person, and the list of ideas the newcomer had to learn before the first sale. | The report's "newcomer's numbers" section is filled in. | DX, Extra |

Explore: a second engineer who also needs the dashboard (record how they would
get in; nothing on the screens offers an invitation); the quickstart read on a
phone; every link in the quickstart followed once.

## Block B. The agent's purchase (P0)

Set-up: the local stack with `docker compose up --build`, and a merchant made
in the local dashboard at `http://localhost:8080/dashboard/sign-in` — any
address works, and the sign-in message is printed in `docker compose logs app`
instead of being sent. Give it a seller name, issue a key, then start the stand
console with `pnpm stand`, open `http://127.0.0.1:8787`, connect it to
`http://localhost:8080` with that key, and publish its example cards. Connecting
also subscribes the stand to that merchant's orders, which is what lets it play
the merchant's handler. `curl` and `jq` serve for every step before the
payment. The payment challenge travels in the `PAYMENT-REQUIRED` header as
base64-encoded JSON (`… | base64 -d | jq`).

In the documents an agent reads, the local sandbox looks exactly like the test
channel: the same chain and `test: true`. The local dashboard's banner and the
stack's log say that nothing settles there. A merchant on the local stack needs
no wallet; the challenge then names a stand-in address that the stack is
configured with, which is not the merchant's.

On the local stack the payment layer accepts any payment without checking its
signature, so a payment can be written by hand, and the cases about repeated,
borrowed and late payments run with `curl` alone. A payment is the challenge's
first offer, a payer and a number used once, encoded the same way the challenge
is, and sent in the `PAYMENT-SIGNATURE` header of the same request with the
same body:

```sh
GW=http://localhost:8080 ITEM=<catalogue id> BODY='{"params":{}}'
curl -s -D - -o /dev/null -X POST "$GW/x402/$ITEM/purchase" \
  -H 'content-type: application/json' -d "$BODY" \
  | awk 'tolower($1)=="payment-required:" {print $2}' | tr -d '\r' \
  | base64 -d > challenge.json
PAYER=0x1111111111111111111111111111111111111111
jq -c --arg from "$PAYER" --arg nonce "0x$(openssl rand -hex 32)" \
  '{x402Version: 2, accepted: .accepts[0],
    payload: {authorization: {from: $from, nonce: $nonce}, signature: "0x00"}}' \
  challenge.json | base64 | tr -d '\n' > payment.txt
curl -s -X POST "$GW/x402/$ITEM/purchase" -H 'content-type: application/json' \
  -H "PAYMENT-SIGNATURE: $(cat payment.txt)" -d "$BODY" | jq
```

The order the payment is for is the one named inside the challenge, at
`accepts[0].extra.order_id`. Keeping `payment.txt` and sending it again repeats
the same payment; a new nonce with the same payer is a fresh authorization from
the same buyer; another `PAYER` is another buyer. The recipe was run on
2026-10-10 against the gateway's own code with the same payment layer, and B-09
to B-12 answered as written below. None of this works on the test channel,
where a payment has to be signed for real.

| ID | Do | What should happen | Angle |
| --- | --- | --- | --- |
| B-01 | Pretend to be an agent given only the address `https://test.agentify.ad` and the task "buy a month of access". Try `/.well-known/x402`, `/x402`, `/llms.txt`, and whatever else an agent would try. | Record how the catalogue at `/x402/catalog` can be found without our documentation. Today nothing at those addresses points to it, and an external catalogue may list a product only after a settled sale. | AX |
| B-02 | Read `GET /x402/catalog`. | Only cards on sale are listed. Each carries a title, description, price, mode, the purchase parameters, the delivery result, and `seller` with `name` and `site`. Two questions for the tester: an asynchronous card that names no deadline shows none, although a day applies — can an agent tell? And can an agent tell from the document itself that the merchant gave the seller's name and site and nobody checked them? | AX, Claim |
| B-03 | Probe one card: `GET /x402/<id>/purchase`. Decode the challenge. | 402, nothing bought. The challenge names Base Sepolia (`eip155:84532`), USDC, the price in the asset's smallest units, the merchant's own wallet as `payTo`, and a discovery declaration whose method is POST. The price equals the card's, and `payTo` is the merchant's wallet where one was saved in Settings (on the local stack without one, the stand-in address). | AX, Claim |
| B-04 | Start a purchase in the stand (two presses: the challenge, then the signature). Before signing, read the challenge the stand shows. | The unpaid request opens an order, and its identifier rides in the challenge. Signing pays that order and no other. | AX, State |
| B-05 | Buy a synchronous card. | The goods arrive in the answer to the purchase, with a settlement header, and the status document reads `delivered` with the price, `test: true` and the seller. | AX, State |
| B-06 | Buy an asynchronous card. Read its `status_url` until the goods arrive. Then read it again from another machine with no credentials. | First answer: `in_progress`, no goods, the status address, and no settlement header. Later: `delivered` with the goods. Anyone holding the order's identifier can read it; record whether that is said anywhere an agent would read. | AX, Claim |
| B-07 | With `curl`, send what an agent gets wrong: an unknown card; a paused card; a body that is not JSON; JSON with the wrong content type; a missing required parameter; an undeclared parameter; a parameter of the wrong type; a `ship_to` on a card that does not ship; a body over 256 kilobytes; the status of an order that does not exist. | Each is refused before any money, in one envelope `{"error":{"code","message","retryable"}}`, with the right status (404, 409, 400, 400, 422, 422, 422, 422, 413, 404). Where a field is at fault, `problems` names it. For each, ask a language model what to do next from the body alone, and record answers that go wrong because of our words. | AX, Door |
| B-08 | A paused card with a bad parameter. | 422 about the parameter rather than 409 about the pause, because the checks run in that order. Record whether an agent that fixes the parameter and then meets the pause has been misled. | AX |
| B-09 | With `curl`, send a paid request whose `PAYMENT-SIGNATURE` header is not a payment at all. | A fresh 402 challenge whose decoded header carries a sentence saying the payment could not be read; the body is empty; nothing is charged. Record whether an agent that reads only the body learns why. | AX |
| B-10 | With the hand-written payment, pay an order, then send the same `payment.txt` again to the same order. | The repeat is a safe retry: it is answered with where the order stands, and nothing is charged or delivered twice. | State |
| B-11 | Take a second challenge for another order of the same card, and present the old payment against it: the new order's offer in `accepted`, the old payer and nonce kept. | 409 `payment_already_spent`, saying one payment buys one order and this one needs a fresh payment. Nothing charged. | State, AX |
| B-12 | Pay an order as one payer, then present a different payer's payment for the same order. | 409 `not_this_purchase`: the order already belongs to another payment. | State, AX |
| B-13 | With a wallet saved in Settings, take a challenge, then change the wallet, then pay. | Record what happens. The payment is checked against the wallet as it stands at that moment; the only acceptable outcomes are a refusal before any charge that tells the agent to take a fresh price, or a payment to the address the agent signed for — never money sent to an address the agent did not agree to. | State, Door, Claim |
| B-14 | Refuse in the stand's handler with a code and a message of your own. Read the status. | The status carries `refusal` with exactly that code and message. No other ending carries a refusal. | AX, Claim |
| B-15 | Cold reading by a language model. Give a model with no context the catalogue, one decoded challenge, an asynchronous status in progress, and three error bodies from B-07. Ask: what will I get; what must I send; when am I charged; what happens if the seller fails; who sells and can I trust it; should I repeat this call; what does "in progress" mean; how do I get my goods later. | Mark each answer right or wrong against the truth. Every wrong answer caused by our words is a finding. Keep the transcript. | AX |
| B-16 | On the test channel, the operator buys one synchronous and one asynchronous card (0.01 test USDC each). | The same as B-05 and B-06, with a real settlement: the challenge names Base Sepolia and the merchant's wallet receives the payment. | State, Claim |

Explore: what an agent sees when the merchant's handler is not running at all;
two agents buying the same card at the same second; an agent that ignores the
status address and buys again.

## Block C. The order's state machine (P0)

Set-up: Block B's local stack and stand, and a second merchant on the same
stack for the tester's own handler. Two merchants are needed because every
process subscribed with one merchant's key shares that merchant's orders: the
stand and the tester's handler on one key would take orders from each other at
random. The stand stays connected as the first merchant and plays its handler;
the tester's handler from Block A runs with the second merchant's key. The
second merchant's cards are bought from the stand's Agent tab, which buys any
card in the public catalogue, or with `pnpm buy <catalogue id>`, which needs no
key at all. The stand's Orders tab sets how the first merchant's handler
answers: "Deliver at once", "Accept, then deliver after the
delay", "Accept and never deliver", "Refuse with the code below", "Answer only
after the deadline", "Deliver a shape the card never declared", "Hold it and
ask me". Its price answers are "Answer the price below", "Say the price is
unavailable" and "Answer only after the deadline". Its Owed panel delivers or
refuses an order already taken on. What the stand cannot do — throw, answer
slowly on its own, crash, run twice, be absent — the tester does with the
handler from Block A, under the second merchant.

The numbers the cases rely on are the documented ones: a price holds 30
seconds; a price question is answered within 5 seconds or counts as silence;
one delivery attempt is waited for 3 seconds; a synchronous order has 8 seconds
from the moment its payment checked out, inside 10 promised to the agent; an
order is sent to the handler at most five times; an asynchronous card without a
deadline of its own is held to one day.

For every case, read the three views as described above, and check the money:
in the synchronous mode the charge comes last, so any ending other than a
delivery means nothing was charged; in the asynchronous mode the charge comes
first, so any ending other than a delivery means a refund is owed.

Synchronous card:

| ID | Do | What should happen | Angle |
| --- | --- | --- | --- |
| C-01 | "Deliver at once". | `delivered`; goods in the answer; one receipt; Orders shows delivered. | State |
| C-02 | "Refuse with the code below", code `out_of_stock`, a message of your own. | `rejected` with that code and message; nothing charged; no receipt; Orders shows refused. | State, Claim |
| C-03 | "Answer only after the deadline". | After the synchronous window the agent gets the order closed on its time limit (`expired`); nothing charged; no receipt. Record whether the late answer shows anywhere on the merchant's side. | State |
| C-04 | "Deliver a shape the card never declared". | The merchant's side is told the goods do not fit the card, with the fields named; nothing is written down; the order is sent to the handler again, and with the same wrong answer each time the purchase ends at the window without goods and without a charge. | State, Door |
| C-05 | "Accept, then deliver after the delay" on a synchronous card. | The acceptance is refused as `not_applicable_in_mode`; the order is not sent again for that answer; it ends at its deadline with nothing charged. The handler's problem report says why. | State, Door |
| C-06 | "Hold it and ask me", then deliver at about the fifth second. | An answer later than the 3-second wait still counts inside the window: the purchase completes once with one receipt. The order arrives once — a worker is handed one order at a time, and a delivered order is not handed out again. Record any second arrival. | State |
| C-07 | Own handler that throws on every attempt. | Repeated deliveries with growing pauses — about three fit in the window, never more than five — then closed on its time limit with nothing charged. Each throw reaches the problem handler and none reaches the agent. | State, DX |
| C-08 | Own handler that throws on the first attempt and delivers on the second. | `delivered` once; one receipt; the handler saw the same order twice. | State |
| C-09 | Stop the own handler, so nothing is subscribed for the second merchant; buy its card. Then start the handler. | The purchase ends without goods and without a charge within the window. Starting the handler afterwards does not revive that order, and it is never handed to the handler. | State |
| C-10 | Own handler killed while it holds an order, and restarted within the window. | The order reaches the new process; delivered once. | State |
| C-11 | With "Answer only after the deadline", let a synchronous purchase expire while the stand's late answer stores the goods. Then pay the same order again with a fresh authorization from the same payer (Block B's hand-written payment, new nonce, same `PAYER`). | The stored goods are released without another call to the handler; the order reads `delivered`; one charge and one receipt. The documentation promises this retry to the same buyer: record what a different payer gets. | State, AX |

Price question (a card with `price_check: 'handler'`):

| ID | Do | What should happen | Angle |
| --- | --- | --- | --- |
| C-12 | Answer a price different from the card's. | The challenge names the answered price; the sale goes at it; the order's price and the receipt carry it with its `as_of`; Orders and Receipts show it. | State, Claim |
| C-13 | "Say the price is unavailable". | The purchase is refused before any money; no order reaches the merchant's handler; the status has no merchant words. | State |
| C-14 | Price answer silent, synchronous card. | After 5 seconds the purchase carries on at the card's price. | State |
| C-15 | Price answer silent, asynchronous card. | The purchase is refused; no order reaches the handler; nothing charged. | State |
| C-16 | Start a purchase, take the challenge, wait 40 seconds, then sign. | Nothing is charged and nothing reaches the merchant. The documentation says the agent is given a fresh price; record the exact answer, since the code may refuse the payment instead. | State, AX, Claim |

Asynchronous card (the stand's asynchronous example has a ten-second deadline):

| ID | Do | What should happen | Angle |
| --- | --- | --- | --- |
| C-17 | "Accept, then deliver after the delay". | `in_progress` with the status address, charged at the purchase; later `delivered`; the receipt is written at the delivery and not before. | State |
| C-18 | "Refuse with the code below" before accepting. | `refund_due` straight away, with the merchant's code and message; an event tells the merchant a refund is owed; Orders shows refund due with its callout; no receipt. | State, Claim |
| C-19 | Accept, then refuse from the Owed panel. | `refund_due` at once, without waiting for the deadline. | State |
| C-20 | "Accept and never deliver"; let the deadline pass. | `refund_due` at the deadline; an event to the merchant; the order is on the merchant's list of open orders. | State |
| C-21 | After C-20, deliver from the Owed panel. | The debt is closed with the goods: the agent reads `delivered` and the goods at the same address; one receipt; the delivery's answer says it closed a refund owed. | State |
| C-22 | Deliver the same order twice. | Both calls answer `ok: true`, the second marked as already delivered; one receipt; the agent keeps the first goods. | State |
| C-23 | Deliver goods that do not fit, then the right goods. | First: `delivery_does_not_match_card` with every misfit field in `problems`, `retryable: true`, the order unchanged. Second: delivered. | State, DX |
| C-24 | Own handler that throws on every attempt, on an asynchronous card with a deadline of 600 seconds. | The order goes out again after each attempt, at most five times, then closes as if its deadline had passed — long before the 600 seconds: `refund_due`, since the money was taken. Count the attempts. Record whether the merchant could have foreseen this from the documentation. | State, DX |
| C-25 | Own handler that answers the first delivery of an order with `accepted` after 4 seconds (slower than the 3-second wait), and throws whenever the same order arrives again. | A repeat that was already on its way may still arrive, but once the acceptance has reached the gateway, failures no longer spend attempts: the order is not closed after five, and waits for its delivery deadline or a delivery. | State |
| C-26 | Accept an order, kill the handler, restart it, and read `agentify.orders.list({ open: true })`. Deliver with `orders.forId(id)`. | The open order is on the list; the delivery succeeds; no second goods. | State, DX |
| C-27 | Stop the handler, let an accepted order's deadline pass, restart. | The refund event waits in the merchant's queue and arrives once, on the first poll after the restart; the order is on the open list as refund due. An event is lost only when it went out in a poll whose answer the process never read, which cannot be caused by hand. | State, DX |
| C-28 | Run two copies of the own handler on one key, with a handler that takes 5 seconds. | One order may reach both copies; the buyer gets one delivery and one receipt. | State |

Pausing:

| ID | Do | What should happen | Angle |
| --- | --- | --- | --- |
| C-29 | Pause one card in the dashboard. Probe it, read the catalogue, try an unpaid purchase. Then resume. | Paused: gone from the catalogue, the probe answers 409 `not_selling` and no challenge. Resumed: listed again, and the probe answers 402. | State, AX |
| C-30 | Accept an asynchronous order, pause the card, then deliver. | The pause closes no order: the delivery goes through. | State |
| C-31 | "Pause all sales", then "Resume all sales". | Every card stops and starts; open orders play out. | State, UX |
| C-32 | Take a challenge, pause the card, then sign. | Record what happens. Under the door rule the only acceptable outcomes are "refused before any charge" and "completed"; a charge without goods is the worst finding this block can produce. | State, Door |

Explore: a handler that answers an order it never received; the same order
delivered from two processes at the same moment; a key revoked in the dashboard
while the handler's subscription is running (D-20).

Some endings cannot be caused by hand on either channel, and the tester does
not try: `delivered_unpaid` and `payment_unresolved` need the payment network
to fail between the check and the charge; `refunded` needs a recorded refund,
and no command records one yet; `cancelled` needs a merchant to leave, and
leaving is not built; `declined` belongs to the confirmation mode, which is not
open. The automated suite covers them. The tester checks only that the
dashboard's words for them (delivered, not paid; payment outcome unknown;
refunded; closed when you left; declined at confirmation) are understandable to
a merchant, and records which of them a merchant can reach today.

## Block D. Refused at the door, or carried through (P1)

Set-up: the SDK client from Block A, pointed at the local stack for the card
cases and at the test channel for the merchant-settings cases. Every refused
card in this block is also saved as a file and run through the card check, so
the two can be compared.

The question in every row is the same: was the input refused at once, with
words that say what to change, or was it accepted and then carried through? A
third outcome — accepted, then ignored or failed later — is the one this block
exists to find.

| ID | Do | What should happen | Angle |
| --- | --- | --- | --- |
| D-01 | On the test channel, a merchant with no seller name and no wallet publishes a valid card. | `ok: false`, code `card_rejected`, and one answer listing both `no_seller_name` and `no_payout_wallet` with an empty path, a sentence naming the missing settings, and `retryable: false`. On the local stack only the name is required. | Door, DX |
| D-02 | Publish five cards, each missing one required field: `merchant_item_id`, `title`, `description`, `price`, `result`. | Each is refused with a finding that names the missing field. Record the words of each; a sentence written by the validation library rather than by us is a finding. | Door, DX |
| D-03 | Plain text: a title with `<b>`, with `&amp;`, with a tab, with a line break; a description with `<p>` and with `&#8217;`. Then `Tea & coffee`, `AT&T`, `5 < 10` and `Map<String, Integer>` in a title, and `List<String>`. | The first six are refused, each naming the field, what was found, how many times and where. The next four are published exactly as written. `List<String>` is refused, because it has the shape of a markup tag. | Door, Claim |
| D-04 | A description of exactly 500 characters, of 501, of 499 plus one emoji, and one of spaces only. | 500 passes; 501 is refused; the emoji counts as two; a blank description is refused. | Door |
| D-05 | Prices: `5 USD`, `5.0 USD`, `0.00 USD`, `5.00 EUR`, `5.0000001 USD`, `{ amount: '5.00', currency: 'USDC' }`, `0.001 USD`. | The first five are refused, each with a sentence that shows the right spelling; USDC is accepted. `0.001 USD` is accepted at publication: record that the live channel's smallest payable price is not known and nothing tells the merchant so. | Door, Claim |
| D-06 | Modes: `fulfillment: 'confirm'`; an unknown word; `fulfill_deadline_seconds` on a synchronous card. | Each refused with a reason. The confirmation mode's refusal says it is not open during the pilot. | Door |
| D-07 | A `result` with no fields; a parameter of a type outside string, number, integer and boolean; a parameter the delivery needs but the card does not declare. | The first two are refused. The third is accepted, by design: no check can see what a delivery needs. Record whether the documentation's warning about it was where the newcomer would have read it. | Door, DX |
| D-08 | Tags: six of them; one of 33 characters; one with a curly quote; one with a leading space; `eSIM` beside `esim`; an empty list. | The first five refused with the rule named. Record what an empty list does. | Door |
| D-09 | A card whose price check names an address of yours instead of the handler. | Refused at publication, with a finding at `price_check` saying the price is asked of your own price handler and a hook is not called yet. The card check refuses it the same way. | Door, Claim |
| D-10 | From JavaScript, answer an asynchronous order with `order.accepted({ eta_seconds: 60 })`, and call `POST /v0/orders/<id>/accept` with that body. | The SDK sends an empty acceptance; the route refuses the field in words saying it was removed and to answer `accepted()` with nothing in it. | Door, Extra |
| D-11 | Republish a card under the same `merchant_item_id` with a new price while an order against it is open. | The same catalogue `id`, the new price in the catalogue and on the dashboard; the open order keeps the price it was sold at, and so does its receipt. | State, Claim |
| D-12 | Accept an asynchronous order, republish its card with a different `result`, then deliver the goods the agent was promised when it paid; on a second such order, deliver the new shape. | The promised goods close the order: it is held to the result it was sold with. The new shape is refused for that order with the missing fields named, and is what new orders are sold with. | State, Door |
| D-13 | Run every card refused in D-02 to D-08 through the card check. Run it also with no file, with an unknown command, on a file that does not exist, and on a file that is not JSON. | The check finds what publication found, and exits 1. No file: refuses and says why, exit 3. Unknown command or unreadable file: exit 2. Not JSON: one finding about the card as a whole. | DX |
| D-14 | Build the client wrong: no `apiKey`; `baseUrl` of `test.agentify.ad` with no scheme; `http://test.agentify.ad`; `https://test.agentify.ad/v0`; no `baseUrl` at all. | No key: a `TypeError` at `createClient` that names the environment variable as the likely cause. No scheme: refused as not an address. No address: the client builds, and the first call fails naming both addresses. Record the other two. | DX, Door |
| D-15 | Call with a key from the other channel (any string beginning `csk_live_` on the test channel, since the prefix alone is read first), with a revoked key, and with a random string. | `AgentifyError` with code `not_authorised`, `retryable: false` and the call's name. The other channel's key gets a sentence naming the site where it works; the others get the plain refusal. | DX, Door |
| D-16 | Misuse the subscription: `on('orders', …)`; `on('order', …)` twice; `start()` with nothing registered; `start()` twice. | Each is refused at the line that is wrong, with the right spelling named. | DX |
| D-17 | Return from a handler: nothing; a plain object instead of `order.delivered(…)`; a delivery with a field the card does not declare; a refusal with no message. | Record for each what reaches the problem handler and how the order ends. An answer silently taken as a refusal, or silently dropped, is a finding. | Door, DX |
| D-18 | Close orders wrongly: `refuse` on a synchronous order; `deliver` on an identifier that does not exist; a shipment on an order that is not a parcel. | `not_applicable_in_mode`; `no_such_order`; a refusal that the goods do not fit. Returned as `ok: false`, not thrown. | Door, DX |
| D-19 | With merchant B's key, read and deliver against merchant A's order identifier. | `no_such_order` for both, with nothing in the answer that says the order exists. B's dashboard never shows A's orders. | Door |
| D-20 | Start the handler, then revoke its key in the dashboard while the subscription runs. | Record what the process says, where, and whether it stays up. The pit-of-success reading: the merchant learns at once, in words, that their process has stopped selling; a process that stays up and quietly takes no orders is a finding. | Door, DX |
| D-21 | Optional: install the oldest SDK on npm and start a handler against the test channel. | Record what happens. Where the two sides do not speak the same contract version, the subscription stops, the process stays up, and only the problem handler says so. Record how a merchant would ever find out. | Door, DX |

Explore: anything the documentation calls "designed, not built", tried as if it
existed. The rule for each: refused with words, or not offered at all.

## Block E. The dashboard day to day (P1)

Set-up: the test channel, the main alias, the edge alias for anything that
spends links, a second alias, two browser profiles. The cases that need volume
run on the local stack. Start E-05 early: it waits an hour.

| ID | Do | What should happen | Angle |
| --- | --- | --- | --- |
| E-01 | With the edge alias, request a link, then another within the same minute. Then, a minute apart each time, three more. | The second request sends nothing — "No new link was sent", with a countdown on "Send another link" — and does not count against the hour. The third and fourth requests send links, and the fourth's note says it was the last of the hour's three. The fifth: "Try again later", with the minutes to wait. | UX |
| E-02 | On the link-sent screen, press Back; then "Use a different address". | Record whether the address typed is kept, and whether the person can tell how to get another link. | UX |
| E-03 | Request two links before using either. Open the first link's page, reload it, go Back and Forward, then press its button in another browser. Press the second link's button in the first browser. | Opening, reloading and navigating spend nothing; each link signs in once; both sessions belong to the same merchant. | UX, State |
| E-04 | Press a used link's button in a browser with no session, and in a signed-in one. | Without a session: "That link no longer works", that nothing is lost, and "Ask for another link". Signed in: the person's start page, and nothing about the link. | UX |
| E-05 | Request a link and press it after more than an hour. | "That link no longer works", as in E-04. | UX |
| E-06 | Signed out, open `/dashboard/orders`; sign in from the page you land on. Repeat for receipts, keys, settings and integrations. Then open `/dashboard/cards` and an address that does not exist. Then an old bookmark, `/cabinet/orders?open=true`. | Each of the five lands on its own section after the link. Cards and unknown addresses land on Cards. The old bookmark redirects to `/dashboard/orders?open=true`. | UX |
| E-07 | Sign in from two browsers. Sign out in one. Then "Sign out every other device" from a third session. | Signing out ends that browser's session only. The notice counts the other sessions correctly. The signed-out browser's next action lands on sign-in with "Your session ended…". | UX, State |
| E-08 | Open Settings in one tab, sign out in another, then save in the first. | The sign-in page says the change was not saved; after signing back in, nothing changed. | UX, State |
| E-09 | Open Settings as the main alias. In another tab sign out and sign in as the second alias. Save in the first tab. | "Nothing was changed", naming the address now signed in. Neither account changed. | UX, State |
| E-10 | A new merchant chooses "Not decided yet? Leave it for now". Visit every tab. | Cards, Orders and Receipts show the callout to choose a seller name; every empty list says what it is waiting for, and empty Cards offers the way to the SDK. | UX |
| E-11 | Seller name: empty; 32 characters; 33; a name in Cyrillic or with accents; an emoji; `<b>`; `Tea & Co`; `&amp;`. Then change a valid name and read the catalogue and an old order's status. | Empty refused with the way to stop selling named instead; 33, non-ASCII, emoji, markup and references refused; `Tea & Co` saved. The new name appears on every card and on existing order statuses at once. Record whether a merchant who writes in another alphabet understands why their name was refused. | UX, Door, Claim |
| E-12 | Site: `http://…`; with a path; with a query; with a port; an IP address; a single word; with a trailing slash; in capitals. Then empty the field. | The first six refused with the rule; record the last two. Emptying is refused: a site can be changed, never removed. | UX, Door |
| E-13 | Wallet: empty; 39 hexadecimal characters; a non-hexadecimal character; a valid address with one letter's case changed; the same address all in lower case; the zero address. | Empty, short and non-hexadecimal refused with the shape explained; the case change refused as a checksum error, with the refused address shown back in groups of four. Record the last two. On the test channel a saved change applies at once and sends nothing; `GET /v0/payout-wallet` with the key shows the address and `pending: null`. | UX, Door, Claim |
| E-14 | Keys: an empty name; 101 characters; two lines. Issue one, make an SDK call, revoke it in two steps, call again. | The first three issue nothing and say so. "Last call" updates after the call. After revoking, the key stays listed as revoked and the SDK gets `not_authorised`; the browser session is untouched. | UX, Door |
| E-15 | Cards: read every column for a synchronous, an asynchronous and a paused card; pause and resume one; "Pause all sales" and back. | Delivery reads immediate, later or by parcel; the counts in the pills follow; with all sales paused each card says so. Record whether "Product code" and the buying address under each title mean anything to the owner. | UX, Extra |
| E-16 | Orders: switch between Open and All; read a delivered, a refused, a refund-due and an expired order. | Each carries its status words, the test tag and the sale price; a refund-due order has its callout. There is no order page: record whether a merchant can answer "what did this buyer get, and when" from the dashboard alone. | UX, Claim |
| E-17 | Receipts: read them after Block C. | One receipt per delivered or shipped order, none for any other ending. Times are UTC: record whether that is said. Record what "Price as of" tells a merchant. | UX, Claim |
| E-18 | On the local stack, publish fifty cards from your own merchant and, with your handler running, buy one of them two hundred times (`pnpm buy <catalogue id>` in a loop; `pnpm buy` can fill only `email` and `area_code` parameters, so that card asks for nothing else). Open Cards, Orders and Receipts. | Record load time, whether anything pages, and whether one order can be found. | Claim, UX |
| E-19 | Integrations: follow both SDK links. | "Open the connection guide" opens the quickstart; "Create an API key" opens issuance. | UX |
| E-20 | Open an address that does not exist under the dashboard; cause a generic error if one can be caused. | "There is no such page" with a way back. Record where "Try again" takes the person and whether they lose their place. | UX |
| E-21 | Every screen at 375 pixels wide. | The menu opens; every table can be read; a key can be copied on a phone. | UX |
| E-22 | Keyboard only: sign in, issue a key, copy it, revoke it, pause a card. A screen reader on the sign-in form and the key page. | Every control reachable, focus visible, every field announced by its label. | UX |
| E-23 | Read every message the dashboard sent during the run, on a desktop mail client and on a phone. | The words in each message match the screen it sends the person to. | UX, Claim |

Explore: the dashboard left open overnight and used in the morning; two people
on one merchant changing settings at the same time; the browser's Back button
after every form.

## Block F. Parcels (P2)

Set-up: an SDK release that carries parcels, and the tester's own handler
with a price handler registered beside the order handler, under a merchant with
a seller name and a site. Neither the stand nor `pnpm buy` can send an address,
so on the local stack every step runs with `curl`, the paid ones with Block B's
hand-written payment and `ship_to` in the body beside `params`. On the test
channel a paid parcel needs a buyer that signs for real and sends `ship_to`;
ask the operator whether theirs can, and if not, run the paid rows on the local
stack only and say so. Parcels are not sold on the live channel.

| ID | Do | What should happen | Angle |
| --- | --- | --- | --- |
| F-01 | Publish a parcel card (`fulfillment: 'ship'`, `ship_within_seconds`, `price_check: 'handler'`, no `result`) before giving the site, then after. | First refused with `no_seller_site`, naming where to set it; then published. The catalogue shows the shipping time. The card's price excludes shipping: record whether the agent can tell that from the card. | Door, AX, Claim |
| F-02 | Parcel cards with a `result`, with `fulfill_deadline_seconds`, with `ship_within_seconds` over thirty days, and without a price check. | Each refused with its reason. | Door |
| F-03 | Unpaid purchase without `ship_to`; with `ship_to` missing the phone; with country `us`; with state `US-CA`; then a valid one. Log the question the price handler receives. | The first four are refused before any money: the missing block with 422 `ship_to_does_not_fit`, the others naming the field at fault (record their status and code). For the valid one, the price handler receives the country, state, city and postal code and nothing that names the person; the challenge names the price the handler answered. | AX, Door, Claim |
| F-04 | The price handler answers "unavailable" for that place. | The purchase does not happen, nothing is charged, and the agent is told so. | State, AX |
| F-05 | Paid: the order reaches the handler; the handler stores the address and answers `accepted`. Read the order back. | The handler received the whole address once. After the acceptance the order reads only `ship_to: { erased_at }`, and a repeat of the order never carries the address again. | State, Claim |
| F-06 | Record the shipment with `deliver({ carrier, tracking_number: null })`. | The agent reads `shipped` with the shipment and the instant it had to ship by, and no goods. The receipt's outcome is shipped; Orders shows shipped. | State, AX |
| F-07 | Send the same shipment again, then a different one. | The same one succeeds; the different one is refused with `shipment_already_recorded`. | State |
| F-08 | Shipments with a `tracking_url` over `http`, or on an IP address; a carrier with markup; an empty tracking number. | Each refused, saying why; `null` is the way to say there is none. | Door |
| F-09 | Let a paid parcel pass its shipping time unshipped; then ship it. | `refund_due` at the time limit, with the address erased; the late shipment closes the debt and the order reads `shipped`. | State |
| F-10 | Pay with an address different from the one priced. | 409 `ship_to_changed` before the payment is checked, telling the agent to start a new purchase; nothing charged. | State, AX |
| F-11 | As a merchant who does not write code, try to see a parcel's address and record its shipment in the dashboard. | Neither is in the dashboard today. Record what such a merchant would do, and whether anything told them before they published. | UX, Extra |
| F-12 | After F-05 and F-09, look for the address anywhere the merchant or the agent can read: the dashboard, the order, the status, the receipt. | Nowhere. The agent's status never carried it. | Claim |

## Block G. Rules that exist only where money is real (P3)

These rules apply only on the live channel, and the local stack cannot pretend
to be live. The block runs only on the product owner's word, with an alias the
operator owns, and never includes a purchase. It leaves a real account on the
live channel: the cleanup command that exists for the test channel refuses
there. The product owner decides what happens to the account afterwards.

| ID | Do | What should happen | Angle |
| --- | --- | --- | --- |
| G-01 | Sign in on `https://agentify.ad/dashboard`. | No test banner. Record whether the person can tell before acting that the money here is real. | UX, Claim |
| G-02 | Save the first wallet. | It applies at once, and every account of the merchant receives "A payout wallet was set for your merchant". | State, Claim |
| G-03 | Change the wallet. | Every account receives "Your payout wallet is set to change" first; Settings shows "Waiting to replace it" with the moment it takes effect, forty-eight hours later, and "Cancel this change"; `GET /v0/payout-wallet` shows `pending` with `takes_effect_at`. | State, Claim |
| G-04 | Sign in on a second device, then cancel the change on the first. | "A payout wallet change was cancelled" to every account; the second device is signed out. | State, UX |
| G-05 | Issue a live key; call the live channel with a test key. | The key begins `csk_live_`; every account receives "A new key was issued for your merchant" (record that it says "disable" where the button says "Revoke"). The test key is refused with a sentence naming the test site. | Claim, Door |
| G-06 | Publish a valid card before the operator's approval. | Refused with `no_operator_approval` among any other missing settings. The dashboard says it cannot tell whether approval was given: record what the merchant does next. | Door, UX |
| G-07 | Publish a parcel card. | Refused with `not_sold_yet`. | Door |

## Block H. The WooCommerce connector (P3)

The connector is an experiment and not part of the SDK path; this block checks
that it says so honestly, fails with words, and that its newest part — a
physical product sold as a parcel — keeps the parcel's promises. It needs a
WooCommerce shop the operator controls, with shipping zones set up.

| ID | Do | What should happen | Angle |
| --- | --- | --- | --- |
| H-01 | Read the Integrations tab as an owner. | The connector is marked experimental; record whether the owner understands what that means for them. | UX, Claim |
| H-02 | Connect with an `http` address, an address that is not a shop, and one that does not answer. | Each refused with words; the first asks for the public https address of the shop. | Door, UX |
| H-03 | Connect the operator's shop and approve the connection there. | Back on "Back from your shop", "Continue to your dashboard" leads to Integrations showing the shop connected. | UX |
| H-04 | Import before the seller settings are complete; then after. | First: "Nothing was imported", naming what to set. Then a page "What came over from …" with Published, Refused, No verdict, Not attempted and Left in the shop, each refused product saying why. Record every word an owner would not know. | UX, Extra |
| H-05 | Buy an imported product while the shop is unreachable. | The words say the shop did not answer, not that the product stopped selling. | Claim |
| H-06 | "Forget this shop". | Record what remains, in the dashboard and in the shop. | UX, Claim |
| H-07 | Compare where the connector's screens appear with the text saying it works in test mode only. | Record any channel where the screens are offered against what the text says. | Claim |
| H-08 | In the operator's shop, a physical simple product with shipping zones. Import it. | It comes over as a parcel's card, with seven days to ship, and the import screen says that number is a stand-in. Without the shop's site in Settings it is refused, naming where to set it. | UX, Door, Claim |
| H-09 | Ask its price, as an agent, for places in different shipping zones (by country, by state, by postal code), and for a place the shop does not ship to. | The price is the product plus the shop's cheapest shipping rate for that place, pickup left out; a place with no rate is refused before any money. Record a state the shop writes its own way, such as Berlin, which WooCommerce spells `DE-BE`. | AX, State |
| H-10 | The operator buys it once on the test channel (the shop's price, in test USDC). | A paid order appears in the shop carrying the buyer's address and the shipping line, and only then is the order taken on. Agentify keeps no copy of the address. | State, Claim |
| H-11 | Mark the shop's order Completed, with and without a carrier and tracking number. | Within about five minutes the agent reads `shipped`, with the carrier and tracking number where the shop had them, or the shipping method's name and no number. | State, AX |

## Block I. The scanner, and the way into the dashboard (P3)

The scanner is the front page and a way in for some merchants. The plan checks
the way in carefully and the scanner itself lightly. Use a real public shop's
address, such as the tester's own or a well-known online store.

| ID | Do | What should happen | Angle |
| --- | --- | --- | --- |
| I-01 | Scan a real shop. | Progress through named phases and eighteen checks — the page says it usually takes under 60 seconds — ending in a short report and an offer of the full one. | UX |
| I-02 | Enter what is refused: nothing; `ftp://`; a user name and password; `localhost`; port 8080; a `?token=` query; `127.0.0.1`. Then a single word with no domain. | The first six refused with their own sentences. Record what happens with the raw IP address, which the browser lets through and the server refuses, and whether "Retry scan" is offered for something that can never succeed. Record what the single word does: nothing refuses it. | Door, UX |
| I-03 | Scan a site whose robots.txt keeps `agentify-scanner` out, and one behind a bot challenge. | The first says the robots file kept the scanner out and how to allow it; the second says no reliable diagnostic was produced, without pretending to a verdict. | Claim |
| I-04 | Ask for the full report. | Record that the offer mentions a phone number while the form marks it optional, and that the data-notice checkbox links to no notice. The link leads to the page with one button, then to the full report; the same link pressed again no longer works. | UX, Claim |
| I-05 | From the full report, press "Open your dashboard". | The same session continues with no second message. "Open a seller dashboard" appears, and nothing is created until its button is pressed. | UX, State |
| I-06 | Later, sign in with a link that names no section: once as a person with a merchant, once as one without. | With a merchant: the dashboard. Without one: the latest report. | UX |
| I-07 | Choose "Essential only" in the consent banner and watch the browser's network panel; then allow analytics. Read the privacy notice beside it. | With essential only, the browser sends nothing to the analytics service. Record what the site records about the visit on its own side either way, and anything sent to the analytics service from the server, against what the banner and the notice promise. | Claim |
| I-08 | The data-request and unsubscribe pages: load as one address, sign in as another in a second tab, press. | A sentence naming the address signed in now and saying nothing was changed, with a way to reload the page as that address. | UX, State |
| I-09 | Open `/sell` on the test channel, and on the live one. | Record what a merchant reads on the test channel, including any unfinished pricing notes. The live channel does not serve it. | UX, Claim |

## What is already suspected

Reading the code and the pages before this plan was written turned up the
candidates below. None of them is a finding yet: the tester confirms or refutes
each one in the case named beside it, and both outcomes go into the report. A
candidate refuted is as useful as one confirmed, because it stops the team from
fixing what is not broken.

1. An agent given only the site's address cannot find the catalogue: nothing at
   the usual discovery addresses points to it, and an external catalogue may
   list a product only after a settled sale (B-01).
2. In the documents an agent reads, the local sandbox cannot be told apart from
   the test channel; only the local dashboard's banner and the stack's log say
   nothing settles (Block B).
3. The live dashboard shows no banner at all, so nothing on the screen says the
   money there is real (G-01).
4. A merchant cannot see whether the operator has approved them (G-06).
5. The dashboard has no page for one order, shows no parcel address and cannot
   record a shipment, so a parcel sold through the SDK can be fulfilled only
   from code; a WooCommerce merchant marks the order Completed in their own shop
   instead (E-16, F-11, H-11).
6. Refusals passed from the gateway to the dashboard begin with a lower-case
   letter, and "Try again" on the error page always leads to Cards (E-20).
7. Messages call things by other names than the screens do: a "wallet screen"
   where Settings has a section, "disable" where the button says "Revoke"
   (E-23, G-05).
8. The card check never exits 0: a complete card exits 3 because the
   idempotency half could not run, which a build script reads as failure
   (A-10, D-13).
9. The first test sale needs an operator, and there is no public way to ask for
   one (A-11).
10. The documentation says a payment at a stale price is answered with a fresh
    price; the code may refuse the payment instead (C-16).
11. The dashboard and the agent's vocabulary have a word for a refund paid back,
    but nothing can record a refund, so no order can reach it (Block C).
12. A price below the live channel's unmeasured minimum is accepted at
    publication and may be refused when a buyer pays (D-05).
13. The catalogue has no paging (E-18).
14. The seller's name and site are shown as they are now rather than as they
    were at the sale, and nothing in the agent's document itself says nobody
    checked them (B-02, E-11).
15. The documentation's front page says the pilot takes only goods that survive
    being delivered twice, while parcels, which do not, are on sale on the test
    channel (A-02).
16. The WooCommerce screens say the connector works in test mode only, while
    they are offered on every channel (H-07).
17. In the scanner: a raw IP address passes the browser's check, is refused by
    the server, and is then offered "Retry scan"; the headline saying a site
    blocked the reader appears only through a development fixture; the
    full-report offer mentions a phone number the form marks optional; the
    data-notice checkbox links to no notice (I-02, I-03, I-04).
18. `/sell` on the test channel shows pricing variants that were never approved,
    with their working notes (I-09).

## What changed this week, and where it is checked

| Change | Cases |
| --- | --- |
| The gateway and the dashboard run as one process, and the dashboard holds no key of its own ([#90](https://github.com/nuanu-ai/agentify/pull/90), [#91](https://github.com/nuanu-ai/agentify/pull/91), [#95](https://github.com/nuanu-ai/agentify/pull/95), [#97](https://github.com/nuanu-ai/agentify/pull/97)) | Every block; most directly A-03 to A-05, C-18, E-13, E-14, G-02 to G-05 |
| The merchant's side is called the dashboard, has a sidebar and an Integrations tab, and `/cabinet` redirects ([#56](https://github.com/nuanu-ai/agentify/pull/56), [#57](https://github.com/nuanu-ai/agentify/pull/57), [#58](https://github.com/nuanu-ai/agentify/pull/58), [#59](https://github.com/nuanu-ai/agentify/pull/59)) | A-03, E-06, E-10, E-19, E-21 |
| A sign-in returns to the section the person was going to ([#98](https://github.com/nuanu-ai/agentify/pull/98)) | E-06, I-06 |
| An agent reads the seller's name and site ([#71](https://github.com/nuanu-ai/agentify/pull/71)) | A-04, B-02, E-11, E-12 |
| Parcels: the address passes through and is erased, the shipment is recorded ([#78](https://github.com/nuanu-ai/agentify/pull/78), [#92](https://github.com/nuanu-ai/agentify/pull/92), [#94](https://github.com/nuanu-ai/agentify/pull/94)) | Block F, G-07 |
| An agent reads the storefront's documents tolerantly ([#83](https://github.com/nuanu-ai/agentify/pull/83)) | B-02; nothing visible should change |
| A synchronous handler's acceptance is refused for its mode ([#65](https://github.com/nuanu-ai/agentify/pull/65)) | C-05 |
| A silence after an acceptance spends no delivery ([#64](https://github.com/nuanu-ai/agentify/pull/64)) | C-25 |
| A worker receives one message per poll ([#66](https://github.com/nuanu-ai/agentify/pull/66)) | C-06, C-28 |
| A form drawn for another address, or sent after signing out, changes nothing ([#72](https://github.com/nuanu-ai/agentify/pull/72), [#67](https://github.com/nuanu-ai/agentify/pull/67)) | E-08, E-09 |
| A WooCommerce shop that does not answer is called that ([#79](https://github.com/nuanu-ai/agentify/pull/79)) | H-05 |
| The scanner reads hostile sites safely, obeys robots.txt and knows a bot challenge by its vendor ([#51](https://github.com/nuanu-ai/agentify/pull/51), [#55](https://github.com/nuanu-ai/agentify/pull/55)) | I-02, I-03 |
| The scanner's data and unsubscribe presses, and analytics held to the consent banner ([#73](https://github.com/nuanu-ai/agentify/pull/73), [#70](https://github.com/nuanu-ai/agentify/pull/70)) | I-07, I-08 |
| The merchant landing at `/sell` on the test channel ([#63](https://github.com/nuanu-ai/agentify/pull/63)) | I-09 |
| A WooCommerce shop's physical product sells as a parcel ([#99](https://github.com/nuanu-ai/agentify/pull/99)) | H-08 to H-11 |
| Contracts 0.8.0 and SDK 0.4.0 prepared for release ([#100](https://github.com/nuanu-ai/agentify/pull/100)) | A-06, Block F |

## What this plan does not cover

Load beyond the volume in E-18, and security testing beyond the isolation and
session cases, are separate work. The payment network's own failures —
a charge that fails after the goods were made, or that never reports back —
cannot be caused by hand and are covered by the automated suite. Whether an
external catalogue lists a product is measured by its own command and is not a
property of a sale. The run uses one desktop browser and one phone; a matrix of
browsers is not in scope.

## How to report

The report of a run is not committed to this repository, which is public. It
is kept in a private folder the product owner names, one per run and named for
the day the run started, and written as the run goes rather than at the end.
Findings are numbered inside the report; nothing goes into an issue tracker. A
finding that becomes a fix is described in the fixing pull request in that
request's own words. Even privately, the report never carries a sign-in link, a
key, a wallet's private key or an authorization header, and keeps a buyer's
address and a person's email address out of its screenshots. Cards, orders and
receipts are named by their identifiers (`item_…`, `ord_…`), which is also
what ties the evidence of the three views together.

Every case gets one verdict. **Pass**: the whole case ran and everything in
"What should happen" held. **Fail**: something that ran did not hold — even if
other steps were blocked. **Partial**: only part of the case could run, and
everything that ran held; the report says which steps did not run and why.
**Blocked**: the case could not run at all for a named reason outside the
product under test — a missing release, a missing tool, the operator
unavailable — and the report names the smallest thing that would unblock it.
**Not run**: there was no time, and the report says so rather than leaving the
row empty. A row whose expectation says "record" passes when the tester
recorded what happened; what they recorded may still produce a finding.

Every finding gets one severity, judged by what it does to a stranger rather
than by how hard it is to fix.

| Severity | What it means here |
| --- | --- |
| S1 | Money, goods, identity or an order's state is lost, duplicated, given to the wrong party or misstated to someone who acts on it; a secret is exposed; something accepted at the door fails later where money is involved; the three views of an order disagree. |
| S2 | A stranger's path is blocked with no way round that they could find alone; a promise in the documentation, on a screen or in an error does not hold; something is accepted and then silently ignored. |
| S3 | Confusion a person recovers from alone: a word only the team understands, a step or an entity the goal did not need, an error that is true but does not say what to do. |
| S4 | Cosmetics that do not change meaning: spelling, alignment, spacing. |

A gap the documentation already admits — a setting accepted and then
ignored, say — is still recorded as a finding, marked
"documented", and weighed on the same scale: what it costs a stranger does not
shrink because we wrote it down.

The verdict follows from what is left open. Not ready: any S1 is open, or a P0
case is blocked or not run. Ready once the named findings are fixed: no S1 is
open, and the report names the S2 findings that have to be fixed first. Ready:
nothing above S3 is open. S3 and S4 findings never hold back the verdict; they
go to the team as they are.

When several findings compete for the same fix, the order is: a blocked path
first, then a misleading promise, then an unsafe ambiguity, then a confusion
the person recovers from.

The report follows this outline:

```markdown
# Manual test run, <the day it started>

## What was tested
- Test channel commit (the deploy-test tag): <sha>
- SDK and contracts installed from npm: <versions>
- Local stack commit: <sha>
- Tester; browser and phone; start and end, UTC
- Blocks run, and the product owner's word for Block G if it ran

## Verdict
One paragraph: ready for the first merchant we do not control, ready once the
named findings are fixed, or not ready — and the findings that decide it.

## Cases
| Case | Verdict | Evidence (identifiers, screenshot names) | Findings |
| --- | --- | --- | --- |

## Findings
### Finding 1. <What happens, and where, in one line>
- Severity: S1–S4. Angle: UX, DX, AX, State, Door, Claim or Extra.
- Case: <ID>. Build: <sha>. Happens: always, n of m tries, or once.
- Steps: what was done, in order, so somebody else can repeat it.
- Expected: what should have happened, and where that expectation comes from.
- Observed: what happened instead, quoting the words on the screen or in the
  answer exactly.
- Evidence: identifiers, log lines, screenshot names — no secrets.

## Suspected already: confirmed or refuted
One line per candidate from the plan, with the case that settled it.

## Words that stopped me
| Where | Word or element | What I took it to mean | What it means | Did my goal need it? |
| --- | --- | --- | --- | --- |

## The newcomer's numbers
- From the front page to the first card published, and from there to the
  first test sale.
- Every stop: where, how long, and what got me moving again.
- Every question I had to ask a person, and why the pages did not answer it.
- The ideas I had to learn before the first sale.

## Not run, and why
```
