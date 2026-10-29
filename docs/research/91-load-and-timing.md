# Load and timing on the stand and the test channel

Status: a pre-registered protocol. Nothing here has been run. The predictions
and the decision rules are fixed now, against the limits and the metrics of
release app-v0.28.0, and are executed literally ([CLAUDE.md](../../CLAUDE.md),
Research). The protocol measures how long each party takes in a purchase,
reads the per-phase metrics the gateway now exposes, and checks the product
owner's rule that work nobody paid for never slows a paid purchase. It keeps
what the server reports apart from what a client times, and it keeps every
chain read out of every endpoint figure, because a wallet read folded into an
endpoint time makes the endpoint look slower than it is and hides where the
time went. The stories that run it, with the limits' own stories beside them,
are block T of the [manual test plan](42-manual-test-plan.md), and they run on
the load stand that plan prepares; the results those rows require count as
predictions fixed together with this note.

## Where each part runs

The flood of unpaid price questions runs on the local stack, whose sandbox
facilitator stands behind no chain. A flood there spends nothing and puts no
load on the shared test channel, and an unpaid price question writes no order
whichever facilitator is behind it. Two things the local stack cannot show.
Its facilitator verifies any payment, so a junk payment there would be
admitted as a pretend sale; and it reads no wallet from a chain, so every
payment there, an honest buyer's included, waits in the lane for payments
nobody can vouch for. Junk payments and the buyer lane are therefore measured
on the test channel, which settles test funds on Base Sepolia through
Coinbase's facilitator as the live channel does, and so are all the timings.
Reading the test channel is allowed, there being no live clients yet.

## What the metrics expose

The gateway records each party's share of a purchase as a duration histogram,
with buckets from 5 ms to 200 s, and sends it to the self-hosted observability
stack ([research 53](53-self-hosted-observability.md)):
`agentify_price_answer_duration_seconds` by outcome (answered, unavailable,
silent) and integration; `agentify_price_to_payment_seconds`, from a price
being named to the arrival of its first payment; `agentify_payment_verify_duration_seconds`
by lane (proven, unproven) and verdict; `agentify_payment_admission_duration_seconds`
by result; `agentify_payment_settle_duration_seconds` by outcome and by whether
the card is charged on purchase or after its goods; and
`agentify_payer_read_duration_seconds` by outcome. Two counters say why buyers
were turned away: `agentify_gate_refusals_total` by gate (price, proven,
unproven, payer_read) and `agentify_retry_after_answers_total` by answer and
the seconds asked. No label names a merchant, a buyer, a product, an order or
a price.

The histograms are summed over the process's life and nothing joins them into
one purchase, so the run reads each phase's distribution over the run's window,
not the phases of one slow call. One call's total is timed by the client around
each HTTP request and set beside `agentify_http_request_duration_seconds`,
which still stops at 60 s. Settlement landing is read after the run as
[research 46](46-charge-answer-timing.md) read it: each paid order's stored
`settleStartedAt` from a read-only database read, against its transfer's block
time from the chain.

## The limits under test

They are read off the code and reported as they stand; they are loose code
bounds, not measured capacity ([research 90](90-unpaid-price-questions-design.md),
ADR-0043, ADR-0049). Per merchant, four price questions run at once, sixteen
start in any second and sixteen more wait; a question waits for a place two
seconds at most and never more than half its answer window. A merchant has ten
seconds to answer a price (`QUOTE_RESPONSE_MS`) and the WooCommerce connector
gives itself nine. A price holds three minutes (`QUOTE_TTL_MS`), judged by when
the complete paid request arrives. Payment checks wait per merchant in two
lanes: four at once and sixteen waiting for a payment its wallet's own key
signed and whose wallet was read, two and four for any other, with one place
and one place in line for each paying wallet, and a place waited for two
seconds. Wallet reads run two at once with eight waiting, a place waited one
second and a read two. A full gate answers 429 `seller_busy` with
`Retry-After: 2`, a silent price check `seller_busy` with `Retry-After: 10`.
A check gives up after ten seconds and a charge after thirty, and a card
charged before its goods waits thirty-five for its charge. The 402 asks for an
authorisation valid 215 seconds. An unanswered paid order is handed over again
for three hours from its first hand-over, with pauses growing to fifteen
minutes. The SDK worker and the WooCommerce worker each hold four unfinished
messages.

## Steps and sample sizes

1. Endpoint latency on the test channel, nothing else loading it. Unpaid 402s
   are free: 100 each of A's fixed-price card and A's priced card, 50 of C's
   WooCommerce download spaced six seconds apart, longer than the connector
   keeps a product read, and 100 status reads of one order. Paid purchases
   cost 0.01 each: 6 synchronous and 6 asynchronous from A, 2 and 2 from B, 4
   downloads from C.
2. The per-phase histograms and both counters for step 1's window, tied to the
   deployment by `agentify_build_info{revision}`.
3. Settlement landing for every paid order of steps 1, 5 and the T stories.
4. A free flood on the local stack: B's buyer makes 10 purchases with no load;
   then unpaid purchase requests at A's priced card, about 30 at once and 30 a
   second, for 60 seconds, while A's buyer buys that card and B's buyer makes
   10 more purchases; then one purchase from A after the flood stops.
5. A junk burst on the test channel, only by the owner's agreement: payments
   built from fresh challenges of A's fixed-price card, one price each because
   the gateway checks one payment per price at a time, with random signature
   bytes; ten at once, at most 300 in at most 30 seconds, first all naming one
   payer and then each a fresh one, while A's buyer buys A's fixed-price card
   twice.

## Predictions

Endpoint figures include the round trip to the test channel. "Firm" marks a
bound the code sets, where a miss is a defect and not a slow day. A paid call's
ceiling adds the fifteen seconds a payment may wait before its check answers
to what follows the check: the twenty seconds promised for a synchronous
purchase, or the thirty a charge before the goods may take.

| What | Prediction | Basis |
| --- | --- | --- |
| Unpaid 402, fixed-price card | p50 ≤ 0.4 s, p95 ≤ 1.5 s | guess |
| Unpaid 402, A's priced card | p50 ≤ 1.0 s, p95 ≤ 3.0 s | guess |
| Unpaid 402, C's download | p50 ≤ 2.0 s, p95 ≤ 5.0 s, every answer within 12 s | guess, anchored to research 90's 2.8 s cart part; ceiling firm |
| Paid synchronous | p50 ≤ 5 s, every call within 35 s | guess, anchored to the 1.9 s settle median; ceiling firm |
| Paid asynchronous | p50 ≤ 5 s, every call within 45 s | guess; ceiling firm |
| Status read | p50 ≤ 0.3 s, p95 ≤ 1.0 s | guess |
| `price_answer`, SDK | p50 ≤ 0.5 s; no silent outcome in step 1 | guess |
| `price_answer`, WooCommerce | p50 ≤ 3 s; no silent outcome in step 1 | guess |
| `price_to_payment` in step 1 | none past 180 s | firm |
| `verify`, proven lane | p50 ≤ 3 s; every outcome verified | guess |
| `admission` | p50 ≤ 0.1 s, none past 2 s | guess |
| `settle`, either mode | p50 ≤ 3 s; every outcome settled | measured basis (research 46) |
| `payer_read` | p50 ≤ 1 s; every outcome read | guess |
| Settlement landing | p50 ≤ 3 s, max ≤ 10 s | measured basis (research 46) |
| Flood: what it writes | no order for any unpaid request; the orders added equal the honest purchases | firm |
| Flood: A's buyer | a price, or 429 `seller_busy` with `Retry-After: 2`; done within five tries | firm on the answer, guess on the tries |
| Flood: B's buyer | never `seller_busy`; median within the larger of +50 % of its no-load median or +1 s | firm on the answer, guess on the margin |
| Flood: after it stops | A's next purchase is priced at once | guess |
| Junk: what it costs | nothing charged, no order written | firm |
| Junk, one payer | at most one checked and one waiting; the rest 429 `seller_busy`, `Retry-After: 2`, in the wallet's words | firm |
| Junk, fresh payers | at most two checked and four waiting; the rest 429 `seller_busy`, `Retry-After: 2`, in the seller's words | firm |
| Junk: A's buyer | both purchases complete with no `seller_busy`, checked in the proven lane | firm |

## Decision rule

An endpoint prediction passes when the observed p50 is at or under the stated
p50 and no sample crosses its ceiling. A p95 from 50 or more samples is a real
pass or fail; from fewer it is reported as indicative, and a miss there while
p50 and the ceiling hold is recorded as "indicative, under-powered", not a
fail. A phase is read from its window histogram, so its p50 and p95 are bucket
estimates, reported with the bucket bounds. Any firm prediction that misses is
a finding with its evidence, whatever the other figures say. A latency miss
keeps its samples and is reported as a distribution, never retried to a pass.
Where a figure cannot be read, the line says "I don't know" and why, and is not
scored.

## Spending cap

At most 0.30 test USDC, at 0.01 a purchase. The organiser sends the two buyer
wallets exactly their share from its holding wallet, which the owner funds at
Circle's faucet: 0.21 for the wallet that buys from A and C, 0.04 for the one
that buys from B. The planned spend is 0.25: 0.12 for A's
twelve purchases in step 1, 0.04 for B's four, 0.04 for C's four, 0.02 for A's
two during the junk burst, 0.02 for T-04's two purchases near the end of a
price and 0.01 for T-06's order. The flood, the junk payments and every
unpaid 402 spend nothing. A pending or unknown payment holds its 0.01 against
the cap until it is reconciled, and x402 buyers pay no gas.

## Stop conditions

These thresholds are chosen, not measured. On the test channel a step stops
and the window is handed back when more than 2 % of the gateway's answers in
any minute are 5xx, when the host's CPU stays above 80 % for two minutes or its
free memory falls under 10 % on the service-health dashboard, when an honest
buyer's purchase fails, or when the agreed window ends. The junk burst also
stops at the first answer that is neither 429 `seller_busy` nor a refusal of
the payment as not verified. On the local stack the flood stops at 60 seconds,
or sooner when more than a fifth of its answers are 5xx, when B's buyer is
refused twice or when the organiser's machine stays saturated for a minute.
The flood of unpaid questions is never pointed at the test channel, the lab
shop or merchant B.

## Out of scope

Production. Facilitator quotas and Coinbase discovery. Sustained capacity
beyond the stated rates and durations, which the gate constants do not
benchmark. The isolation of the shared database, facilitator and chain
endpoint, and fairness between callers, which stay
[open questions](00-open-questions.md). Any claim that the deployment runs this
exact commit beyond what the four-way deploy read and
`agentify_build_info{revision}` show.

## Evidence

A private folder `~/Documents/Agentify-acceptance/<run>/`, mode 700, never the
repository. It holds the load stand's record; the installed versions; per-call
latency, status, `Retry-After` and retries; the histogram and counter export
for each window with `build_info`; the settlement-landing table; the flood's
and the burst's rates, durations, answers and stop reasons; and the merchant
program's source and hand-over log. No key, wallet key, status address,
download link or private host detail goes into the repository, and status
addresses stay out of the evidence too, since one opens an order's goods.

## The draft scripts

`91-load-and-timing/` holds `measure.mjs`, the client-side harness for step 1,
and `flood.mjs`, the generator for steps 4 and 5. Neither has been run. Each
refuses to start without `AGENTIFY_LOAD_CONFIRM=1`; `measure.mjs` refuses a
paid run without a per-purchase and a total cap, and `flood.mjs` sends its
unpaid flood only to a local address and its junk payments only to a remote
one with `AGENTIFY_JUNK_AGREED=1`. They carry no key or stamp of their own,
read a signer key from the environment without writing or logging it, and
drive the official x402 client as `packages/slice/src/stand-buyer.ts` does.
The x402 client signs without reading the chain, so `measure.mjs` makes no
chain read at all.
