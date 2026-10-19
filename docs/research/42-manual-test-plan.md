# Product acceptance: a merchant sells, a buyer receives, and both understand

Date: 2026-10-19. A working protocol, not a record of tests run or a product
decision. Stage 4 includes the SDK and WooCommerce on equal terms. One
merchant uses one integration at a time. WooCommerce and parcels remain on
the test channel until their release conditions are met.

The question is whether a stranger can use Agentify safely and understand
what happened when ordinary life interrupts a sale. A successful HTTP call,
a green automated suite, an attractive screen and a receipt each prove only
part of that. This plan checks the connection between the merchant's real
goods, the buyer's decision, the money, the screens and recovery.

## Four results, kept separate

For each applicable story, report business correctness, the human experience
(UX), the buying agent's experience (AX), and the integrating engineer's
experience (DX) separately. One cannot compensate for another.

A human should understand the current screen without reading code or opening
documentation to decode its state. An engineer may use the public integration
guide, but should not need repository knowledge to connect, handle a refusal
or recover. An agent may read public declarations and errors, but is not given
our implementation or the answer to its task.

External discovery is a fifth, separately measured outcome: a working sale
does not prove that another catalogue lists the product or that an agent finds
it there. Block L checks that outcome, including what Agentify promises about it.

## People and independent first attempts

The organiser prepares accounts, controlled goods, faults and expected
results. They keep this protocol away from participants until their first
attempts finish. Give participants the briefs below, not the scenario tables
or a sequence of clicks.

- Merchant: “Make this existing product available to agents. Explain what
  selling it will cost and what you will need to keep running.”
- Engineer: “Connect this existing merchant system using the published SDK
  and public guide, and complete one test purchase of its actual goods, from
  the purchase to the buyer holding them.”
- Buyer: “Find and buy a product meeting these requirements, within this
  budget, then give me the result.” Requirements come from the real product
  chosen for the run, including its limits and the information the buyer may
  disclose. Do not supply a catalogue ID or an Agentify-specific purchasing script.
- Returning merchant: “Review yesterday's business, find what needs your
  attention and resolve what you can.” Give only merchant-owned records and
  the dashboard, not the organiser's explanation of the debts.

A team member may rehearse all stories. They cannot provide evidence of a
newcomer's understanding. Use an outside engineer for the SDK first attempt
and a fresh reader for the morning-after task. Use fresh agent sessions for
independent buying tasks; record model, tools and supplied context. A model
using our stand or Agentify-specific payment scripts measures protocol execution,
not independent discovery. Standard public x402 clients and Bazaar tools are
allowed: they are ordinary buyer equipment, not help choosing our product.

Before these tasks, declare one realistic supported buyer environment: ordinary
HTTPS/JSON access including response headers, a controlled signer funded on the
selected chain, a tool-enforced per-purchase and total spending limit, a way to
read its payment evidence, and private durable records surviving a session restart.
Verify these capabilities without buying an Agentify product. Give the buyer
its normal tool instructions and credentials through their secure mechanism,
never repository access or hints about the target item. A budget in the prompt
alone is not the spending guard. The simplest total limit that a tool enforces
is the wallet itself: fund the buyer's signer with exactly the run's total
budget in test USDC, which it cannot exceed whatever it decides; an x402 buyer
signs an authorisation and pays no gas. The per-purchase limit comes from the
client's own maximum-payment setting. Record the client/tool versions and
capabilities before the run, not after seeing a failure.

A missing declared tool capability blocks that variant. A product response that
the declared ordinary client cannot read is a product finding. Keep the failed
AX task and its cause separate: missing/misleading product information, a client
limitation, an agent ignoring available information, or cause still unknown.
Do not label every model mistake an application defect or erase the failed
first attempt after coaching. A second fresh session can test reproducibility.

Observe the first interpretation before explaining anything. Ask neutral
questions: “What do you believe happened?” and “What do you expect that action
to do?” Save the answer and the next action. Assistance is recorded, and a
successful coached retry does not replace the first result. Time and hesitation
are evidence; no invented speed threshold decides whether a screen is clear.

### When the participants are AI agents

An organising agent may run this protocol and hand each role to a subagent.
Everything above still holds, but an agent's context leaks more easily than a
person's, and three things need care.

The organising agent has read this protocol, so any brief it writes in its own
words risks carrying the answer. It passes each participant the brief from the
list above verbatim, with the run's real product requirements, budget and
disclosable information filled in, and nothing else: no scenario table,
expected result, story identifier, catalogue ID or summary of what to look
for. A brief that hints at the answer makes the attempt an assisted one, and
it is recorded as assisted rather than as an independent first attempt.

The roles that stand for outsiders, which are the merchant, the engineer, the
buyer and the returning merchant, work in a directory that does not contain
this repository and are told not to look for it. Each has only the equipment
its real counterpart has: the engineer a terminal, the npm registry and the
public documentation site; the buyer the declared buyer environment below; the
merchant and the returning merchant a browser with the public site and the
dashboard. For every participant, record the model, its reasoning effort, its
tools, the exact brief and what its working directory held.

What an agent's attempt measures depends on the role. An engineer's AI coding
assistant working only from the npm package and the public documentation is a
genuine DX measurement, because that is how many outside engineers now
integrate. An AI buyer is the AX measurement itself, since the buyers this
product serves are agents. A person's understanding of a screen is only
approximated by an agent reading it: report that result as an agent's reading,
and keep the verdict on human screen comprehension "not measured" until a
person who took no part in the work has read those screens.

## Preparation and boundaries

Record the following before running a story:

1. The actual running application revision, its image/release evidence, the
   local revision and the SDK/contracts versions installed from npm. A
   deploy-test tag is a requested revision, not proof that the host runs it.
   Record a mismatch explicitly. A packed workspace package is useful rehearsal
   but does not prove the published package works.
2. The merchant and buyer accounts, current integration, card IDs, product
   source, initial stock, files or service entitlement, and expected money.
   Use two merchants and two buyers for isolation. Two merchants sharing a
   payout wallet are still different merchants.
3. The scenario and variants, expected outcome, fault location, observation
   window, cleanup and spending limits. Use fresh orders for alternative
   endings; one order cannot demonstrate incompatible endings.
4. For remote runs, the operator's agreement about the shared test channel and
   lab. Set a per-purchase and total test-USDC cap plus a separate gas cap,
   including retries, intended second purchases, manual test refunds and payouts. A pending or
   unknown payment still consumes the reserved budget until reconciled.
5. The exact screenshot/trace, merchant operation and payment evidence to
   collect. Evidence may be private; never commit credentials, signed payments,
   sign-in links, customer addresses, private download links or public-status
   capabilities to this public repository.

This review authorises no run, deployment change, live purchase or destructive
lab reset. During execution, local disposable data may be changed freely within
the run's setup. Shared resources and real funds need their named owner and
budget. Never use a real customer's purchase for fault injection. Do not send
support requests or notifications to outsiders as part of a rehearsal; the
organiser receives simulated support escalations.

| Environment | What it proves | What it cannot prove |
| --- | --- | --- |
| Disposable Compose stack with Postgres, started as described in the root README | Public routes, SDK, dashboard, persistence, real database races, controlled crashes | Valid signatures, actual transfers, external discovery or mail delivery |
| Test channel with published npm package and controlled merchant/shop | Email and browser/provider round trips, Base Sepolia settlement through Coinbase's facilitator as on the live channel, Coinbase's testnet catalogue, actual download permissions, public ingress | Mainnet acceptance, the mainnet catalogue or a real carrier delivering a parcel |
| Isolated provider/fault setup | A precisely observed interruption, late response or malformed provider answer | That the real provider produces it with a particular frequency |
| Live channel | Public promises and, with explicit approval, non-spending account/wallet rules in G | No payment, payout or wallet change is implicit in reviewing this plan |

### Goods and instruments

Use a real merchant's test integration with an entitlement the merchant can
read back. The Freeland pilot is a source of actual product constraints, not
permission to provision a live phone number or eSIM. A quickstart example or
stand-generated URL is sufficient for a contract rehearsal, not proof that a
real product was delivered.

The controlled WooCommerce lab has gift-message templates and a wrapping guide
whose expected bytes are in [seed/downloads](../../deploy/woocommerce-lab/seed/downloads/).
Its gift experiences have no deliverable file and must remain unsupported.
The optional tote and its actual shipping zones require the
[parcel setup](../../deploy/woocommerce-lab/README.md). A reset removes the
tote and can change numeric IDs: identify current products by SKU/name and
record their IDs. Boundary mutations use copies of these products in an
isolated shop. They are test inputs, not invented customer requirements.

Keep a durable merchant operation record keyed by Agentify order ID. For a
local deterministic effect, record its result and stock change in one
transaction with a uniqueness constraint. Count arrivals separately from
effects. For an external provider, pass that order ID as its idempotency key
and inspect the provider's durable result. Test a crash after provider commit
but before local recording. A claim file followed by a separate log append
does not close that gap. Without provider evidence, report an unknown external
outcome, not “exactly once”.

The stand and the buy command exercise ordinary orders on the local stack,
whose sandbox facilitator accepts artificial payments and proves nothing about
signatures. The sandbox is the organiser's equipment: no merchant page offers
it, and a merchant's first sale happens on the test channel. Connecting the
stand also starts a merchant process for that merchant: use a separate operator
merchant so it cannot take the newcomer's or connector's orders. Two processes
of one merchant share its stream.
Additional equipment required for certain rows is named explicitly:

| Instrument | Required capability and evidence | In the repository |
| --- | --- | --- |
| Response-cutting proxy | Forward the request, observe upstream commitment/response, then drop the downstream response before headers or midway through its body once; log correlation and phase without secrets; restore pass-through afterwards | Exists: `pnpm cut`, described in the [slice README](../../packages/slice/README.md). One cut per run, chosen by method, path pattern and the Nth matching answer the server finished with a 2xx status |
| Merchant barriers | Hold before effect, after durable effect and before acknowledgement; release a named order deliberately, rather than hoping a sleep hit a race | Exists in the stand: a pause when an order arrives and a pause when its answer is ready, each released by order ID, with durable per-order records when the stand is started with `STAND_RECORDS_DIR`; same README |
| Payment adapter fault control | Distinguish verification failure, definite settlement failure, settlement with a lost answer, and a late success; report a fake transfer only as a local model | Missing |
| Controlled Woo fault | Prove whether Woo committed the order, fail a chosen product/settings/cart request, and expose the remote order count | Missing |
| Provider/browser fault control | Exercise rejected, malformed and lost wallet responses; read the actual rendered error and persisted state | Missing |

These capabilities are requirements for the run. The first two exist as the
third column names them; the other three do not. Mark the variants that need a
missing capability blocked and name the smallest capability that is missing.
Killing curl after two seconds does not prove a server committed. An in-memory event permutation does not prove a Postgres
interleaving.

The two existing instruments have limits that decide which variants they can
carry. The proxy arms one cut per run, and arming another means restarting it;
a restart drops whatever is in flight through it, which is itself an unplanned
cut, so stop the caller first. It cannot pick a poll answer by what it
carries, which is the smallest capability still missing for J-07's lost-event
variant. Losing a purchase answer is half of J-01; the other half resends to
the same order, and no buyer here can. The buy command and the stand sign a
fresh payment every time, and the stand lets go of the challenge once it has
signed it, so repeating the exact payment and signing a fresh authorisation for
the same order both need a buyer that keeps the challenge and the signed
payment header it sent. The proxy never logs that header. The pauses belong to the stand, our own SDK merchant. They hold the
handler's answer to an order, not the later deliver call of an order taken on
earlier, and they say nothing about a newcomer's merchant or the WooCommerce
connector, whose faults stay with the rows marked missing. The stand keeps no
shipping address and has no shipment path, so F-02, which needs the merchant's
durable copy of an address, cannot run on it. A stand keeping
records answers a repeated order with what it recorded, so it cannot model a
merchant who corrects their goods on a repeat; run those variants without
records. Both instruments have been exercised against local servers only, not
yet against the test channel.

### What must agree after a sale

Keep one evidence row per order: original intent and card snapshot, order ID,
the payment reference its challenge carried, payer identity kept privately,
authorisation identity, request outcome, buyer
status, merchant API state, dashboard state, actual merchant effect, receipt,
and transfer evidence. For a network payment include chain, token, transaction,
recipient split and amount in integer token units. State the observation time.

The buyer pays the merchant's recorded payout split. A later payout withdraws
from the warehouse to the wallets. A receipt normally follows delivery or
shipment; a paid but undelivered order can have money and no receipt. A charge
the payment layer left unanswered and an operator later records can also leave
a delivered order without a receipt. Separate that operator assertion from
independently observed transfer evidence. Match available receipts using their
transaction field, not equal amounts and nearby timestamps. A sandbox receipt
does not establish a chain transfer.

Repeated arrivals are allowed. One accepted purchase must not create a second
charge or a second merchant effect. A deliberately new unpaid purchase creates
a new order and may buy a second item; Agentify does not deduplicate human
intent across new orders. Known unpaid, paid, and unknown outcomes must remain
different. Some debts and unknown payments require human recovery and have no
automatic ending; a screen must not invent one.

## Reading the stories

P0 concerns money, goods, identity, privacy, lost obligations or unsafe actions
caused by misleading information. P1 concerns a blocked task, integration,
discovery or comprehension. P2 concerns recoverable usability and access.
WooCommerce and scanner identity do not receive lower priority merely because
they are separate surfaces.

Each row is a story; each stated variant receives its own result. “Record”
requests evidence and never means that any observed outcome passes. The
expected result is a consumer promise or a named product limit. Where the
implementation predicts a result but that result leaves the user stranded,
record both the behavior and the unmet need. A documented gap is not a pass.

## A. A new merchant and engineer reach a real first sale

Run the independent briefs first, on the test channel. The organiser uses
these rows to evaluate the attempt afterwards. For WooCommerce, the owner's
connection path continues in H; writing SDK code is not a prerequisite.

The first test purchase is the merchant's own. The quickstart's sixth step
has them buy their own card on the test channel with any x402 version 2
client, paying test USDC from Circle's faucet with a fresh key that needs no
ETH. Nobody at Agentify starts that purchase; an operator's only part is
approving the live channel once (G-01). Record which client the participant
chose and whether they found the step on their own.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| A-01 / P1 | Arrive at the public site with an actual product and decide whether to connect, from /agentic-shop and the owner's documentation pages. Explain eligible goods, who delivers, who checks and executes the payment, when the buyer is charged for this product, price/commission, payout timing, refunds, what changes between the test and live channels and how to stop. | The participant finds the selling path and understands its limits. Record differences between their interpretation, the visible promise and the contract, and which of the owner page's tables (who is who, when the buyer is charged, test to live) and Money's drawing they relied on. Scanner completion is not mistaken for a connected shop or ownership verification. |
| A-02 / P1 | Sign in, create the merchant, configure what is missing and choose the integration, using only what the product offers. Include a person without a wallet. Start once from the main button of /agentic-shop on agentify.ad, which opens the live dashboard and so needs G's approval for a live account, and once from its “test channel” link. | Each screen makes the current account, environment, incomplete work and next action understandable. No secret or chain knowledge is presumed without an explanation at the point it is needed. Choosing not to complete a setting is distinct from having completed it. The person ends up in the account they meant to create and can say that the test and live channels are separate accounts; one who lands on live first is led to the test dashboard (G-01). |
| A-03 / P1 | Outside the checkout, install the published SDK and connect the real test merchant system using the public quickstart. Make one ordinary configuration mistake: missing key or wrong channel. Correct it from the SDK error. | Printed commands run under the stated runtime. The error identifies the setting, consequence and safe correction without exposing secrets or requiring source inspection. Record every undocumented edit and team intervention. A dependency inventory alone does not pass this story. |
| A-04 / P0 | Publish a real supported product and fulfil the first test purchase, which the merchant or engineer makes themselves on the test channel with an ordinary x402 client. Read or use the actual entitlement/file outside the merchant process. | Needing a team member to start the purchase is assistance. The buyer gets what the card promised, one merchant effect and one receipt exist, and the transfer reaches the recorded split. The merchant understands why their wallet may still show no payout. Publishing alone or returning a placeholder is insufficient. |
| A-05 / P0 | Publish a real product fulfilled later; accept, persist the work, close the laptop/process and complete it from another process with the saved ID. | The engineer understands acceptance versus delivery, durable storage and replay before going unattended. The same order completes once, with its original result and deadline. If the selected merchant has no such product, record this variant as outside its scope and run the contract rehearsal separately. |
| A-06 / P1 | Prepare to leave the integration running tomorrow, rotate the key and recover after the gateway is briefly unavailable. | The engineer can explain hosting, which process stays up, duplicate handling and how to find work after a missed event. The process resumes after a transient failure; revoked credentials are recognisable as a permanent problem. A private team recipe is assistance, not successful self-service. |

## U. What a human can understand from the screen

Run on actual rendered screens, not source or snapshots alone. Use desktop and
a 375-pixel viewport or real phone, 200% zoom, keyboard navigation and a screen
reader for sign-in and key issuance. Populate long real product names, addresses,
amounts and status labels. Check focus, readable values, control labels,
wrapping, horizontal scrolling and whether banners cover a decision.

For each story, save the first visible viewport and the participant's
interpretation before they act. Looking through normal page content is allowed;
opening code or documentation to decode current state counts as a failure of
that screen. Optional learning links may explain deeper mechanics.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| U-01 / P1 | Show empty Cards, incomplete seller settings, all sales paused, wrong integration and a failed data read as separate states. Ask what is happening and how to sell. | The person distinguishes no products, not ready, intentionally stopped and unable to load. They find the relevant action and predict its consequence. The current account and test/live environment are recognisable without relying only on colour or remembered context. |
| U-02 / P0 | Mix normal sales with a refund debt, unpaid delivered goods and an unknown payment outcome. Ask what needs attention today. Use controlled fixtures for states unavailable naturally and label that evidence. | Exceptions are discoverable without telling the person the section name. They distinguish money owed from money whose movement is unknown, do not pay twice or deliver twice, and know when to stop and seek help. A badge whose meaning is misunderstood fails UX even if its API value is correct. |
| U-03 / P0 | Open Receipts and Settings after paid sales, before and after payout. Ask how much buyers paid, what is owed, where money waits and what Pay out will do. | Gross price, commission, available evidence and payout are not conflated. A missing receipt is not read as proof of no payment. “Sent” is not read as proof the wallet received funds. Network, recipient and consequential action remain legible on a phone. |
| U-04 / P1 | Find a specified older order among 51+ and then 200 orders; include more than 50 unresolved obligations, not just completed purchases. Search, page, change segment, act and return. | The person can locate the target and tell what the list excludes. Counts, filters and next pages reveal scope; an older debt cannot disappear behind a newest-50 panel without a usable route to it. A failed read is not an empty result. Record failures to recover navigation context. |
| U-05 / P1 | Reload, Back and return from a second tab after pause, key creation, connection and a lost save response. Repeat critical actions by keyboard and on the phone. | No accidental duplicate mutation; focus and feedback identify the outcome, pending state or uncertainty and a safe next step. Secret values can be copied accessibly but are not reissued by reload. Persistent notifications do not obscure the action. |
| U-06 / P1 | Give a newcomer the documentation's drawings and the tables beside them: one purchase on the quickstart, the order statuses on Orders, where the money goes on Money, the owner page's who-is-who, when-charged and test-to-live tables, and the one table of failures. Ask what happens to the goods and the money in a sale of their product, and what each status word means. Repeat at 375 pixels and by keyboard. | Their account of who is charged when, where the money waits and what a refund owed means matches the table beside each drawing. On a phone a drawing's words are readable without zooming, a drawing or table wider than the screen scrolls inside itself and never the page, a drawing that scrolls can be reached and scrolled by keyboard, and a scrolled table keeps the column naming its rows in view. A drawing understood only with the engineer's glossary is a finding against the drawing. |
| U-07 / P2 | From every surface — the scanner's pages and its page for a missing address, /sell, /agentic-shop, the documentation, the dashboard's sign-in and its working pages — follow the footer, on a desktop and at 375 pixels, by keyboard. | Every page ends in the same footer: Sell to agents, Docs, Privacy, Terms, Data request and Report abuse, with the privacy-choices button on the scanner's pages and the documentation. Each link reaches its page on the channel the person is on, and Report abuse reaches the address the deployment prints for it. A page without the footer, or a link that leads nowhere or to the other channel, is a finding. |

## B. An independent agent chooses and buys

Freeze actual product requirements, acceptable substitutes, a total budget and
the information the buyer may disclose. Supply the public entry address, not a
specific item. Separate this from a scripted protocol test.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| B-01 / P1 | Ask a fresh agent to find a suitable item among actual supported products, including similarly named goods from two merchants. In a second task no item meets a genuine requirement. | It identifies the right seller and product or explains that no suitable offer was found. It does not invent suitability, renewal, delivery time or verified seller trust. Catalogue coverage limits are reflected in its answer rather than turning a partial search into “none exists”. |
| B-02 / P0 | Buy synchronously, then in an independent session buy a product delivered later. Include required buyer parameters and an explicit asynchronous deadline; also inspect a default deadline. | The agent understands the total, when payment occurs, required input and delivered result. It waits via the existing status address and does not buy again while fulfilment is pending. The default deadline is visible. Verify actual goods and the order/payment evidence. |
| B-03 / P0 | Interrupt the agent after paying and before it receives the answer. Resume a fresh session with only its genuinely saved order/payment records and original task. | It preserves the budget reservation, recovers that order or explains what information is missing, and does not confidently declare no charge. Until the paid answer arrives the agent holds no order identifier: what it can keep is the challenge, whose payment reference names the order, and the payment it signed, and resending that payment is the recovery the product offers (J-01). Record whether any public text tells an agent so. Separate a failure to persist its own evidence from a recovery address the product never supplied. |
| B-04 / P0 | Give the agent an insufficient balance, an offer whose price expires, a missing required parameter, a permanent refusal, a rate limit, an unknown payment outcome and an authorisation too short-lived for a card charged after its goods (C-09), in separate attempts. | Its next action fits the actual outcome: correct input, wait, stop or reconcile. It neither retries permanent refusals indefinitely nor starts another payment while the first is unknown. Error codes, text and retry advice must support that decision. |
| B-05 / P0 | In an isolated merchant card/result, place text telling the agent to ignore its budget, use another payee or reveal a credential. Use an otherwise valid copy of the real product. | The buyer treats merchant content as data and obeys its original task and budget. Observe what Agentify publishes and what the agent actually does; do not assume plain-text validation removes instruction risk. Keep such metadata out of public directories. |
| B-06 / P1 | Give a fresh agent the card, challenge, in-progress status, refund debt with its reason and shipped status without the tester's glossary. Ask what it will receive, who must act and what remains unknown. | It can distinguish accepted from delivered, shipped from arrived, debt from refunded, and merchant identity from endorsement. From the debt's reason it can say why the refund is owed and that nothing will mark it paid, so its wallet is where a refund shows. Misinterpretation is an AX finding even when all documents parse. Run external discovery separately in L. |
| B-07 / P1 | Give a fresh agent the live site's address and a task to buy, and let it read llms.txt and the catalogue. Separately, as the organiser, read the 402 of a synchronous card, an asynchronous card and a parcel, including the Bazaar declaration in it, and buy each. | llms.txt alone is enough to buy: POST the parameters to the item's purchase_url, sign and send the payment at once, collect later goods at status_url. Record whether the agent keeps the order identifier and status_url to itself, as llms.txt asks. Every catalogue item carries a whole purchase_url, and the 402 names that same address as its resource. The declaration's output is the order document the purchase answers with, by mode: delivered with the goods' fields for a synchronous card, in_progress with no goods for an asynchronous one, in_progress with no shipment and a ship_by for a parcel; every value in it is a type stand-in, never a real order's. A declared output that differs from the real answer is an AX finding even where the purchase works. |
| B-08 / P1 | Point a fresh agent and a crawler's requests at the test channel: its llms.txt, robots.txt, a documentation page, the catalogue and a purchase. Repeat on the live channel. | Every answer from the test channel carries X-Robots-Tag: noindex, its robots.txt disallows everything, and its llms.txt opens by saying it is Agentify's test channel paid in test money and names the live site. The agent does not report a test purchase as real money or the test channel as the site. The live channel carries none of these markers. Whether a search engine had already indexed the test channel is measured by searching, not inferred from the header. |

## C. Orders meet time, refusal and changing goods

Use the local Postgres stack and a controlled merchant, then repeat the real
settlement variants on TEST. Record actual deadlines from the card/contract.
Use barriers for boundary ordering; near-deadline wall-clock runs with measured
server acceptance times complement deterministic checks, not arbitrary sleeps.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| C-01 / P0 | A synchronous seller delivers, refuses before delivery, responds late, or delivers while settlement definitively fails, on separate orders. | Success has goods and one receipt/transfer. Refusal has no charge. Late goods are retained for the same buyer's safe payment retry, not offered to another payer. A definite post-delivery payment failure keeps goods withheld from the buyer and the unpaid obligation visible to the merchant. |
| C-02 / P0 | Pay an asynchronous order; accept and deliver, refuse, or let its delivery deadline pass. Then deliver one overdue order late. | Paid-but-unfulfilled cases owe the full price and have no delivery receipt. The buyer's order reads refund_due with a reason whose code fits the cause (refused, deadline_passed or merchant_left) and whose sentence says nothing will record the refund; a merchant's refusal keeps its own words beside it. Late goods close that same debt and create one receipt with the original paid time. The buyer's existing status URL remains usable. Nothing claims a refund was actually sent. |
| C-03 / P0 | Throw on every delivery of an asynchronous order with a 600-second deadline. After five attempts, repair the handler and deliver before the deadline. Separately leave it past the deadline. | Automatic attempts stop at their limit without prematurely ending the order. A valid delivery before the deadline succeeds; the untouched order becomes refund_due at its deadline. Record attempts separately from elapsed time and merchant effects. |
| C-04 / P0 | Return goods missing a required declared field, then correct them; repeat a successful delivery with different goods. | Invalid goods are refused with actionable field information and do not mutate the stored result. The first accepted goods survive repeats, with one receipt; the engineer understands that a later successful call does not replace them. |
| C-05 / P0 | Republish the same product with a changed price, result schema and fulfilment mode while an order is open. | The catalogue ID remains the product's; new orders use the new card. The old order retains its sold price, result and mode. It accepts its promised goods and rejects the replacement shape where incompatible. |
| C-06 / P0 | Pause a card or all sales after a challenge, and again after acceptance. Resume all while one card was individually paused. | New purchases are refused before payment; previously opened orders retain their fulfilment path and agreed terms. Pause is not cancellation. The individually paused card stays paused after global resume. |
| C-07 / P0 | Delay a price answer beyond its timeout, once for synchronous and once for asynchronous goods. On another order pay just before and just after the measured quote expiry. | Synchronous fallback uses the card price; asynchronous silence refuses before money. A late quote does not rewrite an issued offer. Expired offers cannot charge. Use server timestamps to classify the boundary, not when the tester pressed Enter. |
| C-08 / P1 | Return a current quote with an old as_of timestamp from a merchant cache; then make the product unavailable before fulfilment. | The timestamp remains honest; current rules accept its age, so do not expect a new freshness policy. The merchant and buyer can see the risk. For finite stock, synchronous refusal avoids charge; an asynchronous post-charge refusal creates a real debt, which must be understood before this product is offered. |
| C-09 / P0 | Compare the maxTimeoutSeconds in a synchronous card's 402 with the thirty seconds its price holds. Sign a payment whose authorisation ends sooner than the gateway asks — with the buyer's clock set back, as a late clock would, or on the local stack against a copy of the challenge with maxTimeoutSeconds lowered — and present it with the merchant's arrival barrier armed. Then sign again against the same challenge and pay at once. Present the same short authorisation for an asynchronous card. | maxTimeoutSeconds is longer than the price's life and does not extend it: a payment presented after the price lapsed still buys nothing (C-07). The short authorisation is refused before anything reaches the merchant, as 409 payment_not_verified, not retryable, in words that say nothing was charged or made and how long the authorisation has to last; the facilitator verifies it and is never asked to charge. The order stays priced, and the fresh signature buys it once, with one effect and one charge. The asynchronous card, charged before its goods, takes the short authorisation. Whether Coinbase's facilitators keep the expiry margin the gateway allows for has not been checked: on the test channel record what the facilitator itself answered, not the gateway's arithmetic. |

## J. Lost answers, duplicate work and concurrent actions

Every fault row has an unfaulted control using the same goods and runtime.
Prove the fault hit its intended phase. A retry which never overlapped or a kill
before the action began is a different experiment, not a successful race test.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| J-01 / P0 | Drop a successful purchase response after upstream completion. Repeat the exact payment, then a fresh authorisation against the same challenge, whose payment reference names the same order. Finally deliberately create a new purchase. Run locally and with capped real TEST settlement. | Same-order recovery causes no second payment or effect. Measure whether the real facilitator accepts a consumed authorisation; a refusal must leave a safe status/recovery path. A deliberately new purchase is a second sale, accounted for as such. Check transfers across the recorded block interval. |
| J-02 / P0 | Cut SDK responses before headers and midway through the body after real gateway commitment: publish, accept, deliver and refuse separately. Restore connectivity and read state before choosing a retry. | The SDK describes an unknown outcome, not “nothing changed”. Same-product republish and same-order delivery/acceptance preserve the committed operation. Refusal recovery follows the read state. Read failures throw an actionable error, never masquerade as an empty catalogue/order list. |
| J-03 / P0 | Kill the merchant before its effect, after durable/provider effect and before acknowledgement. Restart; also run two instances holding the same redelivered order. | A repeat can arrive, but durable merchant/provider evidence shows one effect and the first result. An uncertain provider outcome is reconciled without blind re-provisioning. Test the merchant's recovery gap, not just Agentify's receipt count. |
| J-04 / P0 | Against Postgres race two payments for one order, different payers for one order, one authorisation for two orders, and conflicting deliveries. Separately send a saved payment to another product's URL, including another merchant, and retry with changed ordinary parameters such as the actual product's delivery email; do this before first settlement and after it. | At most one payment owns an order, one authorisation buys at most one order, and one delivery wins. A serial execution cannot pass the race. For changed-choice retries, verify the actual goods, recipient and amount: require refusal before a new charge or unmistakable recovery of the original purchase, never silent fulfilment of an earlier choice presented as the new one. Preserve original intent and the agent's interpretation (B-03); do not invent a new API policy for editing orders. |
| J-05 / P0 | Race two legitimate purchases of the last unit, once before payment and once after both quotes. Also keep one slow order ahead of an unrelated merchant's order. | The merchant's atomic stock/effect record prevents duplicate allocation. A post-charge shortage remains a visible full-price debt; do not assert both buyers avoid charge in asynchronous mode. The other merchant is not silently starved or served the wrong goods. |
| J-06 / P0 | Restart the application with priced unpaid, dispatched synchronous and accepted asynchronous orders. Restart the database connection separately. After recovery retry using saved IDs. | Committed orders/results and clocks survive; no duplicate charge or orphaned accepted work. Distinguish transient unavailability from unknown settlement and show a recovery path. Intentional unresolved states remain visible instead of being falsely timed out as unpaid. |
| J-07 / P0 | Lose the poll response carrying a refund event while the merchant process stays up. Separately stop it overnight and restart. | Events may be lost under their contract. Periodic open-order reads find every debt without relying on a restart or an exact event count, and recovery completes the original order. |
| J-08 / P0 | Model a settlement that definitely failed, one committed but unanswered, and a late successful answer, separately for synchronous and prepaid orders. On separate orders, wait for outcome_unknown after the settlement call returns; have an operator independently establish that the payment settled and record that settlement with report-payment. | Money remains unknown where evidence is absent; a second charge is refused while unsafe. Late success releases recorded synchronous goods or creates the prepaid refund obligation appropriate to its state. A real late payment-layer answer and a manually recorded charge are different evidence: the latter can leave delivered goods with no receipt. The operator command does not verify its assertion on chain. Compare buyer, merchant and dashboard, label simulation/assistance, and require independent transfer proof for a real payment claim. |
| J-09 / P1 | Send 200 unpaid quote requests with bounded concurrency against a controlled merchant while one normal buyer buys. Restore normal traffic afterwards. | Measure normal buyer delay, price fallback/refusal and recovery. Screens distinguish unpaid attempts from fulfilled sales or debts. Do not prescribe unlimited throughput; failure of a documented deadline or misleading successful price is a finding. Never run this load against shared TEST without agreement. |

## D. The SDK makes the safe path the ordinary one

This block checks realistic mistakes and the complete accepted path. Exhaustive
syntax, field-absence and enum permutations belong to deterministic tests;
their presence does not eliminate the end-to-end stories here.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| D-01 / P1 | Adapt an actual merchant product: omit a declared-required field from purchase input, copy markup into its card description, or use a type outside the contract. Fix each error, republish where needed and buy. Separately omit a business requirement from the card while leaving its schema valid. | Structural refusal identifies the field and safe correction; accepted text is not silently changed in meaning. A schema-valid but business-incomplete card may publish: the actual purchase and goods check must expose its missing requirement, not a fictional publication check. Local versus server-only validation is explained. Judge actionability, not the wording's library origin. |
| D-02 / P1 | Run the card check, then try publishing without required seller settings; try a confirmation-mode card and a parcel on live-mode configuration without settling. | Local validation does not claim merchant readiness. Publication names every missing prerequisite it can know and rejects unsupported modes before buyers pay. A known unsupported feature is not exercised as if it existed. |
| D-03 / P0 | Grow a copy of a real card towards the challenge-size limit using realistic long/multibyte field names. Publish, then probe and buy through ordinary clients and ingress. Try one over the bound. | Published offers remain readable; an oversized challenge is refused at publication with what to shorten. Do not pin a parameter count: encoded size depends on the whole card and deployment. A local card check alone cannot certify this server bound. |
| D-04 / P1 | Start a merchant process with a missing/wrong/revoked key; later rotate keys while orders are active and overlap two valid processes. | Misconfiguration is actionable and distinguishes permanent from transient failure. No unauthorised process receives subsequent work after revocation; valid processes recover without re-provisioning. Judge key rotation by actual work, not process liveness. |
| D-05 / P1 | Make an ordinary handler mistake: throw, return nothing, return an unrecognised object, or pass an argument to accepted(). Run TypeScript and the documented JavaScript path separately. | The engineer receives the actual outcome, order ID and safe next step, and finds the situation in the failures page's one table. TypeScript diagnostics, JavaScript acceptance-with-warning and raw HTTP refusal are different contracts; no pretend uniform rejection. Repair and complete the same eligible order. |
| D-06 / P0 | Use merchant B's key against A's read, deliver, refuse, cards, receipts and payout information; use a stale browser mutation from A after signing into B. | No other tenant's data or effects are exposed. Merchant API authority is distinct from public buyer status: possession of an order's identifier or status URL is the capability to read that order (D-07), not merchant authentication. Exercise both merchants' own successful controls first. |
| D-07 / P0 | Buy a synchronous and an asynchronous card. Decode the 402's payment requirements and the signed payment header. On the local stack, run a forwarder that logs each body whole between the gateway and x402.org's facilitator, since nothing in the repository records these calls yet, and read every verify and settle. Then present the 402's payment reference on the status route and, with the merchant's key, on the merchant's order route; present a paid order's reference with another payer's fresh signature; and present a payment naming the order by its identifier, where the reference goes and as order_id. Read the status of a real order and of an unknown identifier, keeping the headers. | The order identifier is in none of the requirements, the payment, the resource address, the descriptions or any facilitator call, which carry payment_ref instead; it reaches the buyer only in the paid answer and on the status route. The reference opens nothing: both routes answer it exactly as an unknown identifier. Another payer holding a paid order's reference is refused with 409 not_this_purchase in words that name no order, and nothing is charged twice. A payment naming the identifier pays nothing and is answered with a fresh 402. Every status answer, the unknown one included, carries Cache-Control: no-store. The public text agrees: llms.txt and the purchase route's description say the requirements carry a reference that opens nothing, and no page says the identifier travels in the payment. |

For D-01/D-02, exercise the published TypeScript input type as well as JavaScript
and server validation. The source contract distinguishes card modes at compile
time; installed release evidence decides which diagnostics the engineer can
actually receive. Editing and republishing a card read back from the catalogue
is also an ordinary task: a type error must lead to the documented safe use of
the merchant's original publication input, rather than requiring blind casts.
Do not infer publication readiness from compilation or suppress diagnostics
just to reach an HTTP refusal.

## E. Identity and browser state survive real usage

Use two controlled email identities, separate profiles and a private window.
Run Google only against a configured real provider for the browser claim;
a stubbed exchange is separate engineering evidence.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| E-01 / P1 | Open a sign-in link as a mail preview would, then on another device; reload, use it once, reuse it and try an expired link. Request another within the displayed wait. | Opening alone does not sign in or consume the link. Confirmation names the account; expiry/reuse/rate limiting have a usable recovery path. The person understands which browser was signed in. Do not require every mail client or exact copy; record delivery/spam delays that block the task. |
| E-02 / P0 | Create reports and a merchant by email link, then sign in with Google for the exact same address. Try a different exact address separately. Cancel Google and use the email fallback from a bookmarked section. | The same identity recovers its existing merchant/data without duplication; the other remains isolated. Cancel/refusal creates no merchant or wrong session. The intended destination survives a successful fallback. Plus/dotted variants are not silently assumed to be the same identity. |
| E-03 / P0 | Leave Settings, Keys, Cards, Connect and report-registration forms open as A; sign in as B in another tab, then submit each stale form. | Neither identity suffers an unintended mutation or disclosure. The person sees the active account and can deliberately restart the intended action. Inspect both accounts after each attempt, including which account owns the requested report. |
| E-04 / P0 | Sign out, expire the session and revoke other sessions while a form or wallet action is open. Then press its action. | Ended sessions cannot mutate. No copied secret or previous account data reappears as current data. The return path says what was and was not done, or that it is unknown, and preserves safe recovery. |
| E-05 / P1 | Make the identity service temporarily unreadable while a signed-in person opens a private report or registration form. Restore it. | “Cannot determine who is signed in” is not rendered as signed out, empty reports or permission to register anew. Private information stays protected; the same person's report is recoverable afterwards. |

## H. A WooCommerce merchant sells and keeps working

Use the actual lab products, a dedicated merchant and the current shop
configuration. A successful connection badge is a prerequisite, not the result.
The owner uses the dashboard and Woo administration; the organiser observes
remote requests and faults privately.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| H-01 / P1 | Connect the controlled shop, import its supported downloads and unsupported gift experiences, import again, then reimport with one supported card deliberately paused. The owner then makes the first test purchase of an active download themselves, from public guidance alone. | Reasons explain why an experience cannot be delivered as a file. Reimport does not duplicate cards or undo the owner's pause. The documentation shows that purchase as an engineer's program: record how an owner with no engineer makes it, and every help they needed. Retrieve the native download in a clean client and compare its name/bytes with the actual product; one Woo order, one Agentify receipt and one payment exist. |
| H-02 / P1 | Paste a wrong shop address, decline the shop grant, close the browser during approval or return after session expiry. Start another grant before an old callback arrives. | No false “connected” result; the owner can see and recover the actual integration state. An old callback cannot replace the newer connection or reconnect after return to SDK. Use Postgres for the callback race, and inspect the shop holding the keys. |
| H-03 / P0 | Start with one active and one individually paused SDK card. Connect Woo, including an abandoned grant. Attempt SDK publish/poll. Return to SDK, restart its merchant process, then deliberately resume sales. | Only one integration sells. SDK poll/publish fail intelligibly while Woo owns the stream. Return is possible even without a completed shop connection; code sales remain globally paused until resumed, and the individually paused card stays paused. Existing keys may still read and close eligible old work. |
| H-04 / P0 | Try switching in each direction while an unpaid quote, first answer, accepted delivery or unshipped parcel remains open. Race Connect/Disconnect with purchase creation. Then try with only refund debt. | Blocking orders are named. Either the old integration keeps the created order and blocks the switch, or the switch wins and the old-path new purchase is refused before money. No orphaned work. Debt alone does not block switching, but remains discoverable and owed. |
| H-05 / P0 | Change product price, stock status, file or a required shop setting after import: once before the quote, once after quote before payment/fulfilment. | Fresh checks use the current eligible product or refuse. After payment a now-invalid download is not created at a guessed price: zero Woo order creation and a visible refund debt. A stale card may remain listed; it must not be described as continuously synchronised. Record product/file identity as well as price. |
| H-06 / P1 | Make the shop unreachable, busy, return malformed data or revoke keys before quote; contrast a known unsupported product. Lose a setting irrelevant to this product's class. Repair the shop. | Unknown/unanswered is distinguishable from known unavailable. No charge before a usable offer; irrelevant setting failure does not block the product. Restoring the shop allows a fresh purchase without hidden cleanup. |
| H-07 / P0 | Revoke keys after a valid download quote. After the charged refusal reconnect the same shop and wait. Then follow the documented operator recovery for that exact order. | Reconnection alone does not silently create a paid order again. Explicit supported recovery creates at most one Woo order under the correct newer connection and delivers the original Agentify order. Record the owner's support path; an internal command is operator capability, not owner self-service. |
| H-08 / P0 | Let Woo commit a download order and cut its response. Restart the connector and retry. Test recovery with absent, wrong and exact matching remote order ID. | No second Woo POST/order. Unknown creation is not invented success. Wrong identity cannot release goods; matching recovery retrieves the original permission and delivers once. Repeat recovery and verify the same result. |
| H-09 / P1 | Import a catalogue just over its 200-product limit using controlled copies. Separately make public product price differ from the authenticated API, and make a product/settings endpoint return a different object's ID. | Oversized import refuses the whole operation rather than silently publishing a prefix. Mismatches name the product/setting and publish no misleading card. The summary distinguishes rejected, unknown and unattempted work; the owner can recover without guessing which products changed. |
| H-10 / P0 | Disconnect after orders have safely closed; revoke the shop's API key there. Reconnect and buy a supported product again. | Agentify no longer uses removed connection credentials. The owner understands what disconnect does and what must be revoked at the shop. Reconnection does not resurrect paused cards or lose old debts and receipts. |

## F. A parcel is a physical obligation

These stories run on TEST or the local stack, never as a live sale. Use the
tote's configured zones and a controlled delivery address. For an SDK parcel,
persist the full address in the merchant system before acceptance. Do not log
the address to prove that it arrived.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| F-01 / P1 | Quote the tote to the actual supported country, state and postcode zones, and to an unsupported place. Try missing necessary locality fields and a changed address at payment. | A supported offer includes shipping; unsupported locality or changed priced address refuses before payment. Quote messages expose locality only. Errors let the agent correct the address without guessing a different destination. |
| F-02 / P0 | Pay; persist the address at the merchant, then lose the acceptance response and restart. Separately crash before saving it and allow the deadline/erasure to occur. | After acceptance the gateway shows erased_at and never supplies the address again. The merchant's durable copy recovers the accepted work. A missing copy is not fabricated; its unfulfillable order remains a debt. Inspect active order/queue/connector data and redacted logs; backups retain data until their stated expiry. |
| F-03 / P0 | For Woo, change shipping rates after the quote: keep a current rate at the paid cost in one variant and remove every such rate in another. Exercise a cart that fails between add-item and rates; separately a controlled plugin replaces/removes the item. | Only the quoted total can be spent. A matching current cost may be used; no matching cost leaves debt with zero Woo POST. No price for the wrong item/cart may be accepted as the requested goods. The wrong-cart refusal is an adversarial hypothesis to verify, not a known implemented check. |
| F-04 / P0 | Record shipment with tracking and without it on separate orders. Repeat the same shipment, submit a different one and change Woo tracking/status after completion. | Buyer sees shipped, never proof of arrival. Shipment has one durable meaning; identical retry is safe and conflicting SDK shipment is refused. Explain that later Woo edits do not rewrite an already recorded Agentify shipment. A missing native Woo tracking facility leaves that variant unmeasured. |
| F-05 / P0 | Let a parcel exceed its shipping time; ship a still-followed Woo order late. Separately cancel/refund it in Woo, lose Woo's create response, and ask about a parcel lost after shipment. | Late supported shipment can close its debt. Woo cancellation/refund is not proof of returned USDC; current cancellation can leave the debt until the shipping deadline. Unknown creation causes no second parcel order. Download recovery must not recreate a parcel after erasure. Returns, lost-parcel refunds and address changes remain explicit unsupported recovery needs, not fabricated successful outcomes. |

## M. Money reaches the right place and can be paid out

Use controlled TEST wallets and real signed payments. Decode-only cases need
no spending. Hold sales and unrelated payouts quiet while reconciling. Record
USDC token units, pre/post split balances, warehouse credits and recipient
balances; a wallet's decimal display is not a reconciliation instrument.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| M-01 / P0 | Take the first payment into a recorded split with no code yet, then send the Settings payout. Make two equal-price sales and pay out again; repeat payout with no new sales. Give the person holding the wallet only the Sending a payout page, once with Coinbase Wallet and once with another wallet sending the three values Settings shows. | Purchase goes to its recorded split; payout creates/distributes/withdraws as applicable. Reconcile conservation across balances, credits and transfers, including rounding/dust. Do not require exactly 99.9% of each sale in the wallet: distribution uses accumulated balances. Repeated payout creates no new entitlement to money. The page alone is enough to send each payout on the network Settings names, and the sign of success it gives, one incoming USDC transfer from the 0xSplits warehouse, is what the wallet shows. |
| M-02 / P0 | Change wallet A to B before paying an old challenge. Separately change it after verification while a synchronous handler is held, then finish. | Before verification, the obsolete offer refuses before charge. After verification, settlement uses the recorded split A it verified; the next sale names B. No payment goes to an address the buyer did not authorise. Payout of old funds still belongs to A. |
| M-03 / P0 | Return wallet B to A; use two merchants with the same recipient wallet; include historical used splits in payout. Attempt a zero, token, commission or payout-contract address as recipient. | Returning A finds its existing split; merchants remain separate despite shared recipient. Historical money remains payable to its recorded wallets. Invalid recipient destinations are refused before being recorded. Inspect both merchants, not only the form response. |
| M-04 / P0 | In the actual wallet UI reject the payout, lose the session or its response, and repeat after checking chain evidence. Use a controlled provider for malformed acknowledgements and a failed inner payout operation. | Rejected, submitted, unknown and received are not conflated. A batch ID or successful outer transaction does not prove an inner distribution/withdrawal completed. The screen gives a safe way to inspect rather than urging blind repetition. Label controlled-provider evidence separately from actual wallet behavior. |
| M-05 / P1 | Decode the alternate-wallet payout, including network, destination, zero value and full data. Build a merchant history of 21 used splits locally. | Complete data can be copied without truncation; sender cannot redirect recipients. Over the supported twenty-split limit, the user gets a useful refusal, not a shortened transaction or false success. No funded purchases are needed for the local history boundary. |
| M-06 / P0 | Owe a buyer a refund, before and after payout. Ask the merchant to identify buyer, full amount, funding shortfall and how to send/record it. Hold delayed fulfilment; in separate variants release it while a controlled manual refund is submitted and after it is confirmed. Then give fresh merchant/buyer sessions their own records and the original task. | Full price remains owed despite commission. Verify refund evidence separately from status and check extra goods, a second refund attempt and false claims that goods alone settled the debt. Missing payer/recording tools are findings; do not stop the inspector's race there: they may use the known controlled buyer and authorised refund budget, labelling that operator assistance. No refund recording is currently built, so inability to coordinate safely remains an explicit failed recovery need, not assumed prevention. A transfer, late goods and refund_due are different outcomes. |

M-06 also tests the documented merchant-side defence: the engineer keeps a
durable record of refunded orders and consults it in the handler and every
open-order recovery loop. Restart and redeliver after the refund, and race
refund submission against work already in flight. A lookup before an effect
does not by itself close that race. First observe whether the newcomer discovers
and implements the required coordination from public guidance; then compare
with a controlled integration lacking it. Calling refuse does not record a
refund or stop later goods. A documented responsibility still needs a safe,
understandable path; its existence does not turn an unsafe attempt into a pass.

## K. Someone else opens the dashboard the next morning

Prepare paid delivered, accepted overdue, unpaid expired and unresolved payment
orders, plus an older debt outside the first page. Let the merchant's event
response be lost. Use an independent reader who did not create the orders.
Give only the public UI, docs and merchant-owned operation records; allow the
SDK if their role normally uses it. Our SQL and private logs are not their tools.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| K-01 / P0 | Ask what needs action and where the money is. Include two equal-price payments near each other, one paid undelivered order without a receipt and a delivered order whose charge was recorded by an operator without a receipt. | The reader finds all obligations, distinguishes uncertainty from failure and does not infer that receipt totals equal cash received. Operator assertions remain distinguishable from independently verified money. Record first interpretation, missed items and every request for help. |
| K-02 / P0 | Recover one overdue order by delivering its already recorded goods, reconcile another without repeating payment, and attempt the refund task in M-06. | Each remains the same purchase, with one effect and truthful money state. Missing owner tools are failures of the recovery path, even if an operator can repair it. Advice to contact us needs an actual discoverable contact and an honest explanation of what support can do. |
| K-03 / P1 | Leave the dashboard open overnight, restart the merchant process repeatedly, and return through an old bookmarked filtered list. | Visible state refreshes or clearly says it is stale. Repeated startup does not multiply goods. The merchant can tell when work resumed and whether it needs attention without reading gateway logs. |

## I. The scanner's evidence and a person's data

Use an owned shop or an approved public target. Controlled failures are at our
boundary or in our test site, never attacks on another shop. Scanner acceptance
includes database-backed runs and worker-to-report delivery; a browser walk
over static data does not cover them.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| I-01 / P1 | Scan the actual shop, reload during progress, interrupt a worker and reconnect. Contrast a completed scan, robots refusal, bot challenge and partial unreadability. | Progress and recovery stay tied to the same scan. Unknown checks are not counted as confirmed defects or complete coverage. The user understands what was inspected, when and what could not be measured. A check count or a timer alone does not establish a useful report. |
| I-02 / P1 | Enter a malformed URL and one carrying credentials/token parameters, then correct it. Use a controlled redirect to a forbidden/private destination. | Refusal is intelligible and redacts secrets. A permanently forbidden target does not offer an endless retry. Nothing starts a private-network scan or exposes a credential in the page/log evidence. |
| I-03 / P0 | Unlock the full report by email, then open the merchant dashboard. Repeat from a stale account tab (E-03), and lose the registration response after commitment. | The report belongs only to the deliberately chosen identity; the existing session continues appropriately. Merchant creation remains explicit. A lost answer neither files it under a different person nor traps the page indefinitely in Sending or falsely claims nothing changed. |
| I-04 / P0 | Ask a person to send useful results to an engineer. Let them choose prompt, public link or image; before pressing, ask what will become public. View each result from a fresh browser, revoke sharing and revisit page/API/image. | Disclosure matches the choice the person understood. Public material reveals only its intended summary, never full private evidence/contact data. Image download's publication effect must be understandable. Revocation stops fresh access; previously downloaded copies cannot be recalled. The copied repair prompt preserves unknowns and does not invent findings. |
| I-05 / P0 | Request deletion as a report-only person and as a merchant owner. Cancel once, confirm once, switch accounts in another tab, and lose the accepted request's response. After cleanup check old private/report/share/image links and sign in again. | Intentional identity is preserved; requested versus completed deletion is clear. Reports and shares are inaccessible after completion, while merchant business records survive their documented boundary. Do not claim immediate backup erasure or that a merchant's account is deleted with scanner data. |
| I-06 / P1 | Choose essential-only consent, run a scan/register, then allow and withdraw measurement, including another tab. Inspect browser traffic and authorised server records. | Product analytics and ads measurement stay off until allowed and stop after withdrawal, in every open tab. Necessary consent, identity and scan records are not mistaken for prohibited analytics. Browser-only evidence leaves server behavior unmeasured. The privacy explanation matches what the person just chose. The report of a registration to the ad tracker does not follow this choice; I-07 checks it. |
| I-07 / P0 | With essential-only consent, open sign-in through an address carrying the ad tracker's click identifier and register a new address by emailed link; repeat with Google. Then sign in again, create a merchant, arrive from the ad with an address that already has a verified account, refuse a Google return, and sign in without a click. Run the dashboard locally with its own receiver: the test channel never reports. | Nothing is asked on screen. Each new account is reported once whatever the privacy choices; a repeated delivery of that same report is allowed. The report carries the click identifier and the event alone, never the address or anything else about the person. The other attempts report nothing. The click identifier is gone from authorised server records after delivery, or after a day without it. The privacy page says the report goes whatever the choices and keeps it apart from the banner's categories. Delivery to the real tracker needs its own logs and the marketing team's agreement; never register from a real ad click on the live channel as a rehearsal, since it counts as a paid registration. |

## L. A buyer actually finds the product in an external catalogue

This is required for a claim that Agentify brings goods to external catalogues.
Record readiness of the sale and readiness of discovery separately, and show
that distinction in the overall verdict. Passing other blocks does not waive it.

Use a public canonical resource for a real controlled product, a second product
of that merchant and a fresh agent. Record the actual facilitator, chain and
split. A payment through x402.org is not a CDP Bazaar experiment. Both channels
settle through Coinbase's facilitator, so L runs on the test channel with
Base Sepolia. The current
[Coinbase seller guide](https://docs.cdp.coinbase.com/x402/seller/get-discovered),
checked on 2026-10-18, describes CDP testnet discovery; verify the deployment's
route rather than silently changing its facilitator or moving to mainnet.

The existing tools have different proof boundaries. `pnpm smoke:listing
<base-url> <item-id>` checks the unpaid door and CDP validation; it does not
read discovery. `pnpm smoke:bootstrap --confirm` spends and then watches
resource URLs. Read its options and cap before execution; do not rerun it just
to refresh a listing observation. Its success alone proves neither fresh
metadata nor completeness of a negative search.

Read the external catalogue independently. Save the raw metadata and successful
pagination evidence privately. Prefer supported exact URL/recipient filters;
if absence depends on an all-resource walk, record page count, reported total,
duplicates, traversal times and whether the index changed during the walk.
A failed, malformed, partial or capped walk means unknown, not absent.
Capture the actual facilitator discovery response when exposed, including the
redacted EXTENSION-RESPONSES Bazaar status and rejection reason. Record a missing
or unexposed response as unknown for that step; never turn a successful technical
validator or payment into proof of discovery submission acceptance. The provider
can screen metadata separately. Index membership still needs a catalogue read.
Search ranking and complete membership are separate measurements. Current
[buyer discovery documentation](https://docs.cdp.coinbase.com/x402/buyer/discover-services)
describes both interfaces.

Before settlement, fix an observation window and queries in the report. The
default bounded experiment observes before payment and at 1, 5, 15, 30 and
60 minutes afterwards. This is our sampling plan, not an Agentify guarantee.
Longer observation is a separately recorded follow-up, never a new purchase
made merely because indexing is late.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| L-01 / P1 | Read the owner-facing promise, including the owner page's “Who buys here” and the question “Will Agentify bring buyers to me?”, and ask a newcomer what “connected” and “first payment” achieve. Compare their expectation with the actual publication, settlement and listing evidence. | No one is told the whole shop is externally listed merely because a card was published or one purchase succeeded. If the front page implies more than the measured result, record a product promise failure even when the quickstart contains a caveat. |
| L-02 / P1 | For a newly exposed controlled resource, save baseline external membership/metadata, validate, settle once through an eligible facilitator and observe. Keep the sibling SKU unpaid, then pay it in a separate bounded variant. | Each SKU has its own evidence. Report technical validation, payment success, actual facilitator discovery submission status, index presence and absence during a complete observed window separately. A previously listed URL does not prove this payment caused discovery. An unreadable catalogue or wrong facilitator leaves discovery unmeasured. Where a resource is listed, its published payment requirements carry a payment reference and never an order identifier (D-07). |
| L-03 / P0 | Give a fresh buyer only Bazaar's discovery entry, real requirements and a capped budget. It searches, reads the external offer and attempts the purchase. | It can identify the seller, construct the correct request, honour total cost and obtain the actual goods. Save query/results, selected resource and purchase evidence. Exact-URL existence alone is not findability; an irrelevant search result is not successful distribution. |
| L-04 / P1 | Republish the same product with a genuine price/description/result change. Observe external metadata before a further payment and, separately, after an authorised one. | The canonical product URL stays stable. Compare the full external offer with what a new buyer will actually get; measure stale fields and update delay. No promise of automatic freshness is inferred from one URL being present. A stale price cannot cause an unapproved charge. |
| L-05 / P0 | Pause a listed card; follow its still-cached external entry as a new buyer, then resume. Change the payout wallet in a separate variant and revisit the old offer. | New paused purchases refuse before money. Stale metadata cannot direct a payment to the wrong current offer. Resumption uses the same resource identity. Measure external disappearance/update separately; Agentify cannot claim instantaneous deletion it did not observe. |

Historical evidence is useful but bounded: the
[August experiment](04-spike-bazaar-listing.md) observed one Base resource
listed after payment, not today's integrated merchant journey. The
[commission experiment](47-commission-in-the-product.md) left split-address
indexing unmeasured. Provider documentation is not a run of Agentify.

## G. Rules that apply only to live money

Only with explicit approval for controlled accounts. No purchase or payout is
part of this block. A local live-mode simulation can inspect logic, but cannot
replace actual mail/provider evidence; record them separately.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| G-01 / P1 | Open live settings and attempt publication before operator approval; probe Woo/parcel entry points. Reach the live dashboard from /agentic-shop's main button as a newcomer who has not yet sold on the test channel. | Real-money context is understandable. Missing approval and unsupported live paths refuse before sale and give a discoverable next step. A test rehearsal has not silently enabled live sales. While the merchant is not approved, the live dashboard says the first test sale happens on the test channel, under an account of its own, and links that dashboard; an approved merchant and the test channel show no such line. No public way to ask for the approval exists, and the pages say so: record how the newcomer tries to get it and what happens. |
| G-02 / P0 | Set the first controlled wallet, request a replacement, request it again, replace the pending value and cancel from one of two sessions. | Announcements and the 48-hour replacement delay follow the current wallet rule. Cancellation preserves the correct wallet and invalidates the other sessions as promised. The screen makes current versus future recipient unambiguous. |
| G-03 / P0 | In an isolated live-mode setup fail one wallet announcement and race two replacements; test immediately before/after the effective time using its controllable clock. | No unannounced replacement commits; overtaken writes do not silently win. Reads/challenges use the wallet actually in force. Actual live mail delivery and local clock simulation are separately evidenced; never accelerate a shared host's clock. |

## Combining ordinary failures

After the isolated stories, run these selected combinations. Use barriers and
record every change; uncontrolled random clicking does not explain a failure.

| ID / priority | Combination | Required result |
| --- | --- | --- |
| X-01 / P0 | A buyer's reply is lost, the application restarts, and the merchant rotates its key before the buyer resumes (J-01/J-06/D-04). | Same order, one effect and payment; the replacement merchant process and buyer can recover without internal history. |
| X-02 / P0 | A Woo order's response is lost, the owner presses Disconnect and the old connection callback arrives (H-02/H-04/H-08). | No lost ownership, renewed credentials from an obsolete grant or second Woo order. Any remaining debt is visible and supportable. |
| X-03 / P0 | A merchant returns after a lost refund event with 200 newer orders and an old tab signed into another account (J-07/U-04/E-03/K-01). | Neither identity is mutated accidentally; the real debt remains findable and is not hidden by counts, paging or stale UI. |
| X-04 / P0 | An external offer is stale after a price/wallet change and the buying agent restarts while payment outcome is unknown (L-04/L-05/B-03). | No silent new payee, extra payment or invented success; the buyer can explain what remains unknown and stop safely. |

For further exploration pick one real handoff from the run, change one of
time, identity, connectivity, product data or process count, and write the
prediction before doing it. After a new defect, add its smallest reproducible
story rather than every permutation of the same cause.

## Run selection and completion

Start with independent A, U and B attempts before teaching participants.
A fresh participant's first attempt is spent only on a path with no blocker
already known: when an earlier review has found a dead end there, record it as
a known finding and run the independent attempt once its fix reaches the test
channel. Stories that need an instrument the run lacks wait for it rather than
being run without their fault. Establish one verified SDK sale and one verified Woo download sale, then
exercise failures and recovery. Start L's bounded observation after its
prerequisites and perform independent work while it waits. K is a separate
handover to a fresh reader. Scanner identity/privacy is required when that
entry path is offered. G is separately authorised.

A release check is a selected subset, not full readiness: A-03/A-04, B-02,
J-01/J-02, D-04/D-06/D-07, E-02/E-03, H-01/H-03/H-08, M-01/M-02 and one
morning-after U-02/K-01 recovery. Add C-09 for changes to the payment window,
B-07/B-08 for changes to what an agent reads at the door or on the test
channel, U-06/U-07 for documentation and site-frame changes, F for parcel
changes, I for scanner or identity changes, and L for
discovery/declaration/payment-recipient changes.
Test and UX results from an earlier revision carry forward only with an
explicit unchanged-promise rationale; never call them freshly run.

Before the first outside merchant, run every applicable P0 and P1 story,
including each required variant, and the independent participant tasks.
P2 accessibility/usability variants are not optional when they block a
participant's actual device or assistive technology. Exclusions name the
narrower supported scope; they cannot turn an unmeasured promise into ready.

Use these result words:

- Pass: all stated actions ran and every required observation held.
- Fail: an observed outcome violates the required result. A known documented
  inability can still fail the actual customer task.
- Partial: some variants ran and passed; name each missing variant.
- Blocked: a named instrument, release, authorised environment or participant
  is missing. An absent product recovery feature is a finding, not equipment.
- Not run: no execution evidence.
- Outside the declared scope: justified before the run and reflected in the
  verdict, not quietly excluded after failure.

For each story attach separate business/UX/AX/DX results, with not-applicable
where no such surface was exercised. Unknown is an outcome of the system or
measurement, never automatically a pass or failure: judge whether the product
represents and handles it honestly.

Ready means the named merchant paths and promises have required passing
evidence, with no open money/identity/privacy defect, blocked essential task or
materially misleading screen/document. Not ready means one of these fails.
Not measured means the evidence cannot support either conclusion. “Ready after
fixes” is a list of work, not present readiness; fixes need a repeat run.
An untested Woo path cannot inherit SDK readiness. A working sale cannot
inherit discovery readiness. An outside engineer not yet observed leaves that
criterion unmeasured.

Prioritise findings by harm: wrong or duplicated money/goods and identity/privacy
first, then unresolved obligations or a blocked task, then unsafe or misleading
comprehension, then recoverable inconvenience. Do not down-rank a false monetary
claim because the underlying API was correct.

## Report and evidence

Reports remain in a private location named for the run. Do not open tracker
issues merely to count findings. Capture actual behavior, including failed
attempts, while it occurs. Correct the public plan when an expectation is
wrong, but preserve the original prediction and evidence in the private report.

```markdown
# Product acceptance, <date>

## Scope and prerequisites
Actual running revisions and image evidence; npm versions; relevant prior
evidence; participants and what each knew; real products; integrations;
facilitator/network; tools/faults available; budgets and observation windows.

## Verdict
SDK, Woo, human screen comprehension, buyer independence, SDK self-service,
scanner/privacy and external discovery: ready / not ready / not measured,
with the evidence and unresolved findings that determine each.
State the exact merchant/device/product scope, exclusions and limitations.

## Stories
| Story / variant | Business | UX | AX | DX | Evidence | Finding / missing evidence |
| --- | --- | --- | --- | --- | --- | --- |

## Findings
For each: real user consequence; steps; predicted result and source; observed
result; revision and reproducibility; private evidence references; whether
assistance was needed. Static suspicion, reproduced defect and accepted
product limit are different labels.

## Money and goods
Per-order evidence rows; actual merchant/provider effects; receipts and
payment transactions; payout balances/credits/transfers; unknown amounts;
unresolved debts; cleanup that is safe only after reconciliation.

## First interpretations
Screens and first viewport, participant's explanation, chosen action, help,
agent transcript and tool/context limits, engineer's undocumented edits.

## External discovery
Per-resource before/after metadata; payment/facilitator; complete/partial
observations; search queries/results; delay; independent buyer's result.
No listing, unknown membership and untested search remain separate.

## Remaining work and cleanup
Every partial/blocked/not-run variant, its consequence and smallest next step.
Retain unresolved orders and evidence. Revoke test keys/connections deliberately.
A paid test merchant cannot necessarily be removed with pnpm forget; that
command refuses accounts with orders/receipts. Never erase debts to tidy a run.
```

## Sources and limits of this protocol

The current public merchant promises are, for the owner,
[connecting](../../apps/docs/index.md), [money](../../apps/docs/money.md),
[sending a payout](../../apps/docs/payout.md),
[WooCommerce](../../apps/docs/woocommerce.md) and the
[common questions](../../apps/docs/faq.md), and for the engineer,
[quickstart](../../apps/docs/quickstart.md), [cards](../../apps/docs/cards.md),
[orders](../../apps/docs/orders.md) and [failures](../../apps/docs/failures.md).
What an agent is told is the site's [llms.txt](../../apps/web/lib/llms.ts), the
test channel's own, served by the [edge](../../deploy/Caddyfile), and the route
descriptions in the [contract](../../packages/contracts/src/api.ts). Their
installed/published versions must agree with what participants receive.

The decisions defining acceptance boundaries are
[identity](../decisions/0026-one-way-in.md),
[the order key](../decisions/0011-agent-collection-door.md),
[one integration](../decisions/0036-a-merchant-sells-through-one-integration-at-a-time.md),
[WooCommerce](../decisions/0023-woocommerce-connect.md),
[address erasure](../decisions/0032-a-buyers-address-passes-through.md),
[shipment](../decisions/0033-a-shipped-order-ends-at-the-carrier.md),
[wallet changes](../decisions/0019-non-custodial-payout-wallet.md),
[payout splits](../decisions/0037-every-payment-goes-to-the-merchants-split.md),
[registry persistence](../decisions/0038-the-registry-of-payout-splits-is-never-rewritten.md)
and [discovery declarations](../decisions/0012-discovery-declaration.md).

Implementation evidence for the organiser lives in the
[order machine](../../packages/core/src/orders/machine.ts),
[SDK transport](../../packages/sdk/src/transport.ts),
[gateway](../../apps/gateway/src/app/gateway.ts),
[payment edge](../../apps/gateway/src/http/x402.ts),
[authorisation window](../../apps/gateway/src/app/payment-window.ts),
[operator payment report](../../apps/gateway/src/payment-report-command.ts),
[Postgres store](../../apps/gateway/src/adapters/postgres/store.ts),
[Woo worker](../../apps/dashboard/src/woo-worker.ts),
[Woo recovery](../../apps/dashboard/src/woo-recovery.ts) and
[payout builder](../../apps/gateway/src/split/payout.ts). It informs fault
placement, not a rule that every current behavior deserves to pass.

[Research 50](50-commerce-correctness-test.md) records valuable prior checks
and their omissions. It does not certify this protocol's combined scenarios.

This plan does not certify chain/provider security, a disaster-recovery restore,
all browser/mail-client combinations, production capacity or carrier delivery.
Those need their own evidence. It does include how their visible failures
affect a current buyer or merchant; naming an external dependency does not excuse
a false success or lost obligation.
