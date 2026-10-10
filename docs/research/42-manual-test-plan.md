# Manual product test plan: the merchant's path and the agent's, end to end

Date: 2026-10-10. A working protocol for a person who tests the product by
hand. It is rewritten freely between runs and is not a decision. The report of
each run is kept privately, outside this public repository; its template is
the last section here.

## What a run answers

The automated suite checks every promise of the product in isolation, and a
run of this plan walks the whole product with all of them in place at once:
one merchant, one buying agent, one order at a time, read from every side.

The question it answers is narrower than "does it work", and it has four
parts. Can an engineer of modest experience, whom we have never met, connect a
shop through the SDK using only our public pages? Can a stranger's agent buy
from that shop without help? Does every order end in a state that the agent,
the merchant's code and the dashboard all read the same way, and that tells the
truth about where the money is? And when something ordinary goes wrong — the
merchant's process restarts, an answer is lost on the way, a night passes with
nobody watching — can the merchant carry on by themselves the next morning,
with the money, the order and the buyer's trust intact? The people we expect to
integrate first are not senior engineers. Wherever the tester needs knowledge
that only the team has, that is a finding, even when the product behaves
correctly.

A run ends with one of three verdicts about the SDK path: ready for the first
merchant we do not control; ready once the named findings are fixed; not ready.
The verdict names the findings that decide it, and it says separately which of
the four questions the run could not measure and what the smallest thing is
that would measure it. The number of findings a run produces says nothing about
how much of the product it covered: that is what the report's lists of what was
not run and what the plan cannot reach are for.

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
And after a lost answer or a restart of its own, does it recover the order it
already has rather than buying a second time?

**State — the order's state machine.** After each action, the agent's view of
the order, the merchant's view (in the SDK and in the dashboard), the receipt
and the money must agree. Nothing is charged twice, nothing is delivered twice,
nothing that was charged disappears without a refund owed, and nothing waits
forever. The merchant's own action — the licence issued, the unit taken from
stock, the parcel handed over — happens once for each sale, which is a thing
the product has to make possible: the same order carries the same identifier
on every arrival, and one purchase never turns into two orders.

**Door — refused at once, or carried through.** The product's rule is that
what it cannot reliably finish is refused at the door with words a person can
act on, and what it accepts it finishes. For every input the tester tries,
decide which of the two happened. A refusal must name what to change. Anything
accepted that later fails quietly, or anything that accepts a setting and then
ignores it, is what this angle looks hardest for: such a finding is S1 where
money is involved and S2 otherwise (see "How to report"). Where a row asks for
"the Door question", it asks exactly this: should the product have refused at
the door what it accepted and then could not finish.

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

The plan is written for one tester who plays four parts in turn. First the
newcomer: a merchant's engineer who reads only the public site and the npm
package, knows enough Node.js to copy and run an example, and knows nothing
about stablecoins or about x402, the payment protocol an agent pays through,
in which a request is answered with a price and the same request is then sent
again carrying a signed payment. Then the buyer: the agent, played through the
stand console, through `curl`, and through a language model given a task, a
budget and nothing of ours but the public addresses. Then the inspector, who drives
the order's state machine on purpose into each of its corners, and into the
gaps between its steps where a process dies or an answer is lost. Last the
merchant on the morning after, who opens the dashboard after a night away and
has to put yesterday right with the dashboard, the SDK and the public pages,
and whatever those tell them to do.

Two more people take part. The operator is the member of our team who runs
the test channel and the live one: they point the test channel at the build
under test, start the purchases that need real test funds, and own any account
made on the live channel. The operator's buyer is the stand console — a local
page from this repository, started with `pnpm stand`, that plays a merchant's
handler and, on its Agent tab, a buyer — connected to the test channel with the
key of a merchant made for the run, the operator's merchant, never the
newcomer's, and with a buyer key the operator has funded. Connected that way
the stand is also that merchant's handler, so the operator's merchant's cards
are answered by the stand and the newcomer's cards by the newcomer's own
process. The product owner is the person who has
the final word on the product, the only one who can allow Block G, and the one
who may exclude any row from a run, in advance or on the day; their word is
quoted in the report and the row is then not measured rather than failed or
blocked.

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

Block A answers its question only when the newcomer is a person who is not on
the team and has not integrated with Agentify before. A run in which a member
of the team or a language model plays the part still finds defects and still
runs every row, but it does not measure how long a stranger takes or where
they stop: the report then marks the newcomer's numbers as not measured, says
who played the part, and the verdict cannot be "ready" on that run. The
newcomer's merchant is a rehearsal: it is removed after the run (the test
channel has a command that forgets an address, `pnpm forget <email>`), and a
rehearsal is not the first merchant we do not control. If the product owner
reads it otherwise, they say so before the run.

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
  cold-reading cases; and, for the buyer's story in Block B, a language model
  that can run shell commands in a directory the tester prepares.

The tester needs no wallet with funds. Purchases on the test channel are
started by the operator, whose buyer key holds the test funds; on the local
stack nothing settles. The stand console needs a buyer key all the same,
written as `STAND_BUYER_KEY=0x…` with 64 hexadecimal characters in `.env.stand`
at the root of the checkout; on the local stack any throwaway value of that
shape will do, since it holds nothing. Two rows in Block B run the stand
against the test channel with a key that holds nothing, or less than the price,
on purpose: the shortage is what they test.

### The ledger handler

From Block C onward the inspector's own handler is the instrument that shows
whether the merchant's real action happened once. Two merchants are in play on
the local stack from then on: the first merchant is the one the stand console
is connected as, whose handler the stand plays; the second merchant is the
inspector's own, whose key the ledger handler runs with. The tester writes the
ledger handler from the quickstart's handler, with the SDK, and it keeps its
records on disk, in one directory per merchant shared by every process that
runs with any of that merchant's keys, so they survive the process dying and a
second process can read them:

- `arrivals.log` gets one line for everything that arrives — an order, a price
  question or an event: the kind, the identifier, and the time. Orders arrive
  at least once by contract, so two lines for one order are ordinary; the log
  is what makes the count knowable. Events are taken by a handler registered
  with `on('event', …)` and logged the same way, so that none of them reaches
  the problem handler as unclaimed.
- `actions.log` is append-only and gets one line for every action the handler
  takes: the order's identifier, the goods it will answer with (an access
  address carrying the order's identifier will do), and the time. The line is
  written before the answer leaves the process, because that write stands for
  the merchant's real action — the licence issued, the unit taken. Two lines
  for one order identifier is what "acted twice" means below, and nothing in
  the handler may overwrite or remove a line.
- `claims/<order id>` is a file the handler creates exclusively — the creation
  fails if the file exists — right before it acts. The process that created the
  claim acts and appends to `actions.log`; a process that finds the claim
  already there does not act, and answers with the goods recorded for that
  order. This is the handler's idempotency by the order's identifier, and the
  exclusive creation is what keeps two processes on one key from both acting.
- `stock.txt` holds a number. The price handler, registered with
  `on('quote', …)`, answers the card's price while the number is above zero and
  "unavailable" at zero. Taking an action takes one off it, and a handler that
  comes to act when the number is already zero refuses the order with
  `out_of_stock` instead of acting.
- `problems.log` gets everything the problem handler receives.
- Switches, read from the environment. The mode: deliver at once; accept (the
  asynchronous answer — the goods are recorded as the action at the acceptance
  and sent later by the command below); accept on the first arrival of an order
  and throw on every later arrival of it; refuse with a code and a message of
  the tester's; throw on every arrival; throw on the first arrival of an order
  and deliver on the next. A hold, in milliseconds, waited before answering in
  any mode. And a switch that makes the process exit right after the action
  line is written and before the answer leaves.
- On `SIGTERM` the process awaits the SDK's `stop()` and exits; `SIGKILL` is
  the hard kill, and rows say which of the two they mean.
- A small command, `deliver <order id>`, that reads the order's goods from
  `actions.log` and sends them with `agentify.orders.forId(id).deliver(…)`.

Rows say "the ledger handler" when they need it, and what to read from it. The
stand plays the first merchant and keeps its own feed of what arrived; where a
row needs the ledger's records, it runs under the second merchant.

The handler's subscription is a long poll: the process asks the gateway for its
next message, and that request is parked — held open — for up to twenty-five
seconds, until something arrives or the window ends, and is then asked again.
A process that stops leaves its last poll parked until that window ends, and
several rows turn on what happens to a message that falls due inside it.

## Where it runs

| Environment | Address | What it is used for | Rules |
| --- | --- | --- | --- |
| Local stack | `http://localhost:8080`, started with `docker compose up --build` | The state machine, the agent's errors, the gaps between steps, everything that needs many purchases | Nothing settles and no money exists; the payment layer verifies nothing, so a payment can be written by hand and nothing about wallets or signatures can be proved here; sign-in messages appear in `docker compose logs app`; a merchant called `the_merchant` is seeded with two cards and a handler of its own in the `merchant` service |
| Test channel | `https://test.agentify.ad` | The newcomer's path, real email, the npm package, real settlement on Base Sepolia with test funds, everything about wallets and signatures, the morning after | Shared and owned by the operator: ask before starting and do not move its deployment. Purchases are started by the operator, at most 0.01 test USDC each except a WooCommerce product at its shop's price; the plan needs about a dozen of them, three of which are meant not to settle and two of which are the WooCommerce product, and the operator names the run's total before it starts. The operator's buyer never connects with the newcomer's merchant key, or it would take the newcomer's orders |
| Live channel | `https://agentify.ad` | Reading the public pages and the docs | Never a purchase. Block G runs here only on the product owner's word, and creates a real account |

## Before a run

Whoever organises the run records what is being tested, in the report's first
section, before the first case:

- The commit the test channel runs. It runs whatever commit its `deploy-test`
  tag points at, and that is not always `main`. Ask the operator to point it at
  the commit under test, then record it (`git ls-remote origin
  refs/tags/deploy-test`).
- The SDK and contracts versions the newcomer will install (`npm view
  @nuanu-ai/agentify version`, and `npm ls` in the newcomer's directory once
  they have installed), and the commit the local stack was built from. The npm
  package can lag the test channel, because the channel takes any commit while
  npm takes a release. A case that depends on a change not yet on npm is marked
  "blocked by release" rather than failed.
- The release the live channel runs, read from the deployment's own record
  rather than by calling the channel, and the release the SDK on npm was
  published from. A stranger installs what npm holds, so a live channel that
  is behind the contract that SDK speaks is a finding on the day of the run,
  whatever the plan says about Block G.
- The changes merged since the previous run, each with the rows that check it.
  A merged change that rewrites a documented promise rewrites the expectation
  of the rows that cite that page, so those rows are read against the page as
  it stands on the day and the report says so; the plan is corrected after the
  run, not during it.
- The list of rows the product owner excluded from this run, with their word.

## How a case is read

Each block opens with the set-up it needs and closes with what to explore
freely. A case is one row: what to do, what should happen, where that
expectation comes from, the angle it serves, and its priority.

**Source.** Every expectation names where it comes from, because a mismatch
between the plan and the product is only a finding against the product when
the plan was standing on a promise. The sources are:

- `front`, `quickstart`, `cards`, `orders`, `failures`, `money`, `faq` — a
  page of the public documentation, named by its address. These are the
  merchant's pages.
- `contract` — the contracts package: its field descriptions, its codes and
  its JSON schemas. This is what an agent's program and the SDK read, and it is
  the only place some of the agent's words are written.
- `sdk` — the SDK's own messages, types and command output.
- `screen` — the words on the screen, or in the message, the person is reading.
- `rule` — a rule of the product from the charter or a decision record, which
  no merchant reads.
- `code` — a prediction read from the code, with no promise behind it. It can
  fail like any other; a mismatch with it is a correction to the plan, unless
  what happened also breaks a page, the contract or a rule, and only then is it
  a finding.
- `record` — nobody has made a prediction. The row passes when the tester wrote
  down what happened; what they wrote may still produce a finding. Where a row
  marked `record` also states an outcome as a rule — the only acceptable
  outcomes, say — that outcome is held to, and the row fails when it did not
  hold.

Outside rows sourced to `code` alone, a mismatch between what should happen and
what happened is a finding even when the tester believes the plan or the
documentation is the one that is wrong; the finding then says which of the two
they believe and why.

**Priority.** Each row carries its own, set by what its failure would cost a
stranger rather than by the block it sits in:

- P0 — money, the ownership of an order, a promise the agent has paid for, the
  isolation of one merchant from another, a key that works after its
  revocation, or the three views disagreeing. P0 rows are never skipped by
  choice, and a run in which one could not be run has not measured the question
  that row serves.
- P1 — a stranger's path blocked, or a promise on a page, a screen or an error
  that does not hold without money moving. Skipped only with a line in the
  report saying so.
- P2 — comprehension: words, steps and entities the goal did not need. Run when
  the run has room.
- P3 — the experimental surfaces, which are not the product under acceptance.

After every case that moves an order, compare three views of it: what the agent
reads (the purchase answer, or the order's status address), what the merchant's
code reads (`agentify.orders.get(id)`), and what the dashboard shows on Orders
and Receipts. The dashboard words map to the agent's status words like this:
in progress — `in_progress`; delivered — `delivered`; shipped — `shipped`;
refused — `rejected`; payment outcome unknown — `payment_unresolved`; closed on
time limit — `expired`; closed when you left — `cancelled`; refund due —
`refund_due`; refunded — `refunded`; delivered, not paid — `delivered_unpaid`.
The three views disagreeing is a finding of the highest weight. Where a row
names the ledger handler, a fourth view joins them: the handler's own records
of what arrived and what it did.

## Order of work

The blocks run in this order. It goes from what every merchant and every agent
meets on every sale to what a few meet rarely, except that the cold read comes
first because it cannot be repeated, and the gaps between steps come right
after the state machine because every deploy of a merchant's process walks
through them. Each row carries its own priority; the blocks carry none.

| Block | What it covers | Where |
| --- | --- | --- |
| A | The newcomer's path from the public site to the first test sale | Test channel |
| B | The agent's purchase: finding, reading, paying, collecting, and a buyer with a task and a budget | Local stack, then test channel |
| C | The order's state machine in every mode and every way it can end | Local stack |
| J | Between the steps: lost answers, a process that dies mid-action, a deploy with open orders | Local stack |
| D | What is refused at the door: cards, merchant settings, keys, client set-up | Local stack and test channel |
| E | The dashboard day to day: sign-in, cards, orders, receipts, keys, settings | Test channel, local stack for volume |
| K | The morning after: finding and closing yesterday's debts with the dashboard, the SDK and the pages, and whatever those tell the merchant to do | Test channel |
| F | Parcels: address, price by place, shipment, erasure | Local stack and test channel, after the SDK release |
| G | Rules that exist only where money is real | Live channel, only with the product owner's word |
| H | The WooCommerce connector, which is experimental | Test channel |
| I | The scanner, and the way from its report into the dashboard | Test channel |

The scanner comes last on the product owner's word: the product under test is
selling through the SDK, and the scanner is the front page a merchant may pass
through on the way. Block A still starts at the front page, but only to find
the way to selling; the scanner's own checks wait for Block I.

Exploratory time sits at the end of every block rather than in a block of its
own: once the listed cases are done, the tester spends some time trying to
break that block's promises in ways the plan did not think of, and records what
they tried even when nothing broke. The list of suspicions near the end of this
plan is handed to the tester when Block A is done and not before; the
exploration of each block is done before the suspicions that name its rows are
looked at.

## Block A. The newcomer's path to the first test sale

Set-up: the main alias, a clean browser profile, an empty directory outside any
repository, and the operator on hand to start one or two purchases. The tester
has not opened the repository. Each purchase costs at most 0.01 test USDC, so
the card's price is `0.01 USD`.

The tester keeps two clocks for the report: from opening the front page to the
first card published, and from there to the first test sale. They also note
each stop: the moment they did not know what to do next, how long it lasted and
what got them moving again.

| ID | Do | What should happen | Source | Angle | P |
| --- | --- | --- | --- | --- | --- |
| A-01 | Open `https://test.agentify.ad/` knowing only that "Agentify lets my shop sell to AI agents". Find how to start selling and how an engineer connects a shop. Do not type `/docs` by hand. | The front page offers a way to selling ("Came here to sell? How selling to agents works") and a header with Docs and Dashboard. Record every click and every word not understood on the way. | screen | UX, Extra | P1 |
| A-02 | Read the documentation's front page as the owner of the business. Then answer, in writing and without looking back: what will I be asked, where does the money go, what do you take, what can I sell during the pilot, how do I stop. | Every answer is on that page or one link away. Record each question the page left open or answered in words the owner would not use. | front | UX, Claim | P1 |
| A-03 | Open the dashboard and sign in with the main alias. Follow the message to the end. | "Check your mail", then a message "Sign in to your Agentify dashboard", then a page "This link signs … in on this browser" with a button "Sign in as …". Opening the link alone signs nobody in; the button does. Then "Open a seller dashboard" with one button, "Open my seller dashboard", which asks for the seller name. Record where the message landed (inbox, spam, a promotions tab), how long it took to arrive, and who it appears to come from. | screen | UX | P1 |
| A-04 | Choose a seller name. In Settings, give the shop's site and a payout wallet. The newcomer has no wallet: record what they do to get an address and whether the page helped. | The test channel's banner is on every page and says payments settle on Base Sepolia with test funds. A valid address is saved at once, shown in groups of four, and no message is sent. | screen money | UX, DX | P1 |
| A-05 | Issue a key named "first integration". Copy it. Reload the page that shows it. | The secret is shown once, starts with `csk_test_`, and a reload does not issue a second key. The list shows the key with "No calls recorded". | screen | UX, Claim | P1 |
| A-06 | Follow the quickstart's install step exactly as printed. Then run `npm ls --all`. | One install command. The tree holds the SDK, its contracts package and zod, and nothing else. | quickstart | DX | P1 |
| A-07 | Copy the client code from the quickstart into a file and run it as a newcomer would. | Record every change needed to make the printed example run: a file extension, a `"type": "module"`, a TypeScript runner, the environment variables. Each change the page did not mention is a finding. | quickstart | DX | P1 |
| A-08 | Publish the smallest card from the quickstart, with the price changed to `0.01 USD`. | `ok: true` and a catalogue `id` beginning `item_`. The card appears on the dashboard's Cards with its product code, price, delivery "immediate" and state published. | quickstart cards | DX, State | P1 |
| A-09 | Write the synchronous handler from the quickstart, register `on('problem', …)`, and start it. | The first log line says which gateway it started against and that the money there is not real. The process stays up and the problem handler stays quiet. | quickstart sdk | DX, Claim | P1 |
| A-10 | Run the card check exactly as the quickstart prints it, on the card from A-08 saved as `card.json`. | The card is reported complete as far as the contract can tell, and the output names what the check does not cover. Record the exit code against what the quickstart says about it on the day, what the newcomer concludes from the output, and whether a build script would treat the result as a failure. | quickstart sdk | DX, Claim | P2 |
| A-11 | Ask for the first test purchase the way the documentation says. | The quickstart says who starts it. Record how the newcomer found that person, what they had to send, and how long they waited. | quickstart | UX | P1 |
| A-12 | The operator buys the card once. Watch the handler, the dashboard and, if the operator shares it, the buyer's output. | One order reaches the handler; the buyer receives the declared goods; Orders shows one delivered order tagged test; Receipts shows one receipt; the order reads `test: true`. Record the order and receipt identifiers. Find the transfer to the payout wallet on a Base Sepolia block explorer. | quickstart orders money | State, Claim | P0 |
| A-13 | Publish a second card, asynchronous: a new `merchant_item_id`, `fulfillment: 'async'`, `fulfill_deadline_seconds: 600`. Extend the one handler to tell the two cards apart by `order.merchant_item_id` — one client registers `on('order')` once, and a second process on the same key would split the orders — so that for this card it saves `order.id` and answers `accepted`; a separate step calls `agentify.orders.forId(savedId).deliver(...)` a minute later. The operator buys it once. | The buyer gets an order in progress with an address to read it at, then the goods at that address after the delivery. The receipt appears only after the delivery. | quickstart orders | DX, State | P0 |
| A-14 | Stop. Write down the two clocks, every stop, every question asked of a person, and the list of ideas the newcomer had to learn before the first sale. | The report's "newcomer's numbers" section is filled in. | record | DX, Extra | P1 |
| A-15 | Decide, from the pages alone, where this handler will run tomorrow when the laptop is closed: what kind of host, whether it has to stay up, whether a function that runs on demand would do. | The quickstart or the FAQ says that the handler is a process that keeps a subscription open and has to be running to sell, and gives the newcomer enough to choose a host. Record what the newcomer decided and what they had to guess. | rule | DX, Claim | P1 |

Explore: a second engineer who also needs the dashboard (record how they would
get in; nothing on the screens offers an invitation); the quickstart read on a
phone; every link in the quickstart followed once.

## Block B. The agent's purchase

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
signature, its amount or its payee, so a payment can be written by hand, and
the cases about repeated, borrowed and late payments run with `curl` alone.
Nothing about wallets, balances or signatures can be shown here: those rows run
on the test channel. A payment is the challenge's first offer, a payer and a
number used once, encoded the same way the challenge is, and sent in the
`PAYMENT-SIGNATURE` header of the same request with the same body:

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
`accepts[0].extra.order_id`, and its status is read at
`$GW/x402/orders/<order id>/status` with no credentials. Keeping `payment.txt`
and sending it again repeats the same payment; a new nonce with the same payer
is a fresh authorization from the same buyer; another `PAYER` is another buyer.
A new unpaid request opens a new order, so the only way to pay an order again
is to present a payment that names it. None of this works on the test channel,
where a payment has to be signed for real.

| ID | Do | What should happen | Source | Angle | P |
| --- | --- | --- | --- | --- | --- |
| B-01 | Pretend to be an agent given only the address `https://test.agentify.ad` and the task "buy a month of access". Try `/.well-known/x402`, `/x402`, `/llms.txt`, and whatever else an agent would try. | Record how the catalogue at `/x402/catalog` can be found without our documentation, and whether an agent that found nothing is told anywhere that there is a catalogue to find. | rule record | AX | P1 |
| B-02 | Read `GET /x402/catalog`. | Only cards on sale are listed. Each carries a title, description, price, mode, the purchase parameters, the delivery result, and `seller` with `name` and `site`. Two questions for the tester: an asynchronous card that names no deadline shows none, although a day applies — can an agent tell? And can an agent tell from the document itself that the merchant gave the seller's name and site and nobody checked them? | contract | AX, Claim | P1 |
| B-03 | Probe one card: `GET /x402/<id>/purchase`. Decode the challenge. | 402, nothing bought and no order opened. The challenge names Base Sepolia (`eip155:84532`), USDC, the price in the asset's smallest units, the merchant's own wallet as `payTo`, and a discovery declaration whose method is POST. The price equals the card's, and `payTo` is the merchant's wallet where one was saved in Settings (on the local stack without one, the stand-in address). | contract money | AX, Claim | P0 |
| B-04 | Start a purchase in the stand (two presses: the challenge, then the signature). Before signing, read the challenge the stand shows. | The unpaid request with a purchase document opens an order, and its identifier rides in the challenge. Signing pays that order and no other. | contract orders | AX, State | P0 |
| B-05 | Buy a synchronous card. | The goods arrive in the answer to the purchase, with a settlement header — the payment layer's own receipt, carried in a header of the answer — and the status document reads `delivered` with the price, `test: true`, the seller and the same goods. | contract orders | AX, State | P0 |
| B-06 | Buy an asynchronous card. Read its `status_url` until the goods arrive. Then read it again from another machine with no credentials. | First answer: `in_progress`, no goods, the status address, and no settlement header. Later: `delivered` with the goods. Anyone holding the order's identifier can read it; record whether that is said anywhere an agent would read. | contract orders | AX, Claim | P0 |
| B-07 | With `curl`, send what an agent gets wrong: an unknown card; a paused card; a body that is not JSON; JSON with the wrong content type; a missing required parameter; an undeclared parameter; a parameter of the wrong type; a `ship_to` on a card that does not ship; a body over 256 kilobytes; the status of an order that does not exist. | Each is refused before any money, in one envelope `{"error":{"code","message","retryable"}}`, with the right status (404, 409, 400, 400, 422, 422, 422, 422, 413, 404). Where a field is at fault, `problems` names it. For each, ask a language model what to do next from the body alone, and record answers that go wrong because of our words. | contract | AX, Door | P1 |
| B-08 | A paused card with a bad parameter. | 422 about the parameter rather than 409 about the pause, because the checks run in that order. Record whether an agent that fixes the parameter and then meets the pause has been misled. | code | AX | P2 |
| B-09 | With `curl`, send a paid request whose `PAYMENT-SIGNATURE` header is not a payment at all. | A fresh 402 challenge whose decoded header carries a sentence saying the payment could not be read; the body is empty; nothing is charged. Record whether an agent that reads only the body learns why. | code | AX | P1 |
| B-10 | With the hand-written payment, pay an order, then send the same `payment.txt` again to the same order. | The repeat is a safe retry: it is answered with where the order stands and the goods already delivered, and nothing is charged or delivered twice. Record the status code and the headers of the repeat's answer, and what an x402 client would conclude from a settlement header on an answer that is not a fresh purchase. | failures money | State | P0 |
| B-11 | Take a second challenge for another order of the same card, and present the old payment against it: the new order's offer in `accepted`, the old payer and nonce kept. | 409 `payment_already_spent`, saying one payment buys one order and this one needs a fresh payment. Nothing charged. | contract | State, AX | P0 |
| B-12 | Pay an order as one payer, then present a different payer's payment for the same order. | 409 `not_this_purchase`: the order already belongs to another payment. | contract | State, AX | P0 |
| B-13 | On the test channel, with the operator's buyer connected as the operator's merchant: save that merchant's wallet in Settings, take a challenge, change the wallet, then sign and pay the old challenge. | Record what happens. The payment is checked against the wallet as it stands at that moment; the only acceptable outcomes are a refusal before any charge that tells the agent what to do next, or a payment to the address the agent signed for — never money sent to an address the agent did not agree to. This row runs on the test channel only: the local payment layer checks neither payee nor signature, and would show the worst outcome for a reason that is not the product's. | rule record | State, Door, Claim | P0 |
| B-14 | Refuse in the stand's handler with a code and a message of your own. Read the status. | The status carries `refusal` with exactly that code and message. No other ending carries a refusal. | contract | AX, Claim | P1 |
| B-15 | Cold reading by a language model. Give a model with no context the catalogue, one decoded challenge, an asynchronous status in progress, a status that reads `refund_due`, and three error bodies from B-07. Ask: what will I get; what must I send; when am I charged; what happens if the seller fails; who sells and can I trust it; should I repeat this call; what does "in progress" mean; how do I get my goods later; what does "refund due" mean for my money and what do I do now. | Mark each answer right or wrong against the truth. Every wrong answer caused by our words is a finding. Keep the transcript. | record | AX | P1 |
| B-17 | Send a payment on the probe: `GET /x402/<id>/purchase` with a `PAYMENT-SIGNATURE` header holding a valid payment for some order. | 402 and nothing charged. The decoded challenge's line says the GET is not read for payment and that the purchase is a POST with a JSON body, so an agent that took the probe for the purchase learns the difference rather than reading its payment as failed. | code | AX, Door | P1 |
| B-18 | The buyer's story. It needs the ledger handler and the second merchant from Block C's set-up, so it runs once those exist. The tester publishes two story cards under the second merchant: an asynchronous card at `0.02 USD` with `fulfill_deadline_seconds: 600` and a title of its own, and a synchronous card at `0.01 USD`. Outside the checkout, prepare a directory with three one-line scripts that wrap the recipe above: one opens an order for a card named by its catalogue identifier and saves its challenge, printing the order's identifier and the price; one pays a saved challenge, with the same nonce unless told to use a fresh one; one reads an order's status. Give a language model a shell in that directory, the local catalogue's address, the three scripts, a budget of `0.05 USD` and the task "buy one of `<the asynchronous card's catalogue identifier>` and give me what you bought". The tester sets the ledger handler's mode before telling the model to start each step: first accept, with the tester sending the goods with `deliver <order id>` three minutes after the purchase; then, for a second task naming the synchronous card, deliver at once with a hold of about 12 seconds, so that the answer is late; then, for a third task on the same synchronous card, deliver at once with no hold. Changing the mode restarts the handler: wait 30 seconds after each restart before telling the model to start. Count the orders opened, the payments made and the money charged. | The model buys each product once: it waits for goods that come later by reading the status address and does not open a second order while one is in progress; after the synchronous order closes on its time limit it either pays that same order again with a fresh authorization or opens a new one, and in neither case is anything charged twice; the money charged stays within the budget; it reports the goods it holds. Record every decision the model took from the words in our documents, right or wrong, and keep the transcript. A second order opened for goods already in progress, or a budget overrun, is a finding of the AX angle: the words that led to it are ours. | failures orders record | AX, State | P0 |
| B-19 | On the test channel, with the operator's leave, connect the stand as the operator's merchant with a `STAND_BUYER_KEY` that holds no funds. Buy a 0.01 card of that merchant's. | Nothing settles. The agent is told at once that its payment did not pass and why, in words a program can branch on and a model can act on, and the order afterwards reads what the orders page's table of endings names for a payment that failed its check. Record the exact words, the status the order reads later, and whether the merchant's handler was ever reached. | contract orders | AX, State, Claim | P1 |
| B-20 | As B-19, with a key the operator has funded with less than the price (0.005 test USDC against a 0.01 card). | The same as B-19. Record whether the words tell a shortage apart from an empty wallet, and whether the agent could learn how much it lacks. | contract orders record | AX, Claim | P1 |

Explore: two agents buying the same card at the same second; an agent that
ignores the status address and buys again.

## Block C. The order's state machine

Set-up: Block B's local stack and stand, and a second merchant on the same
stack for the ledger handler. Two merchants are needed because every process
subscribed with one merchant's key shares that merchant's orders: the stand and
the ledger handler on one key would take orders from each other at random. The
stand stays connected as the first merchant and plays its handler; the ledger
handler runs with the second merchant's key. The second merchant's cards are
bought from the stand's Agent tab, which buys any card in the public catalogue,
or with `pnpm buy <catalogue id>`, which signs with a built-in throwaway key
and needs no merchant key. The stand's Orders tab sets how the first merchant's
handler answers: "Deliver at once", "Accept, then deliver after the delay",
"Accept and never deliver", "Refuse with the code below", "Answer only after
the deadline", "Deliver a shape the card never declared", "Hold it and ask
me". Its price answers are "Answer the price below", "Say the price is
unavailable" and "Answer only after the deadline". Its Owed panel delivers or
refuses an order already taken on. What the stand cannot do — throw, answer
slowly on its own, crash, run twice, be absent — the ledger handler does under
the second merchant.

The numbers the cases rely on are the documented ones, read on the orders and
failures pages on the day of the run: a price holds 30 seconds; a price
question is answered within 5 seconds or counts as silence; one delivery
attempt is waited for 3 seconds; a synchronous order has 8 seconds from the
moment its payment checked out, inside 10 promised to the agent; an order is
sent to the handler at most five times; an asynchronous card without a
deadline of its own is held to one day.

For every case, read the three views as described above, and check the money:
in the synchronous mode the charge comes last, so any ending other than a
delivery means nothing was charged; in the asynchronous mode the charge comes
first, so any ending other than a delivery means a refund is owed. Where the
ledger handler is in play, read its records too: arrivals may be more than one,
actions must be exactly one for each order.

Synchronous card:

| ID | Do | What should happen | Source | Angle | P |
| --- | --- | --- | --- | --- | --- |
| C-01 | "Deliver at once". | `delivered`; goods in the answer; one receipt; Orders shows delivered. | orders | State | P0 |
| C-02 | "Refuse with the code below", code `out_of_stock`, a message of your own. | `rejected` with that code and message; nothing charged; no receipt; Orders shows refused. | orders contract | State, Claim | P0 |
| C-03 | "Answer only after the deadline". | At the end of the synchronous window the agent is told the order closed on its time limit (`expired`), and never `in_progress`; nothing charged; no receipt. Record whether the late answer shows anywhere on the merchant's side. | orders | State | P0 |
| C-04 | "Deliver a shape the card never declared". | The merchant's side is told the goods do not fit the card, with the fields named; nothing is written down; the order is sent to the handler again, and with the same wrong answer each time the purchase ends at the window without goods and without a charge. | orders cards | State, Door | P0 |
| C-05 | "Accept, then deliver after the delay" on a synchronous card. | The acceptance is refused as `not_applicable_in_mode`; the order is not sent again for that answer; it ends at its deadline with nothing charged. The handler's problem report says why. | orders contract | State, Door | P1 |
| C-06 | "Hold it and ask me", then deliver at about the fifth second. | An answer later than the 3-second wait still counts inside the window: the purchase completes once with one receipt. The order arrives once — a worker is handed one order at a time, and a delivered order is not handed out again. Record any second arrival. | orders | State | P0 |
| C-07 | The ledger handler throwing on every arrival. | Repeated deliveries with growing pauses — about three fit in the window, never more than five — then closed on its time limit with nothing charged. Each throw reaches the problem handler and none reaches the agent. The ledger shows the arrivals and no action. | orders failures | State, DX | P1 |
| C-08 | The ledger handler throwing on the first arrival of an order and delivering on the next. Run it ten times. | Delivered on the second arrival, inside the window, in every one of the ten: the orders page promises the order is sent again until the deadline runs out or it has been delivered five times, and about four seconds remain for the repeat. One receipt and one action each. Record the instant of each arrival, so that a repeat that waited on something other than the clock can be seen. | orders failures | State | P1 |
| C-09 | Stop the ledger handler, so nothing is subscribed for the second merchant; buy its synchronous card. Then start the handler. | The purchase ends without goods and without a charge within the window. Starting the handler afterwards does not revive that order, and it is never handed to the handler: no arrival in the ledger. | orders | State | P0 |
| C-10 | The ledger handler killed with `SIGKILL` while it holds an order (a hold of a few seconds), and restarted within the window. | The order reaches the new process; delivered once; the ledger shows two arrivals and one action. | orders | State | P0 |
| C-11 | With "Answer only after the deadline", let a synchronous purchase expire while the stand's late answer stores the goods. Then pay the same order again with a fresh authorization from the same payer (Block B's hand-written payment, new nonce, same `PAYER`). | The stored goods are released without another call to the handler; the order reads `delivered`; one charge and one receipt. The documentation promises this retry to the same buyer: record what a different payer gets. | orders | State, AX | P0 |

Price question (a card with `price_check: 'handler'`):

| ID | Do | What should happen | Source | Angle | P |
| --- | --- | --- | --- | --- | --- |
| C-12 | Answer a price different from the card's. | The challenge names the answered price; the sale goes at it; the order's price and the receipt carry it with its `as_of`; Orders and Receipts show it. | cards money | State, Claim | P0 |
| C-13 | "Say the price is unavailable". | The purchase is refused before any money; no order reaches the merchant's handler; the status has no merchant words. | failures | State | P0 |
| C-14 | Price answer silent, synchronous card. | After 5 seconds the purchase carries on at the card's price. | failures | State | P1 |
| C-15 | Price answer silent, asynchronous card. | The purchase is refused; no order reaches the handler; nothing charged. | failures | State | P0 |
| C-16 | Start a purchase, take the challenge, wait 31 seconds — just past the price's life — then sign. Do it again, waiting 40 seconds. | Nothing is charged and nothing reaches the merchant, however short the lapse. The orders page says what the agent is given when its price has lapsed; record the exact answer in both cases against that section as it stands on the day. | orders | State, AX, Claim | P0 |

Asynchronous card (the stand's asynchronous example has a ten-second deadline):

| ID | Do | What should happen | Source | Angle | P |
| --- | --- | --- | --- | --- | --- |
| C-17 | "Accept, then deliver after the delay". | `in_progress` with the status address, charged at the purchase; later `delivered`; the receipt is written at the delivery and not before. | orders | State | P0 |
| C-18 | "Refuse with the code below" before accepting. | `refund_due` straight away, with the merchant's code and message; an event tells the merchant a refund is owed; Orders shows refund due with its callout; no receipt. | orders | State, Claim | P0 |
| C-19 | Accept, then refuse from the Owed panel. | `refund_due` at once, without waiting for the deadline. | orders | State | P1 |
| C-20 | "Accept and never deliver"; let the deadline pass. | `refund_due` at the deadline; an event to the merchant; the order is on the merchant's list of open orders. | orders | State | P0 |
| C-21 | After C-20, deliver from the Owed panel. | The debt is closed with the goods: the agent reads `delivered` and the goods at the same address; one receipt; the delivery's answer says it closed a refund owed. | orders | State | P0 |
| C-22 | Deliver the same order twice. | Both calls answer `ok: true`, the second marked as already delivered; one receipt; the agent keeps the first goods. | orders | State | P0 |
| C-23 | Deliver goods that do not fit, then the right goods. | First: `delivery_does_not_match_card` with every misfit field in `problems`, `retryable: true`, the order unchanged. Second: delivered. | orders contract | State, DX | P1 |
| C-24 | The ledger handler throwing on every arrival, on an asynchronous card with a deadline of 600 seconds. | The order goes out again after each attempt, at most five times, then closes as if its deadline had passed — long before the 600 seconds: `refund_due`, since the money was taken. Count the attempts in the ledger. Record whether the merchant could have foreseen this from the documentation. | orders | State, DX | P0 |
| C-25 | The ledger handler holding 4 seconds before answering `accepted` (slower than the 3-second wait), and throwing whenever the same order arrives again. | A repeat that was already on its way may still arrive, but once the acceptance has reached the gateway, failures no longer spend attempts: the order is not closed after five, and waits for its delivery deadline or a delivery. | orders | State | P1 |
| C-26 | Accept an order, kill the handler with `SIGKILL`, restart it, and read `agentify.orders.list({ open: true })`. Deliver with `orders.forId(id)` from the ledger's entry. | The open order is on the list; the delivery succeeds; no second goods; the ledger has one action for the order. | orders | State, DX | P0 |
| C-27 | Stop the ledger handler so that an accepted order's deadline falls about two seconds after the stop, and restart it once the deadline has passed. Do it with `SIGTERM`, which awaits the SDK's `stop()`, and again with `SIGKILL`. Then once more with `SIGTERM`, the deadline about two minutes away. | After a `SIGTERM` the refund event arrives once, on the restarted process's first poll, at either timing: the SDK's description of `stop()` promises that a poll it left parked hands nothing to a process that has gone. After a `SIGKILL` the orders page says an event that went out in a poll answer the process never received is gone: record whether it arrived. The order is on the open list as refund due in every variant, so the merchant can find the debt whether or not the event reached them. | sdk orders record | State, DX | P0 |
| C-28 | Run two copies of the ledger handler on one key, holding 5 seconds. | One order may reach both copies; the buyer gets one delivery and one receipt; the ledger shows one action for the order, in one of the two processes, and the other's arrival answered with the same goods. | orders | State | P0 |
| C-34 | The ledger handler holding past the synchronous window and then refusing, on a synchronous card. | The orders page's table of endings names what a synchronous order becomes when time runs out; a refusal that arrives after that moment finds the sale over and does not change the ending. Record the status the agent reads and what the handler is told. | orders | State | P1 |

Pausing:

| ID | Do | What should happen | Source | Angle | P |
| --- | --- | --- | --- | --- | --- |
| C-29 | Pause one card in the dashboard. Probe it, read the catalogue, try an unpaid purchase. Then resume. | Paused: gone from the catalogue, the probe answers 409 `not_selling` and no challenge. Resumed: listed again, and the probe answers 402. | cards contract | State, AX | P1 |
| C-30 | Accept an asynchronous order, pause the card, then deliver. | The pause closes no order: the delivery goes through. | faq orders | State | P0 |
| C-31 | "Pause all sales", then "Resume all sales". | Every card stops and starts; open orders play out. | faq screen | State, UX | P1 |
| C-32 | Take a challenge, pause the card, then sign. | Record what happens. Under the door rule the only acceptable outcomes are "refused before any charge" and "completed"; a charge without goods is the worst finding this block can produce. | rule record | State, Door | P0 |

Explore: a price question answered after its five seconds; an order refused
and then delivered from the Owed panel.

Some endings cannot be caused by hand on either channel, and the tester does
not try: `delivered_unpaid` and `payment_unresolved` need the payment network
to fail between the check and the charge; `refunded` needs a recorded refund,
and no command records one yet; `cancelled` needs a merchant to leave, and
leaving is not built; `declined` belongs to the confirmation mode, which is not
open. The automated suite covers them. The tester checks only that the
dashboard's words for them (delivered, not paid; payment outcome unknown;
refunded; closed when you left; declined at confirmation) are understandable to
a merchant, and records which of them a merchant can reach today.

## Block J. Between the steps

Set-up: Block C's local stack, stand and ledger handler. This block lives in
the gaps the state machine's rows step over: the answer that never reached the
agent, the process that died after acting and before saying so, the deploy that
happened with orders open. Each row ends with the three views and the ledger.

A lost answer is made on purpose with `curl --max-time 2`: the ledger handler
holds five seconds, so the client gives up at two, the gateway carries on,
and the answer goes nowhere. The hand-written payment from Block B is used, and
`payment.txt` is kept for the retries:

```sh
curl -s --max-time 2 -X POST "$GW/x402/$ITEM/purchase" -H 'content-type: application/json' \
  -H "PAYMENT-SIGNATURE: $(cat payment.txt)" -d "$BODY"; echo "exit $?"   # 28: lost on purpose
```

| ID | Do | What should happen | Source | Angle | P |
| --- | --- | --- | --- | --- | --- |
| J-01 | A synchronous card under the ledger handler, holding five seconds. Pay with the command above, so the answer is lost. Wait ten seconds. Then, in turn: send `payment.txt` again unchanged; send a payment for the same order with a fresh nonce and the same payer; open a new purchase from scratch and pay it; read the first order's status by its identifier. | The first order reads `delivered` with the goods, one receipt, one action in the ledger: the purchase went through although nobody heard it. The unchanged repeat and the fresh authorization for the same order each hand back the goods already delivered with no second charge and no arrival in the ledger. The new purchase is a second order and a second charge: record it. The failures page describes a buyer that repeats the purchase under the same key after a lost answer; record whether anything the agent was handed for this order — the challenge, the payment it sent — tells it to do that. The contract names the status route, and nothing the agent was handed for this order carries that address, so the tester reads the status by the route the contract names and records that the agent would have had to know it. | failures money orders contract | State, AX | P0 |
| J-02 | An asynchronous card under the ledger handler with the exit switch set: the process dies right after writing its action and before answering `accepted`. Buy once. Restart the handler. | The order was charged at the purchase. The order arrives again at the restarted process, which finds its own entry and answers with the same goods instead of acting again; the ledger shows two arrivals and one action; the order ends `delivered` once the handler delivers from the entry. Nothing in Agentify's views betrays the death; the merchant's record is what carried it. | failures orders faq | State | P0 |
| J-03 | Three orders open at once on the local stack: one priced and not paid, one synchronous order dispatched to a handler holding five seconds, one asynchronous order accepted with a deadline a minute away. Then `docker compose restart app`. | Record what each buyer was told at the moment of the restart, and how each order ended after it: the price lapses on its own clock; the synchronous buyer's answer is lost and the order ends inside its window or is held for a repeat; the accepted order's deadline fires after the restart and the order becomes refund due or is delivered. Nothing waits forever, nothing is charged twice, and the three views agree once the stack is back. | rule record | State, Claim | P0 |
| J-04 | Stop the ledger handler with `SIGTERM` and, within two seconds, buy an asynchronous card under the second merchant. Restart the handler in the mode that throws on every arrival and count the arrivals until the order owes a refund. Do the same with `SIGKILL`. Then, with each way of stopping, buy a synchronous card with a price check within two seconds of the stop, and restart in the deliver mode. | After a `SIGTERM`, five arrivals, and the price question logged by the restarted process: nothing was handed to the process that had gone, as the SDK's description of `stop()` promises. After a `SIGKILL`, the failures page says a process that fell over costs a delivery attempt: record the count — four means one attempt went to the dead process — and whether the price question reached the ledger or the five seconds passed in silence and the sale went at the card's price. | sdk failures record | State, DX | P0 |
| J-05 | An asynchronous card under the second merchant with a deadline of 180 seconds, and no handler subscribed at all. Buy once. Read the status every thirty seconds. After the deadline, start the ledger handler. | Nothing stops selling on its own, so the purchase is accepted and charged. While nobody polls, no delivery attempt is spent: the order reads `in_progress` to the agent for the whole deadline and becomes `refund_due` at it, with the refund event waiting for the merchant. When the handler starts, the order is handed to it as an ordinary order, because late goods still close a debt; the handler's order carries no word for where it stands, so the handler cannot tell yesterday's debt from a new sale, and its delivery closes the debt with one action. Record what the agent read during those three minutes; what the merchant finds when they come back, on Orders and in the handler's records; and whether anything, on a screen or a page, told either of them that nobody was listening or that the cause was the merchant's own process being down. The Door question goes into the report: should a purchase be refused while nothing has polled for the merchant. | failures orders code | State, Door, Claim | P0 |
| J-06 | With the ledger handler running and idle, stop the local stack's `app` service for sixty seconds, then start it. Buy a card once it is back. | The handler's problem handler hears about the polls that failed and the process stays up; the SDK waits longer after each failure, up to about half a minute, and resumes on its own within about one window of the gateway returning. The purchase after the return is delivered once. Record how long the handler took to resume and what it said meanwhile. | sdk record | State, DX | P1 |
| J-07 | Pay an asynchronous order and let it end `refund_due`, the ledger handler refusing after the charge. Present that order's own payment again, unchanged. | The repeat is answered with where the order stands and nothing is charged. Record the status code, the headers and the body of the answer, and whether a repeat on an order that owes a refund tells the agent anything that B-15's reading of `refund_due` did not. | code record | AX, State | P0 |
| J-08 | The ledger handler with `stock.txt` at 1 under a card with a price check. Buy the card twice at the same moment, from two shells. Once on a synchronous card, once on an asynchronous one. | The goods ran out: the purchase that arrives second does not happen and its buyer's money does not move, provided the merchant said so in time. Record which of the two said so — the price answer or the delivery refusal — and what the second buyer's money did in each mode: in the asynchronous mode a refusal at delivery comes after the charge and leaves a refund owed. The pilot takes goods that survive a second delivery, so this is a door check: record what the pages tell a merchant whose goods can run out. | failures faq | State, Door | P2 |

Explore: a handler that answers an order it never received; the same order
delivered from two processes at the same moment; a purchase paid during
`docker compose restart app`.

## Block D. Refused at the door, or carried through

Set-up: the SDK client from Block A, pointed at the local stack for the card
cases and at the test channel for the merchant-settings cases. Every refused
card in this block is also saved as a file and run through the card check, so
the two can be compared.

The question in every row is the same: was the input refused at once, with
words that say what to change, or was it accepted and then carried through? A
third outcome — accepted, then ignored or failed later — is the one this block
exists to find.

| ID | Do | What should happen | Source | Angle | P |
| --- | --- | --- | --- | --- | --- |
| D-01 | On the test channel, a merchant with no seller name and no wallet publishes a valid card. | `ok: false`, code `card_rejected`, and one answer listing both `no_seller_name` and `no_payout_wallet` with an empty path, a sentence naming the missing settings, and `retryable: false`. On the local stack only the name is required. | contract cards | Door, DX | P1 |
| D-02 | Publish five cards, each missing one required field: `merchant_item_id`, `title`, `description`, `price`, `result`. | Each is refused with a finding that names the missing field. Record the words of each; a sentence written by the validation library rather than by us is a finding. | cards contract | Door, DX | P1 |
| D-03 | Plain text: a title with `<b>`, with `&amp;`, with a tab, with a line break; a description with `<p>` and with `&#8217;`. Then `Tea & coffee`, `AT&T`, `5 < 10` and `Map<String, Integer>` in a title, and `List<String>`. | The first six are refused, each naming the field, what was found, how many times and where. The next four are published exactly as written. `List<String>` is refused, because it has the shape of a markup tag. | cards | Door, Claim | P2 |
| D-04 | A description of exactly 500 characters, of 501, of 499 plus one emoji, and one of spaces only. | 500 passes; 501 is refused; the emoji counts as two; a blank description is refused. The card check says the same as publication for each. | cards sdk | Door | P2 |
| D-05 | Prices: `5 USD`, `5.0 USD`, `0.00 USD`, `5.00 EUR`, `5.0000001 USD`, `{ amount: '5.00', currency: 'USDC' }`, `0.001 USD`. | The first five are refused, each with a sentence that shows the right spelling; USDC is accepted. `0.001 USD` is accepted at publication: record that the live channel's smallest payable price is not known and nothing tells the merchant so. | cards money | Door, Claim | P1 |
| D-06 | Modes: `fulfillment: 'confirm'`; an unknown word; `fulfill_deadline_seconds` on a synchronous card. | Each refused with a reason. The confirmation mode's refusal says it is not open during the pilot. | cards | Door | P1 |
| D-07 | A `result` with no fields; a parameter of a type outside string, number, integer and boolean; a parameter the delivery needs but the card does not declare. | The first two are refused. The third is accepted, by design: no check can see what a delivery needs. Record whether the documentation's warning about it was where the newcomer would have read it. | cards | Door, DX | P1 |
| D-08 | Tags: six of them; one of 33 characters; one with a curly quote; one with a leading space; `eSIM` beside `esim`; an empty list. | The first five refused with the rule named. Record what an empty list does. | cards | Door | P2 |
| D-09 | A card whose price check names an address of yours instead of the handler. | Refused at publication, with a finding at `price_check` saying the price is asked of your own price handler and a hook is not called yet. The card check refuses it the same way. | cards faq | Door, Claim | P1 |
| D-10 | In an asynchronous handler, answer `order.accepted({ eta_seconds: 60 })`; then send `POST /v0/orders/<id>/accept` with that body directly. | Record whether the SDK and the route accept the field, and whether anything in its types, its messages or the orders page says what becomes of the number. A field accepted and kept nowhere is a finding. | orders sdk record | Door, Extra | P2 |
| D-11 | Republish a card under the same `merchant_item_id` with a new price while an order against it is open. | The same catalogue `id`, the new price in the catalogue and on the dashboard; the open order keeps the price it was sold at, and so does its receipt. | cards orders | State, Claim | P0 |
| D-12 | Accept an asynchronous order, republish its card with a different `result`, then deliver the goods the agent was promised when it paid; on a second such order, deliver the new shape. | The promised goods close the order: it is held to the result it was sold with. The new shape is refused for that order with the missing fields named, and is what new orders are sold with. | orders contract | State, Door | P0 |
| D-13 | Run every card refused in D-02 to D-08 through the card check. Run it also with no file, with an unknown command, on a file that does not exist, and on a file that is not JSON. | The check finds what publication found, counting the description's length the same way publication does, and exits 1. No file, an unknown command or an unreadable file: refuses and says why, with the exit code the quickstart names for that on the day — or, where the page names none, the code the command's own usage text names, and record that the page is silent. Not JSON: one finding about the card as a whole. | sdk quickstart | DX | P2 |
| D-14 | Build the client wrong: no `apiKey`; `baseUrl` of `test.agentify.ad` with no scheme; `http://test.agentify.ad`; `https://test.agentify.ad/v0`; no `baseUrl` at all. | No key: a `TypeError` at `createClient` that names the environment variable as the likely cause. No scheme: refused as not an address. No address: the client builds, and the first call fails naming both addresses. Record the other two. | sdk | DX, Door | P1 |
| D-15 | Call with a key from the other channel (any string beginning `csk_live_` on the test channel, since the prefix alone is read first), with a revoked key, and with a random string. | `AgentifyError` with code `not_authorised`, `retryable: false` and the call's name. The other channel's key gets a sentence naming the site where it works; the others get the plain refusal. | sdk contract | DX, Door | P0 |
| D-16 | Misuse the subscription: `on('orders', …)`; `on('order', …)` twice; `start()` with nothing registered; `start()` twice. | Each is refused at the line that is wrong, with the right spelling named. | sdk | DX | P2 |
| D-17 | Return from a handler: nothing; a plain object instead of `order.delivered(…)`; a delivery with a field the card does not declare; a refusal with no message. | Record for each what reaches the problem handler and how the order ends. An answer silently taken as a refusal, or silently dropped, is a finding. | sdk record | Door, DX | P1 |
| D-18 | Close orders wrongly: `refuse` on a synchronous order; `deliver` on an identifier that does not exist; a shipment on an order that is not a parcel. | `not_applicable_in_mode`; `no_such_order`; a refusal that the goods do not fit. Returned as `ok: false`, not thrown. | orders contract | Door, DX | P1 |
| D-19 | With merchant B's key, read and deliver against merchant A's order identifier. | `no_such_order` for both, with nothing in the answer that says the order exists. B's dashboard never shows A's orders. | rule contract | Door | P0 |
| D-20 | Start the handler, then revoke its key in the dashboard while the subscription runs. | Record what the process says, where, and whether it stays up. The pit-of-success reading: the merchant learns at once, in words, that their process has stopped selling; a process that stays up and quietly takes no orders, or keeps promising to ask again with a key that can never work, is a finding. | quickstart sdk | Door, DX | P1 |
| D-21 | Optional: install the oldest SDK on npm and start a handler against the test channel. | Record what happens. Where the two sides do not speak the same contract version, the subscription stops, the process stays up, and only the problem handler says so. Record how a merchant would ever find out. | quickstart sdk | Door, DX | P2 |
| D-22 | On the local stack, rotate the key without stopping sales: issue a second key, start a second ledger handler process with it, sell once while both run, revoke the first key while its process runs, sell again. | No sale is lost. While both processes run, orders are divided between them, as the orders page says for several instances; after the revocation the first process says in words that it has stopped selling (D-20) and the second takes every order. Record whether the dashboard says which key took which order, and whether the merchant could tell the rotation was complete. | orders rule screen | Door, DX | P1 |

Explore: anything the documentation calls "designed, not built", tried as if it
existed. The rule for each: refused with words, or not offered at all.

## Block E. The dashboard day to day

Set-up: the test channel, the main alias, the edge alias for anything that
spends links, a second alias, two browser profiles. The cases that need volume
run on the local stack. Start E-05 early: it waits an hour.

| ID | Do | What should happen | Source | Angle | P |
| --- | --- | --- | --- | --- | --- |
| E-01 | With the edge alias, request a link, then another within the same minute. Then, a minute apart each time, three more. | The second request sends nothing — "No new link was sent", with a countdown on "Send another link" — and does not count against the hour. The third and fourth requests send links, and the fourth's note says it was the last of the hour's three. The fifth: "Try again later", with the minutes to wait. | screen | UX | P2 |
| E-02 | On the link-sent screen, press Back; then "Use a different address". | Record whether the address typed is kept, and whether the person can tell how to get another link. | screen record | UX | P2 |
| E-03 | Request two links before using either. Open the first link's page, reload it, go Back and Forward, then press its button in another browser. Press the second link's button in the first browser. | Opening, reloading and navigating spend nothing; each link signs in once; both sessions belong to the same merchant. | screen | UX, State | P1 |
| E-04 | Press a used link's button in a browser with no session, and in a signed-in one. | Without a session: "That link no longer works", that nothing is lost, and "Ask for another link". Signed in: the person's start page, and nothing about the link. | screen | UX | P2 |
| E-05 | Request a link and press it after more than an hour. | "That link no longer works", as in E-04. | screen | UX | P2 |
| E-06 | Signed out, open `/dashboard/orders`; sign in from the page you land on. Repeat for receipts, keys, settings and integrations. Then open `/dashboard/cards` and an address that does not exist. Then an old bookmark, `/cabinet/orders?open=true`. | Each of the five lands on its own section after the link. Cards and unknown addresses land on Cards. The old bookmark redirects to `/dashboard/orders?open=true`. | screen | UX | P2 |
| E-07 | Sign in from two browsers. Sign out in one. Then "Sign out every other device" from a third session. | Signing out ends that browser's session only. The notice counts the other sessions correctly. The signed-out browser's next action lands on sign-in with "Your session ended…". | screen | UX, State | P1 |
| E-08 | Open Settings in one tab, sign out in another, then save in the first. | The sign-in page says the change was not saved; after signing back in, nothing changed. | screen | UX, State | P1 |
| E-09 | Open Settings as the main alias. In another tab sign out and sign in as the second alias. Save in the first tab. | "Nothing was changed", naming the address now signed in. Neither account changed. | screen rule | UX, State | P0 |
| E-10 | A new merchant chooses "Not decided yet? Leave it for now". Visit every tab. | Cards, Orders and Receipts show the callout to choose a seller name; every empty list says what it is waiting for, and empty Cards offers the way to the SDK. | screen | UX | P2 |
| E-11 | Seller name: empty; 32 characters; 33; a name in Cyrillic or with accents; an emoji; `<b>`; `Tea & Co`; `&amp;`. Then change a valid name and read the catalogue and an old order's status. | Empty refused with the way to stop selling named instead; 33, non-ASCII, emoji, markup and references refused; `Tea & Co` saved. The new name appears on every card and on existing order statuses at once. Record whether a merchant who writes in another alphabet understands why their name was refused. | screen contract | UX, Door, Claim | P1 |
| E-12 | Site: `http://…`; with a path; with a query; with a port; an IP address; a single word; with a trailing slash; in capitals. Then empty the field. | The first six refused with the rule; record the last two. Emptying is refused: a site can be changed, never removed. | screen | UX, Door | P2 |
| E-13 | Wallet: empty; 39 hexadecimal characters; a non-hexadecimal character; a valid address with one letter's case changed; the same address all in lower case; the zero address. | Empty, short and non-hexadecimal refused with the shape explained; the case change refused as a checksum error, with the refused address shown back in groups of four. Record the last two. On the test channel a saved change applies at once and sends nothing; `GET /v0/payout-wallet` with the key shows the address and `pending: null`. | screen contract | UX, Door, Claim | P0 |
| E-14 | Keys: an empty name; 101 characters; two lines. Issue one, make an SDK call, revoke it in two steps, call again. | The first three issue nothing and say so. "Last call" updates after the call. After revoking, the key stays listed as revoked and the SDK gets `not_authorised`; the browser session is untouched. | screen sdk | UX, Door | P0 |
| E-15 | Cards: read every column for a synchronous, an asynchronous and a paused card; pause and resume one; "Pause all sales" and back. | Delivery reads immediate, later or by parcel; the counts in the pills follow; with all sales paused each card says so. Record whether "Product code" and the buying address under each title mean anything to the owner. | screen | UX, Extra | P2 |
| E-16 | Orders: switch between Open and All; read a delivered, a refused, a refund-due and an expired order. | Each carries its status words, the test tag and the sale price; a refund-due order has its callout. There is no order page: record whether a merchant can answer "what did this buyer get, and when" from the dashboard alone. | screen | UX, Claim | P1 |
| E-17 | Receipts: read them after Block C. | One receipt per delivered or shipped order, none for any other ending. Times are UTC: record whether that is said. Record what "Price as of" tells a merchant. | money screen | UX, Claim | P1 |
| E-18 | On the local stack, publish fifty cards from your own merchant and, with your handler running, buy one of them two hundred times (`pnpm buy <catalogue id>` in a loop; `pnpm buy` can fill only `email` and `area_code` parameters, so that card asks for nothing else). Open Cards, Orders and Receipts. | Record load time, whether anything pages, and whether one order can be found. | record | Claim, UX | P1 |
| E-19 | Integrations: follow both SDK links. | "Open the connection guide" opens the quickstart; "Create an API key" opens issuance. | screen | UX | P2 |
| E-20 | Open an address that does not exist under the dashboard; cause a generic error if one can be caused. | "There is no such page" with a way back. Record where "Try again" takes the person and whether they lose their place. | screen | UX | P2 |
| E-21 | Every screen at 375 pixels wide. | The menu opens; every table can be read; a key can be copied on a phone. | screen | UX | P2 |
| E-22 | Keyboard only: sign in, issue a key, copy it, revoke it, pause a card. A screen reader on the sign-in form and the key page. | Every control reachable, focus visible, every field announced by its label. | screen | UX | P2 |
| E-23 | Read every message the dashboard sent during the run, on a desktop mail client and on a phone. | The words in each message match the screen it sends the person to. For each message, the same records as in A-03: where it landed, how long it took, and who it appears to come from; a message in a spam folder is a finding whatever its words say. | screen | UX, Claim | P2 |
| E-24 | On the local stack, a card with a price check under the ledger handler. From fifty shells at once (`xargs -P 50` will do), send two hundred unpaid `POST …/purchase` requests that carry a purchase document and never pay; one request after another would put no more than one question ahead of anybody. While they run, make one real synchronous purchase of the same card. Then read Orders as the owner, Open and All. | Every unpaid request opens an order and asks the merchant's handler for a price, and the handler is asked one question at a time. Record how long the real purchase's price question waited and whether it was answered inside the five seconds or counted as silence. Record what the owner reads on Orders: whether the two hundred appear, with what words while the price holds and after it lapses, whether they are told apart from sales, and whether the counts in the pills include them. An owner who cannot tell "nobody paid" from "I failed to deliver" is a finding of the Claim angle. | cards orders screen record | Claim, UX, State | P1 |
| E-25 | As the owner, take a product off sale for good — not a pause, but gone. | The cards page says how a card is updated and taken off sale. Record what the owner did, what remains visible to agents and in the dashboard, and whether the pages promised anything the dashboard does not offer. | cards faq screen | UX, Door | P2 |

Explore: two people on one merchant changing settings at the same time; the
browser's Back button after every form.

## Block K. The morning after

Set-up: the test channel and the newcomer's merchant from Block A, with the
ledger handler running under the newcomer's key in place of the Block A
handler, so that the receipts are the real 0.01 purchases and the records are
the ledger's. On the evening before this block the operator buys the newcomer's
asynchronous card twice: once with the ledger in its accept mode and nothing
delivered afterwards, once accepted and then delivered with `deliver <order
id>`. Then, within a minute of the purchases and long before the card's
delivery deadline, the handler is stopped for the night with `SIGTERM`, so that
the deadline passes with nobody listening. In the morning the tester is the
merchant and uses only the dashboard, the SDK and the public pages, and
does whatever those tell them to do — including writing to us, if that is what
they say: the operator receives such a message and answers it as they would a
stranger's, and the message, the wait and the answer go into the report as a
stop. No SQL, no logs of ours, no other question to the team.

| ID | Do | What should happen | Source | Angle | P |
| --- | --- | --- | --- | --- | --- |
| K-01 | Open the dashboard. Find every order that was paid and not fulfilled, how much each is for, who owes what to whom, and what the next step is. Then start the ledger handler and read what it received on its first polls. | Orders, filtered to Open, shows the order that owes a refund with its callout, the amount and the test tag; the callout says the merchant returns the money from their own wallet and that a late delivery still clears the debt. The money page says each such order is dealt with by hand during the pilot and that we tell the merchant about each one separately: record whether anything the merchant can see says how we tell them and how they reach us, and whether the dashboard's words and the page's agree about the next step. The refund event, which fell due in the night, arrives once on the handler's first poll and is logged among the arrivals. | screen money orders | UX, Claim, State | P0 |
| K-02 | Decide to return the money. Find, from everything the merchant can read, the buyer's wallet and the amount to send. | The amount is on the order. Nothing the merchant can read names the buyer's wallet: the order and the receipt carry no payer, the callout names no address, and the money page says how the money travels back is not decided. Record what the merchant would do next, and how long they searched before concluding there is nothing to find. This is a documented gap and still a finding, weighed by what it costs a merchant who owes a refund this morning. | money screen contract | UX, Claim | P0 |
| K-03 | Deliver the undelivered order instead, from its line in the ledger, with `deliver <order id>`. | The debt is closed with the goods; the agent reads `delivered` and the goods at the same address; one receipt appears now, its paid time that of last evening's purchase, since the money moved then; the Open list no longer shows it; one action in the ledger for the order. | orders money | State | P0 |
| K-04 | After K-03, reconcile: on a Base Sepolia block explorer, list the transfers into the payout wallet, and match them against Receipts. | Every receipt has a transfer and every transfer a receipt, now that nothing paid is left undelivered. Receipts carry no transaction identifier, so the matching goes by amount and time: record whether two receipts of 0.01 within a minute of each other can be told apart, and what a merchant's accountant would need that is not there. | money record | Claim | P0 |

Explore: the dashboard left open overnight and used in the morning; the
handler restarted ten times in a row during the night by a supervisor, and
what the ledger and the gateway show for it.

## Block F. Parcels

Set-up: an SDK release that carries parcels, and the ledger handler with its
price handler registered beside the order handler, under a merchant with a
seller name and a site. Neither the stand nor `pnpm buy` can send an address,
so on the local stack every step runs with `curl`, the paid ones with Block B's
hand-written payment and `ship_to` in the body beside `params`. On the test
channel a paid parcel needs a buyer that signs for real and sends `ship_to`;
ask the operator whether theirs can, and if not, run the paid rows on the local
stack only and say so. Parcels are not sold on the live channel.

| ID | Do | What should happen | Source | Angle | P |
| --- | --- | --- | --- | --- | --- |
| F-01 | Publish a parcel card (`fulfillment: 'ship'`, `ship_within_seconds`, `price_check: 'handler'`, no `result`) before giving the site, then after. | First refused with `no_seller_site`, naming where to set it; then published. The catalogue shows the shipping time. The card's price excludes shipping: record whether the agent can tell that from the card. | cards contract | Door, AX, Claim | P1 |
| F-02 | Parcel cards with a `result`, with `fulfill_deadline_seconds`, with `ship_within_seconds` over thirty days, and without a price check. | Each refused with its reason. | cards | Door | P2 |
| F-03 | Unpaid purchase without `ship_to`; with `ship_to` missing the phone; with country `us`; with state `US-CA`; then a valid one. Log the question the price handler receives. | The first four are refused before any money: the missing block with 422 `ship_to_does_not_fit`, the others naming the field at fault (record their status and code). For the valid one, the price handler receives the country, state, city and postal code and nothing that names the person; the challenge names the price the handler answered. | contract cards | AX, Door, Claim | P1 |
| F-04 | The price handler answers "unavailable" for that place. | The purchase does not happen, nothing is charged, and the agent is told so. | failures | State, AX | P1 |
| F-05 | Paid: the order reaches the handler; the handler stores the address and answers `accepted`. Read the order back. | The handler received the whole address once. After the acceptance the order reads only `ship_to: { erased_at }`, and a repeat of the order never carries the address again. | contract rule | State, Claim | P0 |
| F-06 | Record the shipment with `deliver({ carrier, tracking_number: null })`. | The agent reads `shipped` with the shipment and the instant it had to ship by, and no goods. The receipt's outcome is shipped; Orders shows shipped. | orders contract | State, AX | P0 |
| F-07 | Send the same shipment again, then a different one. | The same one succeeds; the different one is refused with `shipment_already_recorded`. | contract | State | P1 |
| F-08 | Shipments with a `tracking_url` over `http`, or on an IP address; a carrier with markup; an empty tracking number. | Each refused, saying why; `null` is the way to say there is none. | contract | Door | P2 |
| F-09 | Let a paid parcel pass its shipping time unshipped; then ship it. | `refund_due` at the time limit, with the address erased; the late shipment closes the debt and the order reads `shipped`. | orders contract | State | P0 |
| F-10 | Pay with an address different from the one priced. | 409 `ship_to_changed` before the payment is checked, telling the agent to start a new purchase; nothing charged. | contract | State, AX | P0 |
| F-11 | As a merchant who does not write code, try to see a parcel's address and record its shipment in the dashboard. | Neither is in the dashboard today. Record what such a merchant would do, and whether anything told them before they published. | screen record | UX, Extra | P2 |
| F-12 | After F-05 and F-09, look for the address anywhere the merchant or the agent can read: the dashboard, the order, the status, the receipt. | Nowhere. The agent's status never carried it. | rule contract | Claim | P0 |

## Block G. Rules that exist only where money is real

These rules apply only on the live channel, and the local stack cannot pretend
to be live. The block runs only on the product owner's word, with an alias the
operator owns, and never includes a purchase. It leaves a real account on the
live channel: the cleanup command that exists for the test channel refuses
there. The product owner decides what happens to the account afterwards. Rows
the product owner does not allow are not measured, and the report says so.

| ID | Do | What should happen | Source | Angle | P |
| --- | --- | --- | --- | --- | --- |
| G-01 | Sign in on `https://agentify.ad/dashboard`. | No test banner. Record whether the person can tell before acting that the money here is real, and where the screens say so. | screen | UX, Claim | P1 |
| G-02 | Save the first wallet. | It applies at once, and every account of the merchant receives "A payout wallet was set for your merchant". | quickstart screen | State, Claim | P0 |
| G-03 | Change the wallet. | Every account receives "Your payout wallet is set to change" first; Settings shows "Waiting to replace it" with the moment it takes effect, forty-eight hours later, and "Cancel this change"; `GET /v0/payout-wallet` shows `pending` with `takes_effect_at`. | quickstart contract | State, Claim | P0 |
| G-04 | Sign in on a second device, then cancel the change on the first. | "A payout wallet change was cancelled" to every account; the second device is signed out. | screen | State, UX | P0 |
| G-05 | Issue a live key; call the live channel with a test key. | The key begins `csk_live_`; every account receives "A new key was issued for your merchant" (record whether the message and the button use the same word for revoking). The test key is refused with a sentence naming the test site. | screen contract | Claim, Door | P1 |
| G-06 | Publish a valid card before the operator's approval. | Refused with `no_operator_approval` among any other missing settings. Record what the dashboard tells the merchant about approval and what they would do next. | contract screen | Door, UX | P1 |
| G-07 | Publish a parcel card. | Refused with `not_sold_yet`. | contract | Door | P1 |

## Block H. The WooCommerce connector

The connector is an experiment and not part of the SDK path; this block checks
that it says so honestly, fails with words, and that its newest part — a
physical product sold as a parcel — keeps the parcel's promises. It needs a
WooCommerce shop the operator controls, with shipping zones set up. A finding
here, whatever its severity, decides whether the connector stays offered; it
does not decide the SDK path's verdict, except H-12, which is about an SDK
card's order and whose findings are weighed inside the verdict.

| ID | Do | What should happen | Source | Angle | P |
| --- | --- | --- | --- | --- | --- |
| H-01 | Read the Integrations tab as an owner. | The connector is marked experimental; record whether the owner understands what that means for them. | screen | UX, Claim | P3 |
| H-02 | Connect with an `http` address, an address that is not a shop, and one that does not answer. | Each refused with words that fit the address given; the first asks for the public https address of the shop. | screen | Door, UX | P3 |
| H-03 | Connect the operator's shop and approve the connection there. | Back on "Back from your shop", "Continue to your dashboard" leads to Integrations showing the shop connected. | screen | UX | P3 |
| H-04 | Import before the seller settings are complete; then after. | First: "Nothing was imported", naming what to set and where in the dashboard. Then a page "What came over from …" with Published, Refused, No verdict, Not attempted and Left in the shop, each refused product saying why. Record every word an owner would not know. | screen | UX, Extra | P3 |
| H-05 | Buy an imported product while the shop is unreachable. | The words say the shop did not answer, not that the product stopped selling, and the agent can tell it may try later. | screen contract | Claim | P3 |
| H-06 | "Forget this shop". | Record what remains, in the dashboard and in the shop. | screen record | UX, Claim | P3 |
| H-07 | Compare where the connector's screens appear with the text saying it works in test mode only. | Record any channel where the screens are offered against what the text says. | screen | Claim | P3 |
| H-08 | In the operator's shop, a physical simple product with shipping zones. Import it. | It comes over as a parcel's card, with seven days to ship, and the import screen says that number is a stand-in. Without the shop's site in Settings it is refused, naming where to set it. | screen | UX, Door, Claim | P3 |
| H-09 | Ask its price, as an agent, for places in different shipping zones (by country, by state, by postal code), and for a place the shop does not ship to. | The price is the product plus the shop's cheapest shipping rate for that place, pickup left out; a place with no rate is refused before any money. Record a state the shop writes its own way, such as Berlin, which WooCommerce spells `DE-BE`. | screen record | AX, State | P3 |
| H-10 | The operator buys it once on the test channel (the shop's price, in test USDC). | A paid order appears in the shop carrying the buyer's address and the shipping line, and only then is the order taken on. Agentify keeps no copy of the address. | rule screen | State, Claim | P3 |
| H-11 | Mark the shop's order Completed, with and without a carrier and tracking number. | Within about five minutes the agent reads `shipped`, with the carrier and tracking number where the shop had them, or the shipping method's name and no number. | screen contract | State, AX | P3 |
| H-12 | One merchant, two ways of selling: on the newcomer's merchant, with the ledger handler running with its key as in Block K, connect the operator's shop and import one product, and publish one SDK card beside it. Buy the imported product and the SDK card, each once; ask each its price. | Each order and each price question reaches the party that sells that product, and no paid order owes a refund because the wrong process answered it. Record which process received what, what each buyer read, and what the dashboard says to a merchant who connected a shop and then wrote a card. | rule record | State, Door, Claim | P1 |

## Block I. The scanner, and the way into the dashboard

The scanner is the front page and a way in for some merchants. The plan checks
the way in carefully and the scanner itself lightly. Use a real public shop's
address, such as the tester's own or a well-known online store.

| ID | Do | What should happen | Source | Angle | P |
| --- | --- | --- | --- | --- | --- |
| I-01 | Scan a real shop. | Progress through named phases and eighteen checks — the page says it usually takes under 60 seconds — ending in a short report and an offer of the full one. | screen | UX | P3 |
| I-02 | Enter what is refused: nothing; `ftp://`; a user name and password; `localhost`; port 8080; a `?token=` query; `127.0.0.1`. Then a single word with no domain. | The first six refused with their own sentences. Record what happens with the raw IP address and with the single word, and whether "Retry scan" is offered for something that can never succeed. | screen record | Door, UX | P3 |
| I-03 | Scan a site whose robots.txt keeps `agentify-scanner` out, and one behind a bot challenge. | The first says the robots file kept the scanner out and how to allow it; the second says no reliable diagnostic was produced, without pretending to a verdict. | screen | Claim | P3 |
| I-04 | Ask for the full report. | Record whether the offer and the form agree on what is optional, and whether the data-notice checkbox links to a notice. The link leads to the page with one button, then to the full report; the same link pressed again no longer works. | screen | UX, Claim | P3 |
| I-05 | From the full report, press "Open your dashboard". | The same session continues with no second message. "Open a seller dashboard" appears, and nothing is created until its button is pressed. | screen | UX, State | P3 |
| I-06 | Later, sign in with a link that names no section: once as a person with a merchant, once as one without. | With a merchant: the dashboard. Without one: the latest report. | screen | UX | P3 |
| I-07 | Choose "Essential only" in the consent banner and watch the browser's network panel; then allow analytics. Read the privacy notice beside it. | With essential only, the browser sends nothing to the analytics service. Record what the site records about the visit on its own side either way, and anything sent to the analytics service from the server, against what the banner and the notice promise. | screen | Claim | P3 |
| I-08 | The data-request and unsubscribe pages: load as one address, sign in as another in a second tab, press. | A sentence naming the address signed in now and saying nothing was changed, with a way to reload the page as that address. | screen | UX, State | P3 |
| I-09 | Open `/sell` on the test channel, and on the live one. | Record what a merchant reads on the test channel, including any unfinished pricing notes. The live channel does not serve it. | screen record | UX, Claim | P3 |

## What is already suspected

Reading the code and the pages, and the run that preceded this version of the
plan, turned up the candidates below. None of them is a finding until a run
confirms it: the tester confirms or refutes each one in
the case named beside it, and both outcomes go into the report. A candidate
refuted is as useful as one confirmed, because it stops the team from fixing
what is not broken. The organiser strikes from this list, before the run,
whatever a merged change has already settled, and names the rows that confirm
the fix.

1. An agent given only the site's address cannot find the catalogue: nothing at
   the usual discovery addresses points to it (B-01).
2. In the documents an agent reads, the local sandbox cannot be told apart from
   the test channel; only the local dashboard's banner and the stack's log say
   nothing settles (Block B).
3. The live dashboard shows no banner; only the wallet section of Settings says
   the money there is real (G-01).
4. A merchant cannot see whether the operator has approved them, or how to ask
   (G-06).
5. The dashboard has no page for one order, shows no parcel address and cannot
   record a shipment, so a parcel sold through the SDK can be fulfilled only
   from code; a WooCommerce merchant marks the order Completed in their own shop
   instead (E-16, F-11, H-11).
6. Refusals passed from the gateway to the dashboard begin with a lower-case
   letter, and "Try again" on the error page always leads to Cards (E-20).
7. Messages call things by other names than the screens do: a "wallet screen"
   where Settings has a section, "disable" where the button says "Revoke"
   (E-23, G-05).
8. The card check does not exit 0 on a complete card, which a build script
   reads as failure (A-10, D-13).
9. The first test sale needs an operator, and there is no public way to ask for
   one (A-11).
10. The documentation says a payment at a stale price is answered with a fresh
    price; the code may refuse the payment with no fresh challenge (C-16).
11. The dashboard and the agent's vocabulary have a word for a refund paid back,
    but nothing can record a refund, so no order can reach it (Block C).
12. `eta_seconds` is accepted and kept nowhere (D-10).
13. A price below the live channel's unmeasured minimum is accepted at
    publication and may be refused when a buyer pays (D-05).
14. The catalogue and the dashboard's lists have no paging (E-18).
15. The seller's name and site are shown as they are now rather than as they
    were at the sale, and nothing in the agent's document itself says nobody
    checked them (B-02, E-11).
16. The documentation's front page says the pilot takes only goods that survive
    being delivered twice, while parcels, which do not, are on sale on the test
    channel (A-02).
17. The WooCommerce screens say the connector works in test mode only, while
    they are offered on every channel (H-07).
18. In the scanner: a raw IP address passes the browser's check, is refused by
    the server, and is then offered "Retry scan"; a site behind a bot challenge
    gets a verdict rather than "we were kept out"; the full-report offer and
    its form disagree on the phone number; the data-notice checkbox links to no
    notice (I-02, I-03, I-04).
19. `/sell` on the test channel shows pricing variants that were never approved,
    with their working notes (I-09).
20. The pages tell the newcomer nothing about where the handler has to run or
    that it has to stay up (A-15).
21. Every unpaid purchase request that carries a document opens an order, and
    the dashboard's All list shows those orders beside sales, as in progress
    and then as closed on time limit (B-04, E-24).
22. A merchant who owes a refund cannot find the buyer's wallet anywhere they
    can read (K-02).
23. While nothing polls for a merchant, an asynchronous purchase is charged and
    held for the card's whole deadline — a day by default — before it becomes a
    refund owed; and when the handler returns, that order is handed to it with
    nothing to say it is a debt rather than a sale (J-05).
24. By the code, a poll left parked by a stopped process draws the next message
    that falls due within what remains of its twenty-five-second window, so a
    deploy can lose an event or spend a delivery attempt that no process saw,
    while the SDK's description of `stop()` says a parked poll's contents are
    redelivered (C-27, J-04).
25. A payment that fails its check leaves the order open until the price
    lapses, so the agent later reads "closed on time limit" where the contract's
    words for a failed payment are "refused" (B-19).
26. By the code, a payment just past the price's thirty seconds, before the
    timer has closed the order, is charged at a price that has lapsed (C-16).
27. By the code, an agent waiting on a synchronous purchase may read
    `in_progress` at the tenth second, after the window the pages promise has
    closed (C-03).
28. By the code, a synchronous refusal that arrives after the deadline, before
    the timer has fired, closes the order as the merchant's refusal rather than
    on its time limit (C-34).
29. A handler that throws once inside the synchronous window can lose the sale
    although four seconds remain for the repeat, when the repeat waits on a
    timer rather than on the clock (C-08).
30. A worker whose key was revoked keeps promising to ask again (D-20).
31. Two hundred unpaid requests against a card with a price check put two
    hundred questions in front of the merchant's one serial handler, and nothing
    limits them (E-24).
32. Where an order ended by our decision rather than the merchant's — a payment
    that did not pass, a shop that did not answer, a price that lapsed, a window
    that closed — the agent reads the ending and not the reason, and cannot
    tell "try later" from "go elsewhere" (B-19, C-16, H-05).
33. By the code, a merchant has one stream of orders and every subscribed
    process draws from it, so a connected shop's worker and the merchant's own
    handler compete for every order and every price question; the connector
    refuses an order for a product that is not from its shop, and a paid
    asynchronous order it refuses becomes a refund owed (H-12).

## The core: rows run after every release

A release to the test channel is followed by this subset, run warm — with the
repository open, the ledger handler and the stand already in place, and the
team's knowledge allowed, as opposed to the cold read of Block A. It holds what
the automated suite cannot see: real mail, real settlement and a real refusal
of a payment, the npm package against the test channel, the dashboard read by a
person, and processes dying or losing each other. The rest of the plan is run
before the first merchant we do not control and whenever a block's promises
changed. Before the core, `pnpm outside` passes: that command packs the two
packages as npm would publish them, installs them into a directory with no path
back to the checkout, and runs the quickstart's two commands there.

- The recipe as printed still sells: A-03 for the mail, then A-08, A-12 and
  A-13 on the test channel with the SDK installed from npm.
- The agent's money: B-13, B-19.
- Processes meeting: C-10, C-27, C-28.
- Between the steps: J-01, J-02, J-04, J-05.
- The dashboard by a person: E-07, E-09, E-13, E-14, and E-16 on the local
  stack once C-02, C-03 and C-18 have run.
- The morning after: K-01 to K-04.
- Parcels, while they sell on the test channel: F-05, F-06.

A row that fails twice in manual runs for the same reason is named to the team
in the report as a candidate for the automated suite, with the promise it
guards; the manual run keeps what needs a person.

## What this plan does not cover

Load beyond the volume in E-18 and E-24, and security testing beyond the
isolation and session cases, are separate work. The payment network's own
failures — a charge that fails after the goods were made, or that never reports
back — cannot be caused by hand and are covered by the automated suite; a
buyer's signature with chosen fields, an authorization that has run out and a
payment for less than the challenge asked are refused by the payment layer
rather than by us, and need a buyer that signs what it is told, which the
repository does not provide. Whether an external catalogue lists a product is
measured by its own command and is not a property of a sale. The one-day
deadline that an asynchronous card without a deadline of its own is held to is
not watched by hand; the automated suite holds it. The run uses one desktop
browser and one phone; a matrix of browsers is not in scope. Mail is read in
one client on each; how corporate mail systems rewrite or scan sign-in links is
not measured.

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
**Excluded**: the product owner took the row out of this run, and the report
quotes their word. **Not run**: there was no time, and the report says so
rather than leaving the row empty. A row whose expectation says "record" passes
when the tester recorded what happened, unless the row also states an outcome
as a rule and that outcome did not hold; what they recorded may still produce a
finding.

Every finding gets one severity, judged by what it does to a stranger rather
than by how hard it is to fix.

| Severity | What it means here |
| --- | --- |
| S1 | Money, goods, identity or an order's state is lost, duplicated, given to the wrong party or misstated to someone who acts on it; a secret is exposed; something accepted at the door fails later where money is involved; the three views of an order disagree; one purchase becomes two orders, or a handler that answers repeats by the order's identifier is led to act twice; an order the merchant closed reads as open or undelivered where no page admits the difference. |
| S2 | A stranger's path is blocked with no way round that they could find alone; a promise in the documentation, on a screen or in an error does not hold; something is accepted and then silently ignored. |
| S3 | Confusion a person recovers from alone: a word only the team understands, a step or an entity the goal did not need, an error that is true but does not say what to do. |
| S4 | Cosmetics that do not change meaning: spelling, alignment, spacing. |

A gap the documentation already admits — a wallet nobody names, a field nothing
keeps — is still recorded as a finding, marked "documented", and weighed on the
same scale: what it costs a stranger does not shrink because we wrote it down.
A behaviour a page describes as by design — an order arriving twice, late goods
held for a repeat — is not a finding on its own; it becomes one where the page
and the product disagree, or where what the page says costs a stranger money or
goods.

The verdict is about the SDK path, and it follows from what is left open there
and from what was measured. Not ready: any S1 is open on the SDK path. Ready
once the named findings are fixed: no S1 is open, and the report names what
stands between the run and ready — the S2 findings to fix first, a P0 row that
was blocked, partial or not run together with the smallest thing that would run
it, or a newcomer who was not a person outside the team. Ready: nothing above
S3 is open, every P0 row passed, failed or was excluded by the product owner,
and Block A was walked by a person outside the team. S3 and S4 findings never
hold back the verdict; they go to the team as they are. A finding of any
severity in Blocks H and I decides whether that surface stays offered and in
what words, and goes to the team beside the verdict rather than inside it —
except a finding from H-12, which concerns an SDK card's order and is weighed
inside the verdict; H-12 not run for want of a shop holds nothing back.

When several findings compete for the same fix, the order is: a blocked path
first, then a misleading promise, then an unsafe ambiguity, then a confusion
the person recovers from.

The report follows this outline:

```markdown
# Manual test run, <the day it started>

## What was tested
- Test channel commit (the deploy-test tag): <sha>
- SDK and contracts installed from npm: <versions>
- Live channel release, and whether npm's SDK is newer: <release>
- Local stack commit: <sha>
- Changes merged since the previous run, each with the rows that check it
- Tester; who played the newcomer (a person outside the team, a member of the
  team, or a language model); browser and phone; start and end, UTC
- Blocks run; rows the product owner excluded, with their word; the product
  owner's word for Block G if it ran

## Verdict
One paragraph: ready for the first merchant we do not control, ready once the
named findings are fixed, or not ready — the findings that decide it, and
which of the four questions this run could not measure and what would.

## Cases
| Case | Verdict | Evidence (identifiers, screenshot names) | Findings |
| --- | --- | --- | --- |

## Findings
### Finding 1. <What happens, and where, in one line>
- Severity: S1–S4. Angle: UX, DX, AX, State, Door, Claim or Extra.
- Case: <ID>. Build: <sha>. Happens: always, n of m tries, or once.
- Steps: what was done, in order, so somebody else can repeat it.
- Expected: what should have happened, and the source the row named for it.
- Observed: what happened instead, quoting the words on the screen or in the
  answer exactly.
- Evidence: identifiers, log lines, screenshot names — no secrets.

## Suspected already: confirmed or refuted
One line per candidate from the plan, with the case that settled it.

## The ledger
For every row that read the ledger handler: arrivals and actions per order,
and where the two differ, why.

## The buyer's story
B-18: the orders opened, the payments made, the prices named, the decisions
the model took and the words of ours behind each.

## The morning after
What the merchant could find, close and reconcile with the dashboard, the SDK
and the pages alone, and where they had to stop.

## Words that stopped me
| Where | Word or element | What I took it to mean | What it means | Did my goal need it? |
| --- | --- | --- | --- | --- |

## The newcomer's numbers
- Who played the newcomer, and whether the numbers below measure a stranger.
- From the front page to the first card published, and from there to the
  first test sale.
- Every stop: where, how long, and what got me moving again.
- Every question I had to ask a person, and why the pages did not answer it.
- The ideas I had to learn before the first sale.

## Not run, and why
```
