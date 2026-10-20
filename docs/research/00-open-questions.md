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
| How the site's header, the dashboard's menu of sections and the menu on a phone fit together | product owner | — |
| One look for links on the whole origin: the shared stylesheet underlines a link in running text, and the scanner reverts every link to the browser's look | product owner | — |
| Paging and search in the dashboard's lists of cards, orders and receipts, which hold hundreds of orders without breaking but let one be found only by eye | product owner | — |
| Selling through a WooCommerce shop and one's own code at once: the design is ready (a card remembers the integration that published it, one queue per integration) and is built when a real merchant needs it | product owner | ADR-0036 |
| How a connected WooCommerce shop's cards follow its products as they are added, changed and removed; today only a manual import, which takes nothing off sale | product owner | ADR-0023 |
| How a "not available" answer to a price check gives its reason, so an agent can tell "out of stock" from "not shipped there" and from "the address lacks what the merchant needs" | product owner | `37-physical-goods.md` |
| Whether an order's other `params`, such as the email an eSIM card asks for, are erased the way a parcel's address is | product owner | ADR-0032 |
| A seller's name and site are read as they are now, also in orders already delivered, so a renamed seller shows the new name on an old order | product owner | ADR-0034 |
| How a merchant completes full offboarding without staff, preserving accepted orders and payment history; pausing and revoking keys do not delete an account | product owner | `52-self-service.md` |

## Money

| Question | Who decides | Read |
| --- | --- | --- |
| How regulation reads money that waits in a merchant's split before a payout; the first live merchant is approved after this is answered | product owner | `47-commission-in-the-product.md` |
| Whether Coinbase Wallet pays the network fee in USDC with no paymaster of ours, and what a first payout does when the wallet holds no USDC yet; checked by hand on the test channel | product owner | `48-merchant-wallet-onboarding.md` |
| The smallest price production settles: the facilitator refuses amounts under a minimum it does not publish while publication accepts 0.001 USD, and production is not to be measured (2026-09-25), so this returns when a merchant prices under a cent | product owner | `36-zero-price.md` |
| Who pays for the purchase that first lists a card in the Bazaar, which at a real price sends the merchant its own price from Agentify's wallet | product owner, when a merchant with expensive goods arrives | `04-spike-bazaar-listing.md` |

## Before parcels sell on the live channel

The test channel can put these off and the live one cannot; each is the product
owner's to decide before a WooCommerce shop's parcels sell for real money.

| Question | Who decides | Read |
| --- | --- | --- |
| How long a merchant has to ship: the connector publishes every parcel with seven days, a constant of its own rather than the merchant's word | product owner | ADR-0023 |
| Whether to translate a region's code by the shop's own list, since WooCommerce writes the regions of 37 of its 69 listed countries its own way and an agent naming such a region is told "not available" | product owner | `41-woo-parcel-probe.md` |
| Whether the guest session each price question leaves in the merchant's shop for 48 hours, with the destination in it, is acceptable, and whether the connection screen says so | product owner | `41-woo-parcel-probe.md` |
| How slow a shop may be: a parcel's price is several requests to the shop within five seconds, 0.9–2.8 seconds each from outside, so a slow shop loses sales to "not available" | product owner | `41-woo-parcel-probe.md` |
| The promise to erase a buyer's address against the backups taken before the erasure, which have no upper bound: a caveat in the documentation, or a retention that bounds every copy | product owner | ADR-0029 |

## Engineering

| Question | Who decides | Read |
| --- | --- | --- |
| ~~How merchant closure is represented in the state machine, API, SDK, statuses and receipts~~ — `order.close()` and the Agentify Orders action record attributed closure, retain independent original payment facts, and refuse already-delivered or shipped orders (2026-10-19) | architect | ADR-0028, `52-self-service.md` |
| Which of Agentify's deadlines a merchant must see or name: two default silently from the gateway's settings and the synchronous budget is not expressed in a card at all | architect, as a decision | — |
| Which rules the rewrite of the decision on signing in dropped that the code still keeps — the process log as the only record of who stopped sales, one person per merchant with no roles — and recording those that stand | architect | ADR-0026 |
| When to stop reading a card as it is now for orders recorded before 2026-10-10, which keep no result of their own: once no channel holds such an order | engineering, by a query on each channel | — |
| Reminders a dying process leaves claimed: up to 20 stay active until pg-boss expires them, 15 minutes by default, so a deadline can close that much later | engineering, by a database test | — |
| Whether a scan left `queued` with no job in the queue ever finishes | engineering, by a test | — |
| What `/.well-known/x402` should serve; it answers 404, and agents find the catalogue through `/x402` and `/llms.txt` | engineering | — |
| How the scanner's limits stated on its documentation page are held equal to the worker's literals, which no test compares | engineering | — |
| How the release preflight's fixtures, snapshots of `docker compose config` taken by hand, are kept in step with `compose.yaml`; their synthetic encryption key also decodes to 33 bytes where the scanner needs 32 | engineering | — |
| A test path for the idempotency of `verify`, which no route can reach without a live payment | engineering | — |
| Whether the Bazaar's crawler accepts a card at a real listing; its validator accepts the declaration on both methods | a real listing | `26-discovery-method-on-get.md`, ADR-0012 |
| How the Bazaar indexes a card whose `payTo` is a merchant's split; only a payment for a real card on production shows it | a real listing | `47-commission-in-the-product.md` |
| Whether the Bazaar indexes a payment settled on the testnet or only on mainnet; `pnpm smoke:bootstrap` measures it, from a place allowed to hold the facilitator's credentials | engineering, by a measurement | `04-spike-bazaar-listing.md` |
| When to move backups from dumps to WAL archiving: when a dump takes more than about a minute, or the recovery point must be under ten minutes | operator | `44-production-backups.md` |
| Why images arrive slowly from the GitHub Container Registry on TEST | operator | `52-release-delivery.md` |
| When the volumes the move to one database left on both hosts, kept as a way back, are archived and removed | operator | — |
