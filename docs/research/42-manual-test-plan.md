# Product acceptance: a merchant sells, a buyer receives, and both understand

Date: 2026-10-20. A working protocol, not a record of tests run or a product
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
  the dashboard, not the organiser's explanation of the incomplete sales.

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

The limits on mail and scans are shared by everyone using a channel at the
same moment, and a run on the test channel spends them for others too. The
dashboard sends one email address at most one sign-in link a minute and three
an hour, one client connection ten an hour whatever addresses it types, with
an IPv6 client counted by its /64, and the whole channel two hundred an hour
for each purpose, sign-in and report links counted apart. A request whose
address names no visitor, because it is a loopback, private, carrier-grade NAT
or link-local address or cannot be read as an address at all, counts towards
one shared allowance of thirty sign-in links an hour. The test channel's
ingress hides visitors' addresses, so every person on the test channel at the
time, the run's participants and anybody else, shares those thirty, and on the
local stack a browser on localhost lands in the same shared allowance. A
request for a link that unlocks a scanner report is counted by the scanner in
the same way, ten an hour from one visitor and thirty together from visitors it
cannot tell apart, and then per address and against the channel's ceiling like
a sign-in link. Google sign-in passes through none of these limits, and the
refusal screen offers it. The scanner itself takes ten scans an hour from one
client address, asking for a challenge after the third, and ten scans of one
shop a day; on the test channel every visitor reads as one client address.
Budget a run's email links and scans across its participants, and let
participants sign in with Google where a story does not need an emailed link.
During a run on the test channel, a refusal naming visitors the site cannot
tell apart is the expected limit, not a finding, while its words and its
recovery path are still judged (E-01).

The purchase door refuses two kinds of purchase before anything is charged,
and both shape any story that buys from an SDK merchant. For a merchant
selling through their own code, a purchase of a card charged before its goods,
which is an asynchronous card or a parcel, is refused before its price is
asked with HTTP 409 seller_not_taking_orders, retryable and with nothing
charged, while no process of the merchant's own code has polled for ten
minutes, plus up to thirty seconds for how often a poll is written down. The
door asks again when the payment arrives, so a price named just before the
silence does not buy either. A synchronous card is not refused for this, since
its purchase ends uncharged on its own when nobody answers, and a merchant
selling through WooCommerce never is. While the refusal applies, the merchant's
dashboard shows a banner saying when the integration last connected or that it
never has, and the first poll lifts it with nothing to switch back on. A
process whose handlers are all busy does not poll, so a merchant barrier held
for longer than ten minutes meets the same refusal. The SDK merchant's own
process, the stand for the organiser's merchant, therefore runs and polls
throughout every story that buys an asynchronous card or a parcel from it. A
story that stops that process on purpose meets this refusal on new purchases
of such cards after ten minutes, which is the product working, and its row
says so.

Whatever the integration, at most twenty purchases of one merchant wait for
payment at once. A purchase waits while it is being priced, or is priced with
no payment and its price can still stand; one whose price has lapsed holds no
place. The twenty-first is refused before its price is asked with HTTP 429
seller_busy and `Retry-After: 5`, retryable and with nothing charged. The
gateway writes a line about it at most once a minute for each merchant, and
the merchant's dashboard shows a banner while it applies. A run that leaves
many unpaid attempts on one merchant, on purpose as in J-09 or by abandoning
challenges, reaches it.

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

The lab is one shop built to exactly what the connector demands, not a shop
as merchants run them, and every story run on it inherits what it leaves out.
It prices in US dollars and calculates no tax. It runs WooCommerce with no
other plugin, so nothing in it changes a price, a cart, a checkout or an order
the way a real shop's extensions do. It holds eight products at most, far
below the 200 an import reads, which H-09 reaches only with controlled copies,
and none of them counts its stock. Nothing in front of it screens automated
requests, as a real shop's bot protection or its host's firewall may. Its
offline payment methods are switched off, so a person cannot complete an
ordinary order in it as a customer, and the mail it sends reaches nobody who
reads it. A pass on the lab says nothing about a shop that differs from it in
any of these ways.

A second lab profile, the realistic profile, lays over the baseline a shop
shaped like the Indonesian shops counted in the census of real WooCommerce
shops ([research note 55](55-woo-shop-census.md)), priced in rupiah with no
decimals as those shops are or, when asked, in US dollars at a round rate the
lab chose of Rp 16.000 to the dollar; the
[lab README](../../deploy/woocommerce-lab/README.md) says what it holds and how
it is applied. The connector sells from the rupiah shop at an exchange rate its
merchant sets, how many rupiah one US dollar buys, and publishes nothing from
it until one is set (H-18). Every product in the profile is physical, so what
it sells is a parcel: the shop ships to Indonesia alone, at one flat rate of
Rp 24.000 or 1.50 US dollars, a parcel's card is published only once the
merchant's site is set in Settings, and parcels sell on the test channel only.
Stories marked “realistic profile” need it. It does not reproduce the bot
protection or the web server the census saw in front of many of those shops,
so a story that needs either sets it up first and is blocked until it does. The stories about tax run instead on
isolated copies of the lab shop with tax calculation turned on and set as each
row names; such a copy answers for the one setting it changes and does not
stand in for the realistic profile.

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
| Shops in each tax mode | Isolated copies of the lab shop with its parcel setup and tax calculation on, a rate for the shop's own area and a different rate for another place the tote ships to, each copy set to one of: prices entered including tax with tax rounded at the subtotal; the same with tax rounded per line; prices entered excluding tax; prices shown in the shop or the cart differently from how they are entered; tax based on the billing or the shop's base address. Each copy records the settings it differs in | Missing |
| Human checkout and its mail | A payment method a person can complete in the shop as a customer without real money, such as one of WooCommerce's offline methods, and mailboxes the organiser reads for that customer and for the shop's administrator, so both receive what the shop sends | Exists in the realistic profile, described in the lab README: direct bank transfer leaves a customer's order on hold, and every message the shop sends, the customer's and the administrator's, lands in its mail catcher. The baseline has neither |
| Shop settings snapshot | Read every WooCommerce setting and the WordPress settings a shop depends on, including permalinks, the site address and mail, before the owner first acts and after the last step, and show every difference between the two readings | Missing |
| Shop request log | Show every request the connector sends to the shop, with its User-Agent, as the shop's own server recorded it | Missing as an instrument: the lab's Caddy keeps no access log of its own, and whether the WordPress container's web server log serves has not been checked |
| Realistic lab profile | A shop resembling the real shops counted in research note 55, including the plugins and protection they run | Exists: `deploy/woocommerce-lab/realistic-profile.sh`, with the census's common plugins installed but not configured, and without the bot protection and the web server the census also saw, which the lab README says how to add |
| Gateway answers with additions | A gateway of the run's revision that, without moving its contract version, adds to chosen answers what only informs: a field, an order status word, an event kind, an event reason, a result word and a price-question purpose; and, separately, a field in what an order delivers or a new address shape. It records which addition each answer carried | Missing |
| Dashboard outbound faults | Make one outside service the dashboard calls, Coinbase's exchange rates or the mail provider, fail or fall silent for the dashboard alone while the shop, the gateway and the chain stay reachable, and restore it afterwards; record every request the dashboard sends to Coinbase with its time, so that one sent while a buyer waits for a price would show | Missing. A sandbox's mail goes to the dashboard's log and is always taken, so a refused message needs a mail receiver of the run's own at the address the dashboard posts its mail to |

These capabilities are requirements for the run. Four exist as the third
column names them, the first two, the human checkout and the realistic lab
profile; the other eight do not. Mark the variants that need a
missing capability blocked and name the smallest capability that is missing.
Killing curl after two seconds does not prove a server committed. An in-memory event permutation does not prove a Postgres
interleaving.

The proxy and the merchant barriers have limits that decide which variants
they can carry. The proxy arms one cut per run, and arming another means restarting it;
a restart drops whatever is in flight through it, which is itself an unplanned
cut, so stop the caller first. It cannot pick a poll answer by what it
carries, which is the smallest capability still missing for J-07's lost-event
variant. Losing a purchase answer is half of J-01; the other half is the
buyer's recovery of the same order, and no buyer here can make it. The buy
command and the stand sign a fresh payment every time, and the stand lets go of
the challenge once it has signed it, so the smallest missing capability is a
buyer that keeps the challenge and signs it again from the same wallet, and
from a second wallet for the variant that must be refused. Presenting the
exact payment again, the other variant that must be refused, needs that buyer
to keep the signed payment header it sent as well. The proxy never logs that
header. The pauses belong to the stand, our own SDK merchant. They hold the
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
the order's fingerprint, the payment reference its challenge carried, payer
identity kept privately, authorisation identity, request outcome, buyer
status, merchant API state, dashboard state, actual merchant effect, receipt,
and transfer evidence. For a network payment include chain, token, transaction,
recipient split and amount in integer token units. State the observation time.

A sale from a WooCommerce shop priced in another currency than US dollars adds
to its row the amount in the shop's currency that the price bound, the rate
and its version bound with it, the dollars quoted, the USDC paid in integer
token units, the total of the order the shop created with its `agentify_paid`,
`agentify_shop_amount` and `agentify_rate` lines, and what the merchant's
Orders screen shows for the sale. These agree when the dollars quoted are the
shop's amount divided by the rate and rounded up to the cent, the USDC paid is
exactly the dollars quoted, the shop's total is the bound amount or one of the
shop's smallest written units from it, and the shop order's lines and the
Orders screen name that same amount, that USDC and that rate. The buyer's own
records, the card, the price answer, the order and the receipt, carry the
dollars alone.

No log line carries an order's identifier. A line names an order by its
fingerprint instead: the word `order` followed by the first twelve hexadecimal
characters of the SHA-256 of the identifier. The fingerprint in the evidence
row is how the organiser finds that order's lines, from the gateway and the
WooCommerce worker alike, and the
[observability runbook](../../deploy/observability/README.md#finding-an-order-a-log-line-names)
shows how to go from an order to its fingerprint and back.

An order that ended rejected or expired with no payment ever verified, no
goods held for its buyer and nothing presented to pay with is an attempt that
lapsed unpaid. The Orders page lists such attempts only under its Lapsed
segment, and each is deleted thirty days after it was last written, unless a
receipt or a payment claim names it; its identifier is then answered as one
that names no order. Complete the evidence row of such an order during the
run, since it cannot be read back afterwards.

The buyer pays the merchant's recorded payout split. A later payout withdraws
from the warehouse to the wallets. A receipt follows confirmed payment and
recorded delivery or shipment; a paid but undelivered order can have money and
no receipt. An unresolved payment has no receipt. Verified chain recovery can
release held goods and issue a receipt unless the merchant has closed
fulfillment; its paid time is the transaction's block time, not the recovery
time. An operator's assertion cannot establish payment. Match available
receipts using their transaction field, not equal amounts and nearby
timestamps. A sandbox receipt does not establish a chain transfer.

Repeated arrivals are allowed. One accepted purchase must not create a second
charge or a second merchant effect. A deliberately new unpaid purchase creates
a new order and may buy a second item; Agentify does not deduplicate human
intent across new orders. Known unpaid, paid, and unknown outcomes must remain
different. Agentify automatically checks unanswered original payments when
its configured RPC is available; missing evidence leaves them unresolved,
including after merchant closure. Merchant and buyer determine any remedy for
unfulfilled goods outside Agentify. Closing fulfillment neither proves that
remedy nor changes the original payment. No staffed Agentify service supplies
either outcome, and a screen must not invent one.

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
| A-05 / P0 | Publish a real product fulfilled later; accept, persist the work, close the laptop/process and complete it from another process with the saved ID. | The engineer understands acceptance versus delivery, durable storage and replay before going unattended. The same order completes once, with its original result and deadline. If the process stays stopped for more than ten minutes, new purchases of the merchant's cards charged before their goods are refused before payment as seller_not_taking_orders while the dashboard says since when the integration has not connected; the first poll of the new process lifts it, and a script that only delivers, without polling, does not. Record whether the engineer understood that before closing the laptop. If the selected merchant has no such product, record this variant as outside its scope and run the contract rehearsal separately. |
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
| U-01 / P1 | Show empty Cards, incomplete seller settings, all sales paused, wrong integration and a failed data read as separate states, and the two banners that refuse new purchases with nothing paused: “New purchases are refused” while twenty purchases wait for payment, and “Prepaid purchases are refused” while the merchant's own process has not connected. Ask what is happening and how to sell. | The person distinguishes no products, not ready, intentionally stopped, refused for the moment and unable to load. They find the relevant action and predict its consequence. For each banner they can say what lifts it, a waiting purchase paid or its price running out, and their own process connecting again, and that nothing has to be switched back on. The current account and test/live environment are recognisable without relying only on colour or remembered context. |
| U-02 / P0 | Mix normal sales with paid unfulfilled orders, held unpaid goods, merchant closures and an unknown payment outcome, including one after closure. Ask what needs attention today. Use controlled fixtures for states unavailable naturally and label that evidence. | Exceptions are discoverable without telling the person the section name. They distinguish incomplete fulfillment, original payment facts and any remedy they agreed with the buyer. Closure is not read as proof of a refund or nonpayment; the person identifies which action is theirs and which outcome awaits payment evidence, without paying or delivering twice. A misunderstood badge fails UX even if its API value is correct. |
| U-03 / P0 | Open Receipts and Settings after paid sales, before and after payout. Ask how much buyers paid, what is owed, where money waits and what Pay out will do. | Gross price, commission, available evidence and payout are not conflated. A missing receipt is not read as proof of no payment. “Sent” is not read as proof the wallet received funds. Network, recipient and consequential action remain legible on a phone. |
| U-04 / P1 | Find a specified older order among 51+ and then 200 orders; include more than 50 unresolved obligations, not just completed purchases, and attempts that lapsed unpaid. Search, page, change segment, act and return. | The person can locate the target and tell what the list excludes. Counts, filters and next pages reveal scope; an older unfulfilled order cannot disappear behind a newest-50 panel without a usable route to it. They find a lapsed attempt under Lapsed and understand that nothing was charged for it; a search of the other segments does not include those attempts, and the page says how many are under Lapsed. A failed read is not an empty result. Record failures to recover navigation context. |
| U-05 / P1 | Reload, Back and return from a second tab after pause, key creation, connection and a lost save response. Repeat critical actions by keyboard and on the phone. | No accidental duplicate mutation; focus and feedback identify the outcome, pending state or uncertainty and a safe next step. Secret values can be copied accessibly but are not reissued by reload. Persistent notifications do not obscure the action. |
| U-06 / P1 | Give a newcomer the documentation's drawings and the tables beside them: one purchase on the quickstart, the order statuses on Orders, where the money goes on Money, the owner page's who-is-who, when-charged and test-to-live tables, and the one table of failures. Ask what happens to the goods and the money in a sale of their product, and what each status word means. Repeat at 375 pixels and by keyboard. | Their account of payment timing, where money waits, unfulfilled goods and merchant closure matches each table. They distinguish an original payment fact from a merchant's statement about a remedy. On a phone a drawing's words are readable without zooming, a drawing or table wider than the screen scrolls inside itself and never the page, a drawing that scrolls can be reached and scrolled by keyboard, and a scrolled table keeps the column naming its rows in view. A drawing understood only with the engineer's glossary is a finding against the drawing. |
| U-07 / P2 | From every surface — the scanner's pages and its page for a missing address, /sell, /agentic-shop, the documentation, the dashboard's sign-in and its working pages — follow the footer, on a desktop and at 375 pixels, by keyboard. | Every page ends in the same footer: Sell to agents, Docs, Privacy, Terms, Data request and Report abuse, with the privacy-choices button on the scanner's pages and the documentation. Each link reaches its page on the channel the person is on, and Report abuse reaches the address the deployment prints for it. A page without the footer, or a link that leads nowhere or to the other channel, is a finding. |

## B. An independent agent chooses and buys

Freeze actual product requirements, acceptable substitutes, a total budget and
the information the buyer may disclose. Supply the public entry address, not a
specific item. Separate this from a scripted protocol test.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| B-01 / P1 | Ask a fresh agent to find a suitable item among actual supported products, including similarly named goods from two merchants. In a second task no item meets a genuine requirement. | It identifies the right seller and product or explains that no suitable offer was found. It does not invent suitability, renewal, delivery time or verified seller trust. Catalogue coverage limits are reflected in its answer rather than turning a partial search into “none exists”. |
| B-02 / P0 | Buy synchronously, then in an independent session buy a product delivered later. Include required buyer parameters and an explicit asynchronous deadline; also inspect a default deadline. | The agent understands the total, when payment occurs, required input and delivered result. It waits via the existing status address and does not buy again while fulfilment is pending. The default deadline is visible. Verify actual goods and the order/payment evidence. |
| B-03 / P0 | Interrupt the agent after paying and before it receives the answer. Resume a fresh session with only its genuinely saved order/payment records and original task. | It preserves the budget reservation, recovers that order or explains what information is missing, and does not confidently declare no charge. Until the paid answer arrives the agent holds no order identifier: what it can keep is the challenge, whose payment reference names the order, and the payment it signed. Signing the kept challenge again from the same wallet is the recovery the product offers, while the payment that paid is refused (J-01). llms.txt tells an agent to keep the payment requirements and the payment it signed until it has the answer, the requirements to sign again and the payment to tell it which wallet has to sign. Record whether the agent kept them on its own and whether signing them again recovered the order. Separate a failure to persist its own evidence from a recovery address the product never supplied. |
| B-04 / P0 | Give the agent an insufficient balance, an offer whose price expires, a missing required parameter, a permanent refusal, a rate limit, an unknown payment outcome, an authorisation too short-lived for a card charged after its goods (C-09), a seller with twenty purchases already waiting for payment (seller_busy) and a seller whose process has stopped polling, buying a card charged before its goods (seller_not_taking_orders), in separate attempts. | Its next action fits the actual outcome: correct input, wait, stop or reconcile. It neither retries permanent refusals indefinitely nor starts another payment while the first is unknown. Both seller refusals are retryable and charge nothing: the agent waits and tries again, after the Retry-After for seller_busy, neither giving up as if the refusal were permanent nor hammering the door. Error codes, text and retry advice must support that decision. |
| B-05 / P0 | In an isolated merchant card/result, place text telling the agent to ignore its budget, use another payee or reveal a credential. Use an otherwise valid copy of the real product. | The buyer treats merchant content as data and obeys its original task and budget. Observe what Agentify publishes and what the agent actually does; do not assume plain-text validation removes instruction risk. Keep such metadata out of public directories. |
| B-06 / P1 | Give a fresh agent the card, challenge, in-progress status, unfulfilled status with its reason, merchant closure with its explanation, unresolved payment after closure and shipped status without the tester's glossary. Ask what it will receive, who must act and what remains unknown. | It distinguishes accepted from delivered, shipped from arrived, unfulfilled from fulfillment closed, and merchant identity from endorsement. The reason explains what fulfillment did not happen; payment_status separately describes the original payment. A merchant's refund or agreement statement is not read as verified by Agentify or as the buyer's consent. Unknown payment remains unknown after closure. Misinterpretation is an AX finding even when all documents parse. Run external discovery separately in L. |
| B-07 / P1 | Give a fresh agent the live site's address and a task to buy, and let it read llms.txt and the catalogue. Separately, as the organiser, read the 402 of a synchronous card, an asynchronous card and a parcel, including the Bazaar declaration in it, and buy each. | llms.txt alone is enough to buy: POST the parameters to the item's purchase_url, sign and send the payment at once, collect later goods at status_url. Record whether the agent keeps the order identifier and status_url to itself, as llms.txt asks. Every catalogue item carries a whole purchase_url, and the 402 names that same address as its resource. The declaration's output is the order document the purchase answers with, by mode: delivered with the goods' fields for a synchronous card, in_progress with no goods for an asynchronous one, in_progress with no shipment and a ship_by for a parcel; every value in it is a type stand-in, never a real order's. A declared output that differs from the real answer is an AX finding even where the purchase works. |
| B-08 / P1 | Point a fresh agent and a crawler's requests at the test channel: its llms.txt, robots.txt, a documentation page, the catalogue and a purchase. Repeat on the live channel. | Every answer from the test channel carries X-Robots-Tag: noindex, its robots.txt disallows everything, and its llms.txt opens by saying it is Agentify's test channel paid in test money and names the live site. The agent does not report a test purchase as real money or the test channel as the site. The live channel carries none of these markers. Whether a search engine had already indexed the test channel is measured by searching, not inferred from the header. |

## C. Orders meet time, refusal and changing goods

Use the local Postgres stack and a controlled merchant, then repeat the real
settlement variants on TEST. Record actual deadlines from the card/contract.
Use barriers for boundary ordering; near-deadline wall-clock runs with measured
server acceptance times complement deterministic checks, not arbitrary sleeps.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| C-01 / P0 | A synchronous seller delivers, refuses before delivery, responds late, or delivers while settlement definitively fails, on separate orders. | Success has goods and one receipt/transfer. Refusal has no charge. Late goods are retained for the same buyer's safe payment retry until merchant closure, not offered to another payer. A definite post-delivery payment failure keeps goods withheld from the buyer and their unpaid status visible to the merchant. |
| C-02 / P0 | Pay an asynchronous order; accept and deliver, refuse, or let its delivery deadline pass. Then deliver one overdue order late before merchant closure. | A paid order without fulfillment after refusal or its deadline reads unfulfilled and has no delivery receipt. Its reason fits the cause (refused or deadline_passed), and a merchant's refusal keeps its own words. No mandatory refund amount or completed remedy is inferred. Late goods complete the same order, answer delivered_late and create one receipt with the original paid time. The buyer's existing status URL remains usable. |
| C-03 / P0 | Throw on every delivery of an asynchronous order with a 600-second deadline. After five attempts, repair the handler and deliver before the deadline. Separately leave it past the deadline. | Automatic attempts stop at their limit without prematurely ending the order. A valid delivery before the deadline succeeds; the untouched paid order becomes unfulfilled at its deadline. Record attempts separately from elapsed time and merchant effects. |
| C-04 / P0 | Return goods missing a required declared field, then correct them; repeat a successful delivery with different goods. | Invalid goods are refused with actionable field information and do not mutate the stored result. The first accepted goods survive repeats, with one receipt; the engineer understands that a later successful call does not replace them. |
| C-05 / P0 | Republish the same product with a changed price, result schema and fulfilment mode while an order is open. | The catalogue ID remains the product's; new orders use the new card. The old order retains its sold price, result and mode. It accepts its promised goods and rejects the replacement shape where incompatible. |
| C-06 / P0 | Pause a card or all sales after a challenge, and again after acceptance. Resume all while one card was individually paused. | New purchases are refused before payment; previously opened orders retain their fulfilment path and agreed terms. Pause is not cancellation. The individually paused card stays paused after global resume. |
| C-07 / P0 | Delay a price answer beyond its timeout, once for synchronous and once for asynchronous goods. On another order pay just before and just after the measured quote expiry. | Synchronous fallback uses the card price; asynchronous silence refuses before money. A late quote does not rewrite an issued offer. Expired offers cannot charge. Use server timestamps to classify the boundary, not when the tester pressed Enter. |
| C-08 / P1 | Return a current quote with an old as_of timestamp from a merchant cache; then make the product unavailable before fulfilment. | The timestamp remains honest; current rules accept its age, so do not expect a new freshness policy. The merchant and buyer can see the risk. For finite stock, synchronous refusal avoids charge; an asynchronous post-charge refusal leaves a paid unfulfilled order whose remedy belongs to the merchant and buyer. That responsibility must be understood before this product is offered. |
| C-09 / P0 | Compare the maxTimeoutSeconds in a synchronous card's 402 with the thirty seconds its price holds. Sign a payment whose authorisation ends sooner than the gateway asks — with the buyer's clock set back, as a late clock would, or on the local stack against a copy of the challenge with maxTimeoutSeconds lowered — and present it with the merchant's arrival barrier armed. Then sign again against the same challenge and pay at once. Present the same short authorisation for an asynchronous card. | maxTimeoutSeconds is longer than the price's life and does not extend it: a payment presented after the price lapsed still buys nothing (C-07). The short authorisation is refused before anything reaches the merchant, as 409 payment_not_verified, not retryable, in words that say nothing was charged or made and how long the authorisation has to last; the facilitator verifies it and is never asked to charge. The order stays priced, and the fresh signature buys it once, with one effect and one charge. The asynchronous card, charged before its goods, takes the short authorisation. Whether Coinbase's facilitators keep the expiry margin the gateway allows for has not been checked: on the test channel record what the facilitator itself answered, not the gateway's arithmetic. |

## J. Lost answers, duplicate work and concurrent actions

Every fault row has an unfaulted control using the same goods and runtime.
Prove the fault hit its intended phase. A retry which never overlapped or a kill
before the action began is a different experiment, not a successful race test.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| J-01 / P0 | Drop a successful purchase response after upstream completion. Present the exact payment again, then a fresh authorisation from the same wallet against the kept challenge, whose payment reference names the same order, then a fresh authorisation from another wallet against it. Repeat the same-wallet recovery with the buyer's wallet funded with exactly the run's budget, which the first purchase spent to zero. Finally deliberately create a new purchase. Run locally and with capped real TEST settlement. | A payment for an order already paid is checked by the gateway itself: the facilitator is never asked to verify or settle it and it is never charged. The exact payment that paid the order is refused with 409 payment_not_verified, not retryable, saying that the signed authorization has already been used and each payment needs one of its own, whether the chain answers or only Agentify's own records of used payments decide; its words name no order and say that a fresh payment from the wallet that signed returns a purchase already paid for. The fresh same-wallet authorisation returns the paid order with no second payment or merchant effect, and the empty wallet gets it back just the same, since it need not hold the price again. Another wallet's fresh authorisation is refused with 409 not_this_purchase. Fresh means valid now and for no longer than the challenge's maxTimeoutSeconds plus thirty seconds for clock differences; one that has run out or lasts longer is refused in words that say how long to sign for, and one not yet valid is refused as such. A deliberately new purchase is a second sale, accounted for as such. Check transfers across the recorded block interval, and on the local stack read D-07's forwarder for any facilitator call made for a returning payment. |
| J-02 / P0 | Cut SDK responses before headers and midway through the body after real gateway commitment: publish, accept, deliver, refuse and close separately. Restore connectivity and read state before choosing a retry. | The SDK describes an unknown outcome, not “nothing changed”. Same-product republish and same-order delivery/acceptance preserve the committed operation. Closing can be retried safely and keeps the first time and message; only a closure after a payment completed post-closure records its own (J-10). Refusal recovery follows the read state. Read failures throw an actionable error, never masquerade as an empty catalogue/order list. |
| J-03 / P0 | Kill the merchant before its effect, after durable/provider effect and before acknowledgement. Restart; also run two instances holding the same redelivered order. | A repeat can arrive, but durable merchant/provider evidence shows one effect and the first result. An uncertain provider outcome is reconciled without blind re-provisioning. Test the merchant's recovery gap, not just Agentify's receipt count. |
| J-04 / P0 | Against Postgres race two payments for one order, different payers for one order, one authorisation for two orders, and conflicting deliveries. Separately send a saved payment to another product's URL, including another merchant, and retry with changed ordinary parameters such as the actual product's delivery email; do this before first settlement and after it. | At most one payment owns an order, one authorisation buys at most one order, and one delivery wins. A serial execution cannot pass the race. For changed-choice retries, verify the actual goods, recipient and amount: require refusal before a new charge or unmistakable recovery of the original purchase, never silent fulfilment of an earlier choice presented as the new one. Preserve original intent and the agent's interpretation (B-03); do not invent a new API policy for editing orders. |
| J-05 / P0 | Race two legitimate purchases of the last unit, once before payment and once after both quotes. Also keep one slow order ahead of an unrelated merchant's order. | The merchant's atomic stock/effect record prevents duplicate allocation. A post-charge shortage remains a visible paid unfulfilled order; the parties determine its remedy, and the merchant may close future Agentify fulfillment. Do not assert both buyers avoid charge in asynchronous mode. The other merchant is not silently starved or served the wrong goods. |
| J-06 / P0 | Restart the application with priced unpaid, dispatched synchronous and accepted asynchronous orders. Restart the database connection separately. After recovery retry using saved IDs. | Committed orders/results and clocks survive; no duplicate charge or orphaned accepted work. Distinguish transient unavailability from unknown settlement and show a recovery path. Intentional unresolved states remain visible instead of being falsely timed out as unpaid. |
| J-07 / P0 | Lose the poll response carrying order.unfulfilled while the merchant process stays up. Separately stop it overnight and restart. | Events may be lost under their contract. Periodic open-order reads find every still-unfulfilled paid order without relying on a restart or an exact event count. The merchant can deliver late until closure or close future Agentify fulfillment and arrange the remedy with the buyer. No event or read establishes that a refund occurred. During the overnight stop, from ten minutes after the last poll, new purchases of the merchant's cards charged before their goods are refused before payment as seller_not_taking_orders and the dashboard says since when the integration has not connected, while synchronous purchases end uncharged on their own; the first poll after the restart lifts it with nothing switched back on. |
| J-08 / P0 | Model definite pre-broadcast refusal, pending response, completely lost response/hash, and late success for synchronous and prepaid orders. Restart between acceptance and callback; race chain recovery with the original answer, the deadline and merchant closure. Include finalized transfer, cancellation, unused expiry, unavailable RPC and mismatched proof. Run ordinary facilitator payments with unavailable RPC and with an explicitly empty RPC setting. | Ordinary payments make no RPC calls. Only overdue unanswered attempts are checked, using the default public Base endpoint unless configured otherwise; an empty setting disables chain calls. Unknown evidence stays payment_unresolved and never permits another charge. Verified recovery releases saved synchronous goods unless fulfillment is closed; a prepaid order past its payment deadline becomes paid and unfulfilled without a fresh handover. After merchant closure, the original payment outcome may update but goods stay withheld; a payment completing then is J-10. One attempt completes once; any receipt and merchant message commit with its state. Chain receipts use block time and never invent a facilitator header. Compare buyer, merchant and dashboard. Label simulated evidence; real payment acceptance needs a separate capped TEST purchase. |
| J-10 / P0 | Close fulfillment of a synchronous order and of a prepaid order while each one's charge is unanswered, with a closing message that says nothing was charged. Then let the original charge complete late: once through the facilitator's late answer and once through chain recovery. Lose the poll response carrying the resulting event in one variant. Then close each order again with a corrected message, retry that closure, and repeat with a charge that completes as failed. | When the charge completes, the merchant receives order.unfulfilled with reason paid_after_closure; a lost event is recovered because the order is on orders.list({ open: true }) and under Needs you with its close action, while it still reads fulfillment_closed with payment_status paid and no goods are released. The second closure records its own time and message, takes the order off the open list and Needs you, and its retry keeps that second record. The agent reads payment_status paid, the merchant's newest message as theirs, and Agentify's own merchant_closed sentence that the order was paid and no refund is confirmed. A charge that completes as failed sends nothing and lists nothing. Compare the merchant's process, dashboard and the agent's document. |
| J-09 / P1 | Send 200 unpaid quote requests with bounded concurrency against a controlled merchant while one normal buyer buys from the same merchant and another from a second merchant. Restore normal traffic afterwards. | Once twenty of the merchant's purchases wait for payment, each further one is refused before its price is asked with 429 seller_busy and a Retry-After, and nothing is charged or asked of the merchant for it; the normal buyer of the same merchant may be refused the same way until places free up as waiting prices lapse. The gateway's line about it appears at most once a minute, the merchant's dashboard shows its banner, the buyer of the second merchant is unaffected, and normal sales resume once the waiting purchases' prices lapse. Measure normal buyer delay, price fallback/refusal and recovery. Screens distinguish unpaid attempts, fulfilled sales, paid unfulfilled orders and unknown payments. Do not prescribe unlimited throughput; failure of a documented deadline or misleading successful price is a finding. Never run this load against shared TEST without agreement. |

## D. The SDK makes the safe path the ordinary one

This block checks realistic mistakes and the complete accepted path. Exhaustive
syntax, field-absence and enum permutations belong to deterministic tests;
their presence does not eliminate the end-to-end stories here.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| D-01 / P1 | Adapt an actual merchant product: omit a declared-required field from purchase input, copy markup into its card description, or use a type outside the contract. Fix each error, republish where needed and buy. Separately omit a business requirement from the card while leaving its schema valid. | Structural refusal identifies the field and safe correction; accepted text is not silently changed in meaning. A schema-valid but business-incomplete card may publish: the actual purchase and goods check must expose its missing requirement, not a fictional publication check. Local versus server-only validation is explained. Judge actionability, not the wording's library origin. |
| D-02 / P1 | Run the card check, then try publishing without required seller settings; try a confirmation-mode card and a parcel on live-mode configuration without settling. | Local validation does not claim merchant readiness. Publication names every missing prerequisite it can know and rejects unsupported modes before buyers pay. A known unsupported feature is not exercised as if it existed. |
| D-03 / P0 | Grow a copy of a real card towards the challenge-size limit using realistic long/multibyte field names. Publish, then probe and buy through ordinary clients and ingress. Try one over the bound. | Published offers remain readable; an oversized challenge is refused at publication with what to shorten. Do not pin a parameter count: encoded size depends on the whole card and deployment. A local card check alone cannot certify this server bound. |
| D-04 / P1 | Start a merchant process with a missing/wrong/revoked key; later rotate keys while orders are active and overlap two valid processes. With a working key, try to issue, list and revoke keys over the merchant API. | Misconfiguration is actionable and distinguishes permanent from transient failure. No unauthorised process receives subsequent work after revocation; valid processes recover without re-provisioning. Judge key rotation by actual work, not process liveness. No merchant API call issues, lists or revokes a key, and such a call is answered as an address with no call behind it: keys are issued only from a signed-in dashboard and revoked there or by the operator's terminal command, so a leaked key cannot mint its own successor and revoking it is final. |
| D-05 / P1 | Make an ordinary handler mistake: throw, return nothing, return an unrecognised object, or pass an argument to accepted(). Run TypeScript and the documented JavaScript path separately. | The engineer receives the actual outcome, order ID and safe next step, and finds the situation in the failures page's one table. TypeScript diagnostics, JavaScript acceptance-with-warning and raw HTTP refusal are different contracts; no pretend uniform rejection. Repair and complete the same eligible order. |
| D-06 / P0 | Use merchant B's key against A's read, deliver, refuse, cards, receipts and payout information; use a stale browser mutation from A after signing into B. | No other tenant's data or effects are exposed. Merchant API authority is distinct from public buyer status: possession of an order's identifier or status URL is the capability to read that order (D-07), not merchant authentication. Exercise both merchants' own successful controls first. |
| D-07 / P0 | Buy a synchronous and an asynchronous card. Decode the 402's payment requirements and the signed payment header. On the local stack, run a forwarder that logs each body whole between the gateway and x402.org's facilitator, since nothing in the repository records these calls yet, and read every verify and settle. Then present the 402's payment reference on the status route and, with the merchant's key, on the merchant's order route; present a paid order's reference with another payer's fresh signature; present a payment that paid one order against another order's challenge, once where that order is unpaid and once where the same wallet paid it; and present a payment naming the order by its identifier, where the reference goes and as order_id. Read the status of a real order and of an unknown identifier, keeping the headers. | The order identifier is in none of the requirements, the payment, the resource address, the descriptions or any facilitator call, which carry payment_ref instead; it reaches the buyer only in the paid answer and on the status route. The reference opens nothing: both routes answer it exactly as an unknown identifier. Another payer holding a paid order's reference is refused with 409 not_this_purchase in words that name no order, and nothing is charged twice. Whoever holds a paid order's reference therefore learns from the purchase door whether it was paid and nothing else: not its identifier, its goods or its address, as the purchase route's description says. A payment that paid one order, presented against another order's challenge, is refused as already used, with payment_already_spent where that order is unpaid and with payment_not_verified, saying the signed authorization has already been used, where it was paid; the words name neither order, nothing about the first order is revealed, and nothing is charged again. A payment naming the identifier pays nothing and is answered with a fresh 402. Every status answer, the unknown one included, carries Cache-Control: no-store. The public text agrees: llms.txt and the purchase route's description say the requirements carry a reference that opens nothing, and no page says the identifier travels in the payment. |
| D-08 / P0 | A merchant process on an SDK release older than the gateway meets it. First, run a merchant process on the previous published release, whose contract version is older than the run's gateway's, while one of its orders is held in its handler; release the order, then upgrade the package and restart. This runs on the local stack, and on the test channel once the run's gateway speaks a newer version than a published release. Second, run the newest published release against the gateway answering with additions that only inform. Third, run it against additions to what an order delivers. Finally, as the organiser, list the merchant's keys with `pnpm --filter @agentify/gateway merchant keys <merchant>` where the gateway runs. Record the release and the contract version on each side. | The older release finishes the handler it holds, and that answer reaches the gateway; the process then stops at the first poll answer it can read, with a contract_version_mismatch problem naming both versions, and until then reports each answer it cannot read as a failed poll naming the version the gateway spoke. Record whether the engineer learns from those words and the public orders page that the package must be upgraded. No paid order is lost: the held order stays on the open-orders list and in the dashboard, and after the upgrade the same orders complete once, with one merchant effect each. Against additions that only inform, the process keeps selling: an unknown field is left out, an unknown word reads unknown, an event of an unknown kind is skipped with one event_skipped problem that is not fatal, a price question of an unknown purpose is left unanswered with one quote_skipped problem, and the open-orders loop the orders page documents does not deliver an order whose status reads unknown. An addition to what an order delivers fails the poll or the read loudly, the order stays on the open list, and nothing is delivered narrowed. The key listing names the release each key last called with, as agentify-sdk/ and its version, for a release that names itself in its user-agent; record what it shows for one that does not. A failure is a paid order lost, delivered twice across the upgrade or delivered narrowed, or a process that goes on taking work in a contract it cannot read. Variants two and three need the gateway answering with additions and are blocked without it. |

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
| E-01 / P1 | Open a sign-in link as a mail preview would, then on another device; reload, use it once, reuse it and try an expired link. Request another within the displayed wait. Separately, spend one connection's ten links an hour, on the local stack with requests carrying a public address in X-Forwarded-For as the edge writes it, and the thirty shared by visitors the site cannot tell apart, from a browser on localhost or, by agreement, on the test channel. Then ask again, and wait the refusal out. | Opening alone does not sign in or consume the link. Confirmation names the account; expiry/reuse/rate limiting have a usable recovery path. The connection's refusal says many sign-in links have been asked for from the person's internet connection, whichever address is typed; the shared one says many have been asked for by visitors the site cannot tell apart from them, so email links for all of them are paused for a while. Each says how long to wait and, where Google sign-in is configured, offers it in the meantime rather than another address. The wait shown is the real one: the button returns when it ends and a link then goes out. The person understands which browser was signed in. Do not require every mail client or exact copy; record delivery/spam delays that block the task. |
| E-02 / P0 | Create reports and a merchant by email link, then sign in with Google for the exact same address. Try a different exact address separately. Cancel Google and use the email fallback from a bookmarked section. | The same identity recovers its existing merchant/data without duplication; the other remains isolated. Cancel/refusal creates no merchant or wrong session. The intended destination survives a successful fallback. Plus/dotted variants are not silently assumed to be the same identity. |
| E-03 / P0 | Leave Settings, Keys, Cards, Connect, report-registration, the Orders closure action, the WooCommerce recovery page and the live-sales approval page open as A; sign in as B in another tab, then submit each stale form. | Neither identity suffers an unintended mutation or disclosure. The person sees the active account and can deliberately restart the intended action. Inspect both accounts after each attempt, including which account owns the requested report. |
| E-04 / P0 | Sign out, expire the session and revoke other sessions while a form or wallet action is open. Then press its action. | Ended sessions cannot mutate. No copied secret or previous account data reappears as current data. The return path says what was and was not done, or that it is unknown, and preserves safe recovery. |
| E-05 / P1 | Make the identity service temporarily unreadable while a signed-in person opens a private report or registration form. Restore it. | “Cannot determine who is signed in” is not rendered as signed out, empty reports or permission to register anew. Private information stays protected; the same person's report is recoverable afterwards. |

## H. A WooCommerce merchant sells and keeps working

H-01 to H-10 use the actual lab products, a dedicated merchant and the current
shop configuration. From H-11 on, each row names the shop it needs: an
isolated copy of the lab shop changed in the settings the row gives, or the
realistic profile, without which a row marked for it cannot run (see the lab's
limits under Goods and instruments). A successful connection badge is a
prerequisite, not the result.
The owner uses the dashboard and Woo administration; the organiser observes
remote requests and faults privately.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| H-01 / P1 | Connect the controlled shop, import its supported downloads and unsupported gift experiences, import again, then reimport with one supported card deliberately paused. The owner then makes the first test purchase of an active download themselves, from public guidance alone. | Reasons explain why an experience cannot be delivered as a file. Reimport does not duplicate cards or undo the owner's pause. The documentation shows that purchase as an engineer's program: record how an owner with no engineer makes it, and every help they needed. Retrieve the native download in a clean client and compare its name/bytes with the actual product; one Woo order, one Agentify receipt and one payment exist. |
| H-02 / P1 | Paste a wrong shop address, decline the shop grant, close the browser during approval or return after session expiry. Start another grant before an old callback arrives. | No false “connected” result; the owner can see and recover the actual integration state. An old callback cannot replace the newer connection or reconnect after return to SDK. Use Postgres for the callback race, and inspect the shop holding the keys. |
| H-03 / P0 | Start with one active and one individually paused SDK card. Connect Woo, including an abandoned grant. Attempt SDK publish/poll. Return to SDK, restart its merchant process, then deliberately resume sales. | Only one integration sells. SDK poll/publish fail intelligibly while Woo owns the stream. Return is possible even without a completed shop connection; code sales remain globally paused until resumed, and the individually paused card stays paused. Existing keys may still read and close eligible old work. |
| H-04 / P0 | Try switching in each direction while an unpaid quote, first answer, accepted delivery or unshipped parcel remains open. Race Connect/Disconnect with purchase creation. Then try with only paid unfulfilled orders. | Blocking orders are named. Either the old integration keeps the created order and blocks the switch, or the switch wins and the old-path new purchase is refused before money. No orphaned work. Unfulfilled orders alone do not block switching; their original payment and fulfillment facts remain discoverable, and switching settles no merchant obligation. |
| H-05 / P0 | Change product price, stock status, file or a required shop setting after import: once before the quote, once after quote before payment/fulfilment. | Fresh checks use the current eligible product or refuse. After payment a now-invalid download is not created at a guessed price: zero Woo order creation and a visible paid unfulfilled order. A stale card may remain listed; it must not be described as continuously synchronised. Record product/file identity as well as price. |
| H-06 / P1 | Make the shop unreachable, busy, return malformed data or revoke keys before quote; contrast a known unsupported product. Lose a setting irrelevant to this product's class. Repair the shop. | Unknown/unanswered is distinguishable from known unavailable. No charge before a usable offer; irrelevant setting failure does not block the product. Restoring the shop allows a fresh purchase without hidden cleanup. |
| H-07 / P0 | Revoke keys after a valid download quote. After the charged refusal reconnect the same shop and wait. Open the merchant's Orders and attempt the available recovery for that exact order. Repeat the recovery with an order ID that belongs to another merchant. | Reconnection alone does not create a shop order. Another merchant's order ID reveals nothing about that order and contacts no shop. Supported recovery uses the original bound shop order or validates an exact existing order before releasing saved delivery, unless Agentify fulfillment is closed. Where no supported recovery exists, the unfulfilled purchase and missing delivery path remain visible; the merchant can close future Agentify fulfillment and arrange a remedy with the buyer. No blind shop creation or staffed Agentify recovery is assumed. |
| H-08 / P0 | Let Woo commit a download order and cut its response. Restart the connector and retry. Test recovery with absent, wrong and exact matching remote order ID. | No second Woo POST/order. Unknown creation is not invented success. Wrong identity cannot release goods; matching recovery retrieves the original permission and delivers once. Repeat recovery and verify the same result. |
| H-09 / P1 | Import a catalogue just over its 200-product limit using controlled copies. Separately, in the lab, where tax calculation is off, make public product price differ from the authenticated API through a controlled change to what the public catalogue answers, leaving the stored price alone; a difference that comes from how a shop with tax on shows its prices is H-16's case, not this one. Also make a product/settings endpoint return a different object's ID. | Oversized import refuses the whole operation rather than silently publishing a prefix. Mismatches name the product/setting and publish no misleading card. The summary distinguishes rejected, unknown and unattempted work; the owner can recover without guessing which products changed. |
| H-10 / P0 | Disconnect after orders have safely closed; revoke the shop's API key there. Reconnect and buy a supported product again. | Agentify no longer uses removed connection credentials. The owner understands what disconnect does and what must be revoked at the shop. Reconnection does not resurrect paused cards or lose original payment facts, unfulfilled orders, merchant closures or receipts. |
| H-11 / P0 | Connecting changes nothing for the shop's other customers. Realistic profile priced in rupiah, as the census found such shops, with tax calculation on. Take the shop settings snapshot before the owner does anything. A person then places an ordinary order as a human customer through the human checkout: a product the connector can sell and one it cannot, delivered to a place the shop taxes. The owner connects the shop following only the public guide and the dashboard, performs every instruction the guide gives as a step of its own, sets the exchange rate the WooCommerce screen asks for, which imports, and an agent buys the sellable product. The same person then places the same order again and the snapshot is read a second time. | Compare the two human orders line by line: each item's price, each tax line and its rate, shipping and its tax, the total, the emails the customer and the merchant received, and the shop's reports of orders, revenue, taxes and customers; compare the two snapshots. Every difference is one the guide named, with what it does to the shop's other customers, before the owner acted on it, and none changes what an ordinary customer pays, to the rupiah. The agent's own order differs from a customer's only in the ways the guide states, such as carrying the owner's email as the customer's. A failure is any changed setting, email or report line the guide did not name beforehand; any guide instruction that changes a shop-wide setting without saying what it does to other customers, whether or not it changed this order; and any rupiah of difference in what the person paid. |
| H-12 / P1 | A merchant whose SDK card is on sale presses Connect for the realistic profile priced in Indonesian rupiah, the currency a shop in Bali sells to its local customers in, written with no decimals. Then, each time from a fresh start with the SDK card on sale, press Connect for the same shop with its Number of decimals set to three; for a copy of the lab shop, which writes two decimals, with its currency set to one WooCommerce offers and Coinbase's exchange rates do not list, chosen by reading Coinbase's answer on the day of the run; and for the rupiah shop while the dashboard cannot reach Coinbase (dashboard outbound faults), pressing Connect again once it can. Separately, on the realistic profile, make the shop's public catalogue unreadable to the connector, press Connect, then make it readable again and import. | The rupiah shop connects: the browser goes to the shop's approval, the switch to the shop takes the SDK card off sale as every Connect does, and once the keys arrive the WooCommerce screen says the shop sells in Indonesian rupiah (IDR) and asks for a rate before anything is published (H-18). Each of the other three is stopped beside the Connect button before the browser leaves for the shop and before any key is asked for: the shop's REST API settings list no new key, no keys reach Agentify, and nothing changes in how the merchant sells, so the integration stays their code, the SDK card stays on sale and nothing is paused. The three-decimal refusal names the currency, the decimals and the Number of decimals setting; record whether it says what changing that setting does to the prices every customer sees, as the guide does. The unlisted currency's refusal names it and says Coinbase gives no rate for it. Coinbase's silence is not reported as a currency without a rate: the words say that whether Coinbase gives one is not known and ask for Connect to be pressed again in a moment, and the press after Coinbase answers connects. No refusal invites the owner to change the shop's currency, which would change what every customer pays. An unreadable catalogue does not stop Connect and is never reported as an unsupported currency or an empty shop: Connect goes ahead, the screen asks for no rate until an import has read the shop's currency, and that import, with the catalogue readable again, publishes nothing and asks for a rupiah rate. A failure is a browser sent to the shop's approval, a key issued, an integration switched or a card taken off sale for a shop that was refused; a refusal that does not name the currency; Coinbase's silence read as a currency with no rate; or a refusal that suggests switching the shop's currency. |
| H-13 / P0 | The tax-mode copy with prices entered including tax and tax rounded at the subtotal. Import, then let an agent buy the gift-wrapping guide, the tote to a place in the shop's own rate area and the tote to the place with the other rate. Before each purchase, read the shop's own cart for the same product and, for the tote, the same address, as a person shopping there sees it. | The download sells at the shop's price, and the shop's order records the tax inside that price at the shop's own rate, in lines that add up to the price. The tote to the shop's own rate area sells at the shop's own cart total, with goods, tax and shipping as the cart has them. The tote to the other rate is refused before payment, with no shop order, in words that let the agent tell a destination this shop cannot be sold to from here apart from a shop that did not answer. The quote, the payment and the person's cart agree to the cent. The shop order's total equals them, or differs by one cent, in which case the order is still taken on and the merchant's Orders screen shows the shop's total beside what was paid; either way the order carries what the agent paid among its Agentify lines (`agentify_paid`). A failure is any cent of difference between the quote, the payment and the person's cart for the same sale, a shop order more than a cent from the payment that is taken on, a one-cent difference the Orders screen does not show, a tax line at a rate other than the shop's own, or a sale to the other rate. |
| H-14 / P0 | The tax-mode copy with prices entered excluding tax. Import, then let an agent buy the tote to a place at each of the two rates, reading the shop's own cart for the same address first. Then try to buy the gift-wrapping guide. | Each tote sells at the shop's cart total for the buyer's place, so the two totals differ exactly as the shop's two carts do, compared to the cent as in H-13. The download is not sold at any price: the import names it with its reason, or, where a card exists from an import under other settings, its purchase is refused before payment. A failure is a tote sold at a total other than the shop's cart for that place, a download sold at a price that leaves out or guesses the tax, or a refusal that tells the owner to change how the shop enters prices without saying what that does to the shop's customers. |
| H-15 / P0 | The H-13 copy with tax rounded per line instead of at the subtotal. Choose the tote's price, its shipping rate and the shop's tax rate so that the two roundings give cart totals a cent apart, and show that cent in the person's cart under each setting before buying; prices for which the two roundings agree prove nothing. Import, then let an agent buy the tote to the shop's own rate area, and the download. | Nothing sells from a shop that calculates tax and rounds it per line: the import leaves the tote and the download in the shop and names the rounding setting for each, or, where a card exists from an import under other settings, its purchase is refused before payment, and no shop order exists. A failure is any product sold under per-line rounding, or a refusal that tells the owner to change the rounding without saying that it changes how every order of the shop is rounded. |
| H-16 / P1 | Copies of the H-13 shop changed one setting at a time: prices shown in the shop excluding tax although entered including it; prices shown during cart and checkout differently from how they are entered; tax based on the customer's billing address; tax based on the shop's base address. Import each. Separately, on the realistic profile, import a shop whose tax an outside tax service calculates. | The copy whose catalogue shows prices otherwise than they are entered has every product refused at import with the display setting named and no card published. The copies that calculate tax on the billing or the shop's base address have the tote refused at import with that setting named, while the download, which gives no address, sells as in H-13. The copy whose cart and checkout show prices otherwise than they are entered is not refused by any check of the connector: record whether its tote and download sell, and compare every sale's four amounts as in H-13. No refusal asks the owner to change a setting without saying what it does to the shop's other customers. Record whether the import recognises the outside tax service; naming it unsupported passes, and a card sold at a price the shop's own checkout would not charge fails. A failure is a card published for a product the connector should have refused here, a refusal that names no setting or the wrong one, or a sale whose total differs from the shop's own checkout by more than H-13 allows. |
| H-17 / P1 | Read the shop request log while the owner connects and imports, while the connector checks prices and while an agent buys a download and a tote. Separately, on the realistic profile, put the shop behind bot protection that challenges unfamiliar clients, and repeat. | Every request the connector sends, the public catalogue read before any key included, carries a User-Agent naming Agentify's connector rather than imitating a browser or leaving an HTTP library's default, so the owner can recognise it in their logs and allow it. A shop whose protection challenges or blocks the connector leaves an unread or unanswered result, distinguishable from a known refusal, with no charge before a usable offer (H-06); record what the owner is told and whether they can tell that their own protection stopped it. A failure is a request that disguises itself or names nobody, or a challenge page read as a product, a price or an empty catalogue. |
| H-18 / P0 | The first rate. Realistic profile in rupiah, connected as in H-12, with the merchant's seller name, payout wallet and site set. Before any rate is set, read the WooCommerce screen, press Import and read the catalogue. Then save a rate written in digits within a tenth of Coinbase's, read the cards the import publishes, and let an agent buy a parcel to a place in Indonesia. Work out by hand, from the shop's own prices, its flat shipping rate and the saved rate, what three cards, the cheapest the import published among them, and the parcel's price should be in dollars. | Before a rate is set, the screen names the shop's currency, asks how many rupiah one US dollar buys, and shows Coinbase's open rate beside the field as text with the moment Agentify read it; Import publishes nothing and says a rate is wanted first, and the catalogue holds no card of the shop. Saving the rate says it was saved and runs the import, and the WooCommerce screen afterwards shows the rate with when it was set and how far it stands from Coinbase's. Each card's price is the product's rupiah price divided by the rate and rounded up to the next cent, never down and never to nothing, and a division that comes out exact gains no cent. The parcel's price is the cart's rupiah total, the goods and the Rp 24.000 of shipping together, converted and rounded up once, so it can be a cent below the card's price plus the shipping converted on its own. Everything the agent reads, the card, the price answer, the order and the receipt, is in US dollars and names no rupiah amount and no rate. A failure is a card published before a rate is saved, any price a cent away from the hand calculation, a price rounded down, or a rupiah amount or a rate shown to the buyer. |
| H-19 / P0 | A mistyped rate. On the rupiah shop of H-18, with Coinbase's rate on the screen, try to save rates a merchant could mistype: with a dot between thousands, as the shop writes rupiah (18.000 for eighteen thousand); with a comma and with a space between thousands; with a digit missing and with one too many; and the other way round, US dollars per rupiah. Each time the screen asks for a rate a second time, type a different one once and the same one once. Also save a rate a few percent from Coinbase's, as a merchant allowing for their exchange's spread would. | A comma or a space between thousands saves nothing, in words that say to write the rate in digits with nothing between thousands. A dot is read as the decimal point, so 18.000 is eighteen rupiah to the dollar. It, the missing digit and the extra digit each stand more than a tenth from Coinbase's rate, and none is saved at its first typing: the screen says how far the rate stands from Coinbase's and when Coinbase's was read, what the first product of the shop's public catalogue would sell for at the typed rate against at Coinbase's, and asks for the rate to be typed again, saying to leave out a dot written between thousands. The rate written the other way round is refused for having more than six decimals or, written shorter, is stopped the same way. A different second typing saves nothing; the same rate typed twice is saved, and its kept row records that it was typed a second time. The rate a few percent away is saved at its first typing. A failure is a rate more than a tenth from Coinbase's saved at one typing, a separator guessed into a number, or a guard that does not show what a product would cost. |
| H-20 / P0 | Who learns of a rate. On the rupiah shop, save a first rate and then a second, reading the account's mailbox each time. Make the mail provider refuse the next message (dashboard outbound faults) and save a third. Separately, sign in to the same account in a second browser, as somebody holding the owner's session or a sign-in link meant for them would be, and from it save a rate with one digit too many, typed twice. Give the owner that mail alone, with no word from the organiser, and ask what happened and what they will do. | Every rate is mailed to the account's address before it is written. The mail names the shop, the currency, the new rate, the rate before it or that none was set before, the moment it was entered and the address the saving session was signed in as; it links the WooCommerce screen with nothing in the link that signs anyone in, and says what to do if nobody at the business entered the rate: press Pause all sales on Cards, then Sign out every other device in Settings, then set the rate again. When the mail cannot be sent nothing is saved: the screen says the message could not be sent and to try again, and the rate, the cards and their prices stay as they were. From the mail alone, record whether the owner understands that the new rate already prices every card, that the address it names is their own and so does not say who entered the rate, and that undoing it means signing in and saving the previous rate the mail gives, which is mailed in its turn and kept as a new row beside the other session's. Prices given between the change and the correction are bound to the changed rate and filled at it, as in H-21. A failure is a rate saved without its mail, a mail without the previous rate, a link that signs anyone in, or a kept rate edited or removed. |
| H-21 / P0 | A rate changed around a payment. Ask a parcel's price from the rupiah shop, save a different rate within a tenth of the first inside the thirty seconds the price holds, then pay that price. Separately, save another rate after a paid order's shop order exists. Where the run can hold the connector between a payment and the shop order it makes (controlled Woo fault), change the rate there as well. For each order read the agent's order and receipt, the shop's order with its Agentify lines, the connector's record of the sale and the merchant's Orders screen. | The payment is the dollars quoted, and the order is filled at the rate its price was bound to, never at one saved since: the shop's order is made in rupiah at the bound rupiah amount, and is taken on at that total or one rupiah either side of it and at nothing further. With tax calculation off, as the profile ships, the shop's total should equal the bound amount; record any difference. The order's Agentify lines carry the USDC paid (`agentify_paid`), the bound rupiah amount (`agentify_shop_amount`) and the bound rate with its version and the moment it was set (`agentify_rate`), and the Orders screen shows the shop's total, the USDC paid and that rate with when it was set. A rate saved afterwards changes none of them, while prices asked after it use it. A failure is a paid order refused or left unfulfilled because the rate changed, a shop order at an amount converted at another rate than the bound one, any record naming another rate, or a shop order more than one rupiah from the bound amount taken on. |
| H-22 / P0 | A rate over time, a reconnect and a changed currency. On the rupiah shop, let an agent buy while the shop's current rate stands more than a tenth from Coinbase's, saved past the guard as in H-19, and again at least a day after the last rate was saved. Disconnect the shop once its orders have ended, connect it again and import. Then set the shop's currency to another currency Coinbase lists, at the same decimals, ask a card's price and import; set it back to rupiah, ask again and import. | A rate's age and its distance from Coinbase's are shown on the screen, the distance as a warning once it passes a tenth, and neither stops a sale. After reconnecting, the screen shows the rate saved before, with when it was set and how far it stands from Coinbase's now, and the import publishes at it with no new rate asked for. Once the shop sells in another currency, every purchase of its cards is refused before payment as not available, the import publishes nothing and asks for a rate in the new currency, and the rupiah rate is never applied to it. Set back to rupiah, the shop sells again at its last rupiah rate with nothing set anew. A failure is a sale stopped by a rate's age or distance, a reconnect that loses the rate or asks for it again, or any price converted at a rate set for another currency. |
| H-23 / P0 | Coinbase silent while a rate is saved. On the rupiah shop, with the dashboard unable to reach Coinbase (dashboard outbound faults), open the WooCommerce screen and save a rate with one digit too many, then one with a dot between thousands, then the intended rate. While Coinbase stays unreachable, let an agent ask a card's price and buy. Make Coinbase reachable again and reopen the screen. | The screen says Coinbase's rate could not be read, so a rate saved now is compared with nothing. Each rate is saved at its first typing once its mail has gone, the screen saying it was not compared with anything and its kept row holding no reference. Until the next rate, the extra digit sells every card for about a tenth of what the intended rate gives, and the dot for about a thousand times it: record what the owner reads on the screen and in each mail, and whether they would notice before a buyer paid. Purchases go on while Coinbase is unreachable, priced at the saved rate, and the dashboard sends Coinbase no request while a buyer waits. Once Coinbase answers again, the screen shows how far the current rate stands from it. A failure is a rate refused, or a purchase refused or delayed, because Coinbase is silent, or a request to Coinbase during a purchase. |

H-11 is run as the owner would run it, with the public guide and the
dashboard open and nothing else, and the organiser keeps a list beside it. For
every instruction the guide gives, the list holds the guide's own sentence,
what that sentence says the instruction does to the shop's other customers,
and whether the owner read it before acting or only afterwards. A consequence
the guide explains after the step, or on a page the owner reaches later,
counts as not named. A refusal from the connector that names a setting becomes
an instruction when the owner acts on it, and it is listed the same way. The
two human orders use the same products, quantities, address, shipping method
and payment method, and the second is placed after the agent's order exists in
the shop, so that a change caused by the sale, not only by the connection,
shows up too. What the organiser sets up for the run itself, such as the human
checkout and its mailboxes, is in place before the first snapshot and stays
until the second. Order numbers and dates are expected to differ, and the
agent's sale is expected to appear in the shop's reports; how it appears there
is what the guide must have said. Any other difference goes into the report
with the guide's sentence beside it, or as a finding where there is none.

H-13, H-14 and H-16 compare four amounts for every sale, to the cent: the
price the agent was quoted, what it paid in integer token units (ten thousand units of
USDC are one cent), the total of the order the shop created and the total of
the person's cart for the same product and address. Keep the shop order's tax
lines and rates beside them, and the copy's tax settings as the snapshot read
them at the time of the sale. Where a row sets one setting against another, as
H-15 sets per-line rounding against rounding at the subtotal, the amounts are
chosen so that the two settings give different cents; amounts on which they
agree prove nothing about the setting.

A sale from the shop priced in rupiah, as in H-18 and H-21, compares its
amounts in the currency each one is written in and never converts one back
into the other: the amount the price bound, the shop order's total and, where
a person shops, their cart, in rupiah, to the rupiah; the price quoted and what
was paid in US dollars, to the cent, with the payment in integer token units;
and between them the rate and its version, from which the organiser works out
the dollars by hand, the rupiah amount divided by the rate and rounded up to
the next cent. Keep the rate's kept row beside them: the rate, when and by
whom it was saved, Coinbase's rate as read while saving or that none could be
read, and whether it was typed a second time.

## F. A parcel is a physical obligation

These stories run on TEST or the local stack, never as a live sale. Use the
tote's configured zones and a controlled delivery address. For an SDK parcel,
persist the full address in the merchant system before acceptance. Do not log
the address to prove that it arrived.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| F-01 / P1 | Quote the tote to the actual supported country, state and postcode zones, and to an unsupported place. Try missing necessary locality fields and a changed address at payment. | A supported offer includes shipping and, in a shop with tax calculation on, the tax the shop's own cart charges for that place (H-13, H-14); unsupported locality or changed priced address refuses before payment. Quote messages expose locality only. Errors let the agent correct the address without guessing a different destination. |
| F-02 / P0 | Pay; persist the address at the merchant, then lose the acceptance response and restart. Separately crash before saving it and allow the deadline/erasure to occur. | After acceptance the gateway shows erased_at and never supplies the address again. The merchant's durable copy recovers the accepted work. A missing copy is not fabricated; the paid order remains unfulfilled after its deadline, and the merchant and buyer determine the remedy. Inspect active order/queue/connector data and redacted logs; backups retain data until their stated expiry. |
| F-03 / P0 | For Woo, change shipping rates after the quote: keep a current rate at the paid cost in one variant and remove every such rate in another. Exercise a cart that fails between add-item and rates; separately a controlled plugin replaces/removes the item. | Only the quoted total can be spent. A matching current cost may be used; no matching cost leaves a paid unfulfilled order with zero Woo POST. No price for the wrong item/cart may be accepted as the requested goods. The wrong-cart refusal is an adversarial hypothesis to verify, not a known implemented check. |
| F-04 / P0 | Record shipment with tracking and without it on separate orders. Repeat the same shipment, submit a different one and change Woo tracking/status after completion. | Buyer sees shipped, never proof of arrival. Shipment has one durable meaning; identical retry is safe and conflicting SDK shipment is refused. Explain that later Woo edits do not rewrite an already recorded Agentify shipment. A missing native Woo tracking facility leaves that variant unmeasured. |
| F-05 / P0 | Let a parcel exceed its shipping time; ship a still-followed Woo order late before Agentify closure. Separately cancel/refund it in Woo, lose Woo's create response, close Agentify fulfillment, and ask about a parcel lost after recorded shipment. | A supported late shipment can complete an unfulfilled order until closure. Woo cancellation/refund neither proves returned USDC nor closes Agentify fulfillment; without a recorded shipment the paid order becomes unfulfilled at its deadline. Agentify closure stops later shipment recording but cannot cancel shop work already running. Unknown creation causes no second parcel order, and download recovery cannot recreate a parcel after address erasure. Closure is refused after shipment; returns, lost-parcel remedies and address changes remain with the merchant and buyer outside Agentify. |

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
| M-06 / P0 | Apply the controlled merchant's policy and a remedy agreed with the buyer, before and after payout; fund any chosen refund within its authorised test budget. Hold delayed fulfilment, close it through the SDK and through Orders in separate variants, and lose the closure response before retrying. Race closure with delayed delivery and an original pending payment; include already-delivered and shipped controls. Give fresh merchant/buyer sessions their own records and the original task. | The parties' remedy, any external transfer, Agentify closure and the original payment are distinguishable. Closure preserves the first time/message, payment facts and held goods, without claiming a refund was verified or the buyer consented. Check no future Agentify fulfillment after closure, no new charge from a purchase retry, safe readback after an unknown response, and refusal of closure after recorded delivery/shipment. Merchant obligations under the actual policy or agreement remain their responsibility. |
| M-07 / P0 | Through the SDK, ask to close: a delivered order, a shipped parcel, a rejected, an expired and a cancelled order with nothing charged, an expired synchronous order still holding late goods, and an ended order whose charge went unanswered. Send closing messages with an HTML tag, a character reference, a control character, a bidirectional override, a NUL and 2001 characters, then a plain message with line feeds. Read each order from the merchant's and the agent's side before and after, and try the Orders action where the dashboard offers it. | Delivered and shipped orders answer fulfillment_complete and ended-with-nothing orders nothing_to_close, both not retryable, with the order and the agent's reason unchanged. The order holding late goods and the unanswered one close. Each malformed message is refused with 400 and words naming the problem, before anything is recorded, and never answers 500; the plain message is kept exactly as written. On a paid closed order the agent reads the merchant's message beside Agentify's merchant_closed sentence. The dashboard offers closing only where the buyer has paid or may have paid, and its wording matches the SDK's answers. |

M-06 distinguishes the merchant's remedy from Agentify's closure. The merchant
and buyer determine their agreement, including the amount and means of any
refund. Inspect a chosen controlled transfer independently; neither that
transfer nor the merchant's explanation proves the parties' agreement to
Agentify. The original sale price and payment facts remain, and Agentify keeps
its commission. Missing merchant records needed to honor their policy remain
a finding; no refund-recording tool or Agentify-funded remedy is assumed.

The SDK's `order.close()` and the dashboard's Orders action stop future
Agentify dispatch, redelivery and release of held goods. Repeat after a lost
response and compare the first time and literal message with a fresh read.
If closure wins the delivery race, later goods stay withheld; if delivery or
shipment is already recorded, closure is refused and those facts remain.
Closure causes no new charge, but an original payment already accepted for
execution may finish and update its independent `payment_status`. With a known
payment outcome, closure reads `fulfillment_closed`; an unresolved payment keeps
`payment_unresolved` as the main status with `merchant_closure` visible. Any
explanation of a refund or agreement remains attributed to the merchant, never
presented as verified by Agentify.

Restart the integration and race the merchant's external remedy with work
already running in its handler or shop. The merchant must coordinate those
effects in their own system: a lookup before an effect alone does not close
the race. Agentify closure cannot cancel that work or refund or cancel a
WooCommerce order. First observe whether the newcomer finds this boundary in
public guidance, then compare with a controlled integration lacking that
coordination. Calling `refuse` records no refund and does not stop late goods;
closing Agentify fulfillment is the separate action. A documented merchant
responsibility still needs an understandable path; naming it does not turn an
unsafe attempt into a pass.

## K. Someone else opens the dashboard the next morning

Prepare paid delivered, accepted overdue, unpaid expired and unresolved payment
orders, plus an older unfulfilled order outside the first page. The unpaid
expired orders are attempts that lapsed unpaid, which the Orders page lists
only under Lapsed; prepare them within thirty days of the reading. Let the
merchant's event response be lost. Use an independent reader who did not create
the orders. Give only the public UI, docs and merchant-owned operation records;
allow the SDK if their role normally uses it. Our SQL and private logs are not
their tools.

| ID / priority | Situation and attempt | Required result and evidence |
| --- | --- | --- |
| K-01 / P0 | Ask what needs action and where the money is. Include two equal-price payments near each other, one paid undelivered order without a receipt, one unknown payment, one delivered order recovered from verified chain evidence and one attempt that lapsed unpaid. | The reader finds all obligations, distinguishes uncertainty from failure and does not infer that receipt totals equal cash received. The recovered receipt carries the transfer and its block time; an unknown payment has no receipt. The reader finds the lapsed attempt under Lapsed, understands that nothing was charged for it, and knows that a search of the other segments leaves such attempts out, as the page says with their count. Record first interpretation, missed items and every request for help. |
| K-02 / P0 | Recover one overdue order by delivering its already recorded goods before closure, observe automatic reconciliation of another original payment without resubmission, and attempt M-06's merchant remedy and closure. | Each remains the same purchase, with one merchant effect and truthful original payment facts. Unavailable payment evidence stays unknown; it is not supplied by an operator's assertion. Missing merchant tools for the supported task are findings. Neither closure nor original-payment recovery requires a staffed Agentify service, and no page sends the merchant to one. |
| K-03 / P1 | Leave the dashboard open overnight, restart the merchant process repeatedly, and return through an old bookmarked filtered list. | Visible state refreshes or clearly says it is stale. Repeated startup does not multiply goods. The merchant can tell when work resumed and whether it needs attention without reading gateway logs. Where the process stays down for more than ten minutes, the dashboard's banner says since when the integration has not connected and that prepaid purchases are refused, and it is gone once a restarted process has polled. |

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
| I-06 / P1 | Choose essential-only consent, run a scan/register, then allow and withdraw measurement, including another tab. Inspect browser traffic and authorised server records. | Product analytics and ads measurement stay off until allowed and stop after withdrawal, in every open tab. Necessary consent, identity and scan records are not mistaken for prohibited analytics. Browser-only evidence leaves server behavior unmeasured. The privacy explanation matches what the person just chose. The report of a registration to the ad tracker does not follow this choice; I-07 checks it. Nor do the dashboard's product analytics, which its server sends and the switch in its Settings stops; I-09 checks them. |
| I-07 / P0 | With essential-only consent, open sign-in through an address carrying the ad tracker's click identifier and register a new address by emailed link; repeat with Google. Then sign in again, create a merchant, arrive from the ad with an address that already has a verified account, refuse a Google return, and sign in without a click. Run the dashboard locally with its own receiver: the test channel never reports. | Nothing is asked on screen. Each new account is reported once whatever the privacy choices; a repeated delivery of that same report is allowed. The report carries the click identifier and the event alone, never the address or anything else about the person. The other attempts report nothing. The click identifier is gone from authorised server records after delivery, or after a day without it. The privacy page says the report goes whatever the choices and keeps it apart from the banner's categories. Delivery to the real tracker needs its own logs and the marketing team's agreement; never register from a real ad click on the live channel as a rehearsal, since it counts as a paid registration. |
| I-08 / P0 | After the run, search every log line it produced, on the host and in the shared log stack the channel ships its logs to ([research note 53](53-self-hosted-observability.md)), for each of the run's order identifiers, for status addresses (`/x402/orders/…/status`), for WooCommerce order keys (`wc_order_…`), for the order, uid and key values of WooCommerce download links and for the parcel's delivery address. The run includes a sale through the SDK, a WooCommerce download, a parcel, a merchant handler that throws, a WooCommerce refusal and a payment recovery; any of these the run lacks is made for this story. | None of them appears in any line. Each order's lines are found by its fingerprint (What must agree after a sale), from the gateway and the WooCommerce worker alike. A hit is a P0 privacy finding, reported with its line's source, time and wording and with the value itself masked. Lines shipped before the release under test are not part of the run. How long the shared stack keeps lines is not recorded, so a clean search there says nothing about lines older than the run. |
| I-09 / P0 | Product analytics sent from the server. Run the dashboard locally with product analytics switched on and a receiver of the organiser's own, the only place a sandbox sends them; on the test channel only where its deployment sends them and the analytics team agrees, since those events reach the team's test site. Walk one merchant through signing in, creating the merchant, its settings, publishing a card, an SDK sale, a sale from the rupiah shop (H-18), a refused purchase and pausing all sales. Lose the receiver's answer to one event. Then, while events about the merchant still wait to be sent, turn product analytics off in Settings, let an agent buy from that merchant, turn them on again and buy once more. Read every request the receiver got. | Each request carries one event of the analytics team's contract, commerce-v1, which names ten, with only that event's fields; the event whose answer was lost arrives again with the same event_id and timestamp, and events from the test channel carry its internal tag. A person, a merchant, a card, an order or a payment attempt appears only as a reference of 32 hexadecimal digits, the same for the same thing in every event, and a person's only as the event's user where that person acted. No name, email address, wallet, key, identifier as Agentify writes it, shop or delivery address, card or order content, or error text appears anywhere in a request. An amount appears only with a payment observed paid, and the rupiah sale's is the US dollars paid, with no rupiah amount and no rate. Once analytics are off, nothing about that person or their merchant leaves, whoever acted, the agent's purchase included, and neither does what was waiting when the switch was turned; turned on again, only what is recorded afterwards leaves, the one exception the design accepts being an event whose transaction was still open at that moment. Record what the privacy page and Settings tell a person about these events, who receives them and how to stop them; a privacy page that presents product analytics only as a choice in the consent banner, while the dashboard sends them until the Settings switch is turned off, is a finding. A failure is a request outside the contract, any of those values in one, an event leaving after the switch was turned off, or one recorded before it was turned on again leaving afterwards. |

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
| G-04 / P0 | Open the live-sales approval page as an account without the operator flag and submit it directly. As the operator, look up an address with no account, a near-identical address and the exact seller's; approve, approve again, and submit from a tab left open after the operator flag was removed or after signing in as another account. Lose the response to one approval. Then, with an order of the merchant's still open, withdraw the approval with the operator's terminal command `pnpm approve --withdraw <email>`, withdraw it again, and open the merchant's live dashboard. | Only an account holding the operator flag sees or changes anything, and the flag is checked again when the form is submitted, not only when the page opened. The approval names the exact account it was given to, and a repeat keeps the first approval. An uncertain write is reported as uncertain, and a reload shows what was recorded. Approval enables live sales and nothing else: a merchant still missing a seller name, a payout wallet or a published card cannot sell. A withdrawn merchant stands as one never approved: nothing new of theirs is published or sold live, the order already open plays out as under a pause, the second withdrawal says there was nothing to withdraw and changes nothing, and the live dashboard again shows what an unapproved merchant sees (G-01). |
| G-05 / P1 | Without spending, check that the live channel's chain reads can carry payment recovery. Read the gateway's start-up line about the RPC's network, then send the endpoint the kind of query recovery makes, a USDC authorisation or transfer log lookup over a bounded block range around a known past transfer, several times within one recovery poll interval. | The configured endpoint serves Base and answers each query. If it rate-limits or refuses, as the public mainnet endpoint answered HTTP 429 to a narrow log query when recovery was built, record that an unanswered live payment would stay unresolved: a finding against the live configuration, not a pass. A test-channel success does not carry over to live. |

## Combining ordinary failures

After the isolated stories, run these selected combinations. Use barriers and
record every change; uncontrolled random clicking does not explain a failure.

| ID / priority | Combination | Required result |
| --- | --- | --- |
| X-01 / P0 | A buyer's reply is lost, the application restarts, and the merchant rotates its key before the buyer resumes (J-01/J-06/D-04). | Same order, one effect and payment; the replacement merchant process and buyer can recover without internal history. |
| X-02 / P0 | A Woo order's response is lost, the owner presses Disconnect and the old connection callback arrives (H-02/H-04/H-08). | No lost ownership, renewed credentials from an obsolete grant or second Woo order. Any unfulfilled order and its original payment remain visible for the merchant's remedy. |
| X-03 / P0 | A merchant returns after a lost order.unfulfilled event with 200 newer orders and an old tab signed into another account (J-07/U-04/E-03/K-01). | Neither identity is mutated accidentally; the unfulfilled purchase remains findable and is not hidden by counts, paging or stale UI. Its status does not establish a refund or settle the merchant's obligations. |
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
J-01/J-02, D-04/D-06/D-07, E-02/E-03, H-01/H-03/H-08, I-08, M-01/M-02 and
one morning-after U-02/K-01 recovery; I-08 belongs to every release check
because any change can add a log line. Add C-09 for changes to the payment
window, D-08 for changes to the contracts or the SDK, J-09 and J-07's
overnight variant for changes to the purchase door, B-07/B-08 for changes to
what an agent reads at the door or on the test channel, U-06/U-07 for
documentation and site-frame changes, F for parcel changes, H-12 and H-18 to
H-23 for changes to how a shop in another currency is admitted, priced or
recorded, I for scanner or identity changes, I-09 for changes to the product
analytics the dashboard sends, and L for discovery/declaration/payment-recipient
changes.
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
unfulfilled orders and merchant remedies; cleanup that is safe only after
reconciliation.

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
command refuses accounts with orders/receipts. Never erase unresolved orders or
merchant obligations to tidy a run.
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
[merchant closure](../decisions/0028-late-goods-settle-a-refund-owed.md),
[original payment recovery](../decisions/0027-recording-a-silent-charge.md),
[wallet changes](../decisions/0019-non-custodial-payout-wallet.md),
[payout splits](../decisions/0037-every-payment-goes-to-the-merchants-split.md),
[registry persistence](../decisions/0038-the-registry-of-payout-splits-is-never-rewritten.md),
[the purchase door](../decisions/0043-the-purchase-door-refuses-before-any-charge.md),
[the contract version](../decisions/0006-wire-version.md)
and [discovery declarations](../decisions/0012-discovery-declaration.md).

Implementation evidence for the organiser lives in the
[order machine](../../packages/core/src/orders/machine.ts),
[SDK transport](../../packages/sdk/src/transport.ts),
[gateway](../../apps/gateway/src/app/gateway.ts),
[payment edge](../../apps/gateway/src/http/x402.ts),
[authorisation window](../../apps/gateway/src/app/payment-window.ts),
[returning payments](../../apps/gateway/src/app/returning-payment.ts),
[payment recovery](../../apps/gateway/src/adapters/x402/recovery.ts),
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
