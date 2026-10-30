# Open questions

What is not decided yet, one question to a line, with who decides it and where
the matter is discussed. A question leaves this list once it is answered: a
decision goes into `docs/decisions/`, a finding into the note it belongs to,
and git keeps the entries that were here.

## The product

| Question | Who decides | Read |
| --- | --- | --- |
| How a merchant answers a buyer in a dispute when the buyer is a program and no person writes to support | product owner | — |
| Whose contact details a purchase carries, the agent's or the person's behind it, and so whom the merchant writes to | product owner | — |
| What happens when a subscription good runs out: an agent bought a month of access, and what then | product owner | — |
| What Agentify promises a merchant for the time Agentify itself is silent or down | product owner | — |
| The legal and tax frame of a sale: who the seller is, what document the merchant's accounting receives, how a stablecoin sale is reported | product owner | — |
| Who "we" are for a merchant: the legal identity the documentation and the legal pages name | product owner | — |
| Whether there is an honest way to keep a merchant visible on an empty market, since buying from oneself is ruled out | product owner | — |
| How agents rank cards and compare prices in a catalogue, and what that asks of a card | product owner | `02-agentic-storefronts.md` |
| How a card is withdrawn from an outside catalogue such as the x402 Bazaar once it is listed there | product owner | `04-spike-bazaar-listing.md` |
| What the front page of `agentify.ad` shows: the scanner, as now, or the merchant landing at `/sell`; the release preflight requires the scanner there today (`AGENTIFY_FRONT_PAGE`) | product owner | — |
| ~~How the site's header, the dashboard's menu of sections and the menu on a phone fit together~~ — one bar on every page: the site's offers on the left, Docs, Dashboard, Admin and the account menu on the right, the rest in the menu on a phone (2026-10-26) | product owner | `86-one-bar.md` |
| One look for links on the whole origin: the shared stylesheet underlines a link in running text, and the scanner reverts every link to the browser's look | product owner | — |
| Paging and search in the dashboard's lists of cards, orders and receipts, which hold hundreds of orders without breaking but let one be found only by eye | product owner | — |
| Selling through a WooCommerce shop and one's own code at once: the design is ready (a card remembers the integration that published it, one queue per integration) and is built when a real merchant needs it | product owner | ADR-0036 |
| Whether a merchant sees the exchange rates their WooCommerce shop has had, in one place: every saved rate is kept as its own version, each order shows the rate it was paid at, and each change is mailed with the previous rate, but no screen lists them | product owner | — |
| How a connected WooCommerce shop's cards follow its products as they are added, changed and removed; today only a manual import, which takes nothing off sale | product owner | ADR-0023 |
| How a "not available" answer to a price check gives its reason, so an agent can tell "out of stock" from "not shipped there" and from "the address lacks what the merchant needs" | product owner | `37-physical-goods.md` |
| Whether an order's other `params`, such as the email an eSIM card asks for, are erased the way a parcel's address is | product owner | ADR-0032 |
| A seller's name and site are read as they are now, also in orders already delivered, so a renamed seller shows the new name on an old order | product owner | ADR-0034 |
| How a merchant completes full offboarding without staff, preserving accepted orders and payment history; pausing and revoking keys do not delete an account | product owner | `54-self-service.md` |
| Whether a merchant is also told by mail when they are admitted, when their admission is withdrawn, with its note, or when a key of theirs is disabled; their dashboard shows a withdrawal and its note | product owner | `85-operator-admin.md` |
| Whether a merchant whose admission was withdrawn stays under "Needs you", where they count again today because they have a seller name and a payout wallet and are not admitted | product owner | `85-operator-admin.md` |
| Whether an operator is told by mail or a message when something in the admin needs a look, or finds it only by opening the admin; nothing in the product alerts anybody today | product owner | `85-operator-admin.md` |
| How fresh a sign-in an administrative action asks for, fifteen minutes or another window, and whether reading the admin asks for one too | product owner, with the architect | `85-operator-admin.md` |
| Whether the admin reads the splits' balances from the chain, so that the commission Agentify has received is a figure rather than a link to the explorer | product owner | `85-operator-admin.md` |
| Who answers the access requests the scanner records through the route its privacy page names; the scanner's page counts them and nothing records an answer | product owner | `85-operator-admin.md` |
| ~~How the purchase door keeps unpaid price questions from loading a merchant's shop without letting anybody stop that merchant's sales for free; the limit of fifty purchases waiting for payment still lets them, and the product owner does not accept that (2026-10-26)~~ | product owner | `87-unpaid-price-questions.md`, ADR-0043; resolved by the stateless-price design, ADR-0049 |
| How a merchant learns that their price handler is failing, once a purchase refused at its price question leaves no order behind: a handler that goes silent or answers wrongly now shows only as sales that do not happen | product owner | `87-unpaid-price-questions.md` |
| Whether a buyer paying from a contract wallet, such as a Safe or a wallet signing through ERC-6492, may be told that the seller is busy: a payment whose signature is not the paying wallet's own key waits in a small line of its own for each merchant, and anyone can fill that line for free. The product owner agreed on 2026-10-28 to leave it so and keep the question open | product owner | ADR-0043 |
| A limit per sender address at the edge, such as Cloudflare in front of the purchase routes: a stream of payments from freshly made empty wallets, about 25 a second at one merchant, fills that merchant's wallet reads and its small line, so its first-time buyers are told the seller is busy while the stream lasts. Money is safe and other merchants are unaffected; only the sender's address tells such a stream apart. The product owner agreed on 2026-10-28 to release with this and make the edge limit the next step ("согласен") | product owner | `90-unpaid-price-questions-design.md` |

## Money

| Question | Who decides | Read |
| --- | --- | --- |
| How regulation reads money that waits in a merchant's split before a payout; the first live merchant is approved after this is answered | product owner | `47-commission-in-the-product.md` |
| Whether Coinbase Wallet pays the network fee in USDC with no paymaster of ours, and what a first payout does when the wallet holds no USDC yet; checked by hand on the test channel | product owner | `48-merchant-wallet-onboarding.md` |
| Who pays for the purchase that first lists a card in the Bazaar, which at a real price sends the merchant its own price from Agentify's wallet | product owner, when a merchant with expensive goods arrives | `04-spike-bazaar-listing.md` |
| Whether an Indonesian merchant may accept USDC through Agentify for goods priced in rupiah, given the Currency Law's requirement of the rupiah for payments in Indonesia and Bank Indonesia's position that crypto assets are not a means of payment, and what that makes of Agentify's own part; answered before an Indonesian shop sells on the live channel | product owner, with legal counsel | `58-woo-shop-currency.md` |
| Whether one wallet's purchases at once are limited where a card is charged after its goods: each signature passes the payment check against the same balance, the merchant makes the goods for each, and only one charge goes through. The buyer gets none of the unpaid goods, so the cost is the merchant's making them; x402's own server does not limit this either. Left open until a merchant whose goods cost money to make sells that way | product owner | `87-unpaid-price-questions.md` |

## Known limits of parcels

Parcels sell on the live channel as on the test one (the product owner,
2026-10-26), so these no longer hold them off it. Each stays the product
owner's to decide, and until then is a limit a parcel sells with.

| Question | Who decides | Read |
| --- | --- | --- |
| How long a merchant has to ship: the connector publishes every parcel with seven days, a constant of its own rather than the merchant's word | product owner | ADR-0023 |
| Whether to translate a region's code by the shop's own list, since WooCommerce writes the regions of 37 of its 69 listed countries its own way and an agent naming such a region is told "not available" | product owner | `41-woo-parcel-probe.md` |
| Whether the guest sessions the connector keeps in a merchant's shop are acceptable, each holding the last destination priced in it for up to 48 hours: usually sixteen or fewer, at most about 300; and whether the connection screen says so | product owner | `41-woo-parcel-probe.md`, `90-unpaid-price-questions-design.md` |
| ~~What a paid parcel order does when the shop has no usable paid cart free: today it answers nothing and spends one of its hand-overs~~ — paid orders keep being handed over to the merchant for up to three hours (the product owner, 2026-10-28) | product owner | `90-unpaid-price-questions-design.md` |
| How slow a shop may be: a parcel's price is several requests to the shop within the nine seconds the connector gives a price question, 0.9–2.8 seconds each from outside, so a slow shop loses sales to "not available" | product owner | `41-woo-parcel-probe.md` |
| The backups taken before a buyer's address is erased, which keep it with no upper bound: the portal and the contract say so since 2026-10-26, and whether a retention bounds every copy is open | product owner | ADR-0029 |

## Engineering

| Question | Who decides | Read |
| --- | --- | --- |
| ~~How merchant closure is represented in the state machine, API, SDK, statuses and receipts~~ — `order.close()` and the Agentify Orders action record attributed closure, retain independent original payment facts, and refuse already-delivered or shipped orders (2026-10-19) | architect | ADR-0028, `54-self-service.md` |
| Which of Agentify's deadlines a merchant must see or name: two default silently from the gateway's settings and the synchronous budget is not expressed in a card at all | architect, as a decision | — |
| Which rules the rewrite of the decision on signing in dropped that the code still keeps — the process log as the only record of who stopped sales, one person per merchant with no roles — and recording those that stand | architect | ADR-0026 |
| When to stop reading a card as it is now for orders recorded before 2026-10-10, which keep no result of their own: once no channel holds such an order | engineering, by a query on each channel | — |
| Reminders a dying process leaves claimed: up to 20 stay active until pg-boss expires them, 15 minutes by default, so a deadline can close that much later | engineering, by a database test | — |
| Whether a scan left `queued` with no job in the queue ever finishes | engineering, by a test | — |
| What `/.well-known/x402` should serve; it answers 404, and agents find the catalogue through `/x402` and `/llms.txt` | engineering | — |
| How the scanner's limits stated on its documentation page are held equal to the worker's literals, which no test compares | engineering | — |
| How the release preflight's fixtures, snapshots of `docker compose config` taken by hand, are kept in step with `compose.yaml`; their synthetic encryption key also decodes to 33 bytes where the scanner needs 32 | engineering | — |
| A test path for the idempotency of `verify`, which no route can reach without a live payment | engineering | — |
| Whether Coinbase's facilitator refuses an empty wallet's payment at verification or only at settlement on Base; on Base Sepolia it refused at verification without naming a cause | engineering, by a measurement | `90-unpaid-price-questions-design.md` |
| How a flood of purchase requests for one merchant is kept from slowing every other merchant's sales through the one database pool they share: an unpaid request reads the card and the merchant before any limit can refuse it | architect | `87-unpaid-price-questions.md` |
| How a flood of signed payments for one merchant is kept from using up the payment facilitator's rate limit, which every merchant's payments share through one key: which of our own checks come before the facilitator is called, and how many of its calls one merchant may hold at once | architect | `87-unpaid-price-questions.md` |
| How a test earns trust beyond its author's word. The test-audit skill and the mutation self-check at hand-over ask whether a test guards behaviour, and a test can kill its mutants while what it says about the outside world is false, as tests that refused XAF and IDR as currencies Coinbase gives no rate for did. For Coinbase's exchange rates, WooCommerce's own words and the payment facilitator's refusal codes, tests take such facts from recorded answers kept with their source and date, which `pnpm smoke:recorded` compares with the services every week; the other rules that touch the outside world (real examples in the charter, reading the real dependency in test-audit) are text that no check enforces. Four parts are open: recorded answers for the services whose stand-ins are not recorded yet; mutation testing as a regular measure, since `pnpm mutate` exists and runs only by hand; which rules stay text in the charter and which become a gate in CI; and running the existing tests through what is chosen | product owner, with the architect | `27-stryker-spike.md`, `2026-10-27-test-audit.md`, `92-outside-service-facts.md` |
| Whether the Bazaar's crawler accepts a card at a real listing; its validator accepts the declaration on both methods | a real listing | `26-discovery-method-on-get.md`, ADR-0012 |
| How the Bazaar indexes a card whose `payTo` is a merchant's split; only a payment for a real card on production shows it | a real listing | `47-commission-in-the-product.md` |
| Whether the Bazaar indexes a payment settled on the testnet or only on mainnet; `pnpm smoke:bootstrap` measures it, from a place allowed to hold the facilitator's credentials | engineering, by a measurement | `04-spike-bazaar-listing.md` |
| When to move backups from dumps to WAL archiving: when a dump takes more than about a minute, or the recovery point must be under ten minutes | operator | `44-production-backups.md` |
| Why images arrive slowly from the GitHub Container Registry on TEST | operator | `52-release-delivery.md` |
| When the volumes the move to one database left on both hosts, kept as a way back, are archived and removed | operator | — |
| When production moves from Base's free public endpoint to a keyed RPC endpoint, now that payers' wallet reads, payment recovery, returned purchases and the payout figure all share it | operator | `90-unpaid-price-questions-design.md` |
| How the ad tracker answers a `reg` posted a second time for the same click; an answer other than 200 refuses that registration report and loses the sign-up's `lead` | the tracker's team, asked | ADR-0039 |
