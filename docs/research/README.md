# Research

This folder holds the evidence behind the decisions in
[`docs/decisions/`](../decisions/): the measurements, experiments and surveys
a decision cites, so that somebody outside the team can check why a thing was
decided the way it was. It also holds the design notes on screens, flows,
internal mechanics and operations, which are rewritten freely and need no
decision of their own. What a merchant reads is the documentation at
[agentify.ad/docs](https://agentify.ad/docs/), not this folder, and the
questions nobody has decided yet are in
[`00-open-questions.md`](00-open-questions.md).

A note is current when it describes how things are or holds evidence that
still bears on a decision. A note is historical when what it describes has
moved on; it stays because a decision cites it or because it records a
measurement of its day, and it opens with one line saying what replaced it.
Working material that supports no decision, such as session notes, reviews of
drafts and retrospectives, does not stay here, and git keeps what was removed.
Notes are numbered in the order they were written. Three numbers, 34, 47 and
49, went to two notes each, which is why every citation uses the whole file
name. Notes written in Russian stay in Russian.

| Note | What it is | Decisions it supports | Language | Status |
| --- | --- | --- | --- | --- |
| [00-open-questions](00-open-questions.md) | the questions not decided yet, with who decides each | — | English | current |
| [02-agentic-storefronts](02-agentic-storefronts.md) | where AI agents found goods to buy, as of August 2026 | — | Russian | historical |
| [03-freeland-pilot](03-freeland-pilot.md) | the pilot merchant as the project first saw it | ADR-0002 | Russian | historical |
| [04-spike-bazaar-listing](04-spike-bazaar-listing.md) | a spike of listing in the x402 Bazaar, end to end | ADR-0006, ADR-0012 | Russian | historical |
| [05-merchant-contract](05-merchant-contract.md) | the merchant's contract and experience, drafted before the decisions | ADR-0002 | Russian | historical |
| [06-prior-art-web2](06-prior-art-web2.md) | how ordinary online shops reach agent and crypto payments elsewhere | — | Russian | historical |
| [07-custody-spectrum](07-custody-spectrum.md) | what holding money would take on this architecture | ADR-0019 | Russian | historical |
| [11-freeland-api-facts](11-freeland-api-facts.md) | what the pilot asked of the contract | ADR-0002 | Russian | historical |
| [12-big-players-merchant-integration](12-big-players-merchant-integration.md) | how large platforms take a merchant's catalogue: push, pull, price checks | ADR-0002, ADR-0004 | Russian | historical |
| [14-integration-model](14-integration-model.md) | the merchant integration model as first argued | ADR-0002 | Russian | historical |
| [15-culture-stack-position](15-culture-stack-position.md) | a position on working culture and stack | ADR-0003 | Russian | historical |
| [16-order-state-machine](16-order-state-machine.md) | the first design of the order state machine | ADR-0002 | Russian | historical |
| [24-stand-boundary](24-stand-boundary.md) | what the stand, the local three-seat console, proves and does not | — | Russian | current |
| [25-what-the-challenge-says](25-what-the-challenge-says.md) | what live x402 resources write in a payment challenge | — | Russian | historical |
| [26-discovery-method-on-get](26-discovery-method-on-get.md) | an experiment on which method a card's declaration names | ADR-0012 | Russian | historical |
| [27-stryker-spike](27-stryker-spike.md) | a spike of Stryker for the mutation check | — | Russian | historical |
| [29-woo-product-acceptance-protocol](29-woo-product-acceptance-protocol.md) | the protocol of a WooCommerce run on the test channel | — | English | historical |
| [30-woo-product-acceptance-report](30-woo-product-acceptance-report.md) | the report of that run | — | English | historical |
| [31-user-journey](31-user-journey.md) | the path through the site's screens, as designed in September 2026 | — | English | historical |
| [33-woo-connect-probe](33-woo-connect-probe.md) | a probe of connecting WooCommerce without a plugin | ADR-0023 | Russian | historical |
| [34-one-database](34-one-database.md) | how two databases became one | ADR-0003 | English | current |
| [34-refund-due](34-refund-due.md) | September observations and comparisons of unfulfilled orders | ADR-0028 | English | historical |
| [35-one-process](35-one-process.md) | the gateway and the dashboard in one process, and the survey before the move | ADR-0003, ADR-0005, ADR-0006, ADR-0014, ADR-0019, ADR-0023, ADR-0026 | English | current |
| [36-zero-price](36-zero-price.md) | what a zero or tiny price means in x402 | ADR-0002 | Russian | current |
| [37-physical-goods](37-physical-goods.md) | selling physical goods: the address, the shipment, the seller's site | ADR-0032 | English | current |
| [38-service-commission](38-service-commission.md) | ready contracts for taking a commission on each payment | ADR-0037 | Russian | historical |
| [39-commission-split-experiment](39-commission-split-experiment.md) | a payment into a PullSplit on Base Sepolia, pre-registered, with its data | ADR-0037 | Russian | historical |
| [40-confirmation-mode-seam](40-confirmation-mode-seam.md) | the seam left for fulfillment against the merchant's confirmation, before the mode was deleted | — | English | historical |
| [41-woo-parcel-probe](41-woo-parcel-probe.md) | a probe of parcels through a WooCommerce shop, with its script | ADR-0023 | English | current |
| [42-manual-test-plan](42-manual-test-plan.md) | the manual test plan for the whole product | — | English | current |
| [43-one-frontend-stack](43-one-frontend-stack.md) | the pre-registered spike that put every surface on React Router | — | English | historical |
| [44-production-backups](44-production-backups.md) | how production is backed up off the host | ADR-0029 | English | current |
| [45-stack-toolchain](45-stack-toolchain.md) | the toolchain and the rule against building infrastructure by hand | ADR-0003, ADR-0004 | Russian | current |
| [46-charge-answer-timing](46-charge-answer-timing.md) | the measurements behind the gateway's waits for a charge's answer, and how the synchronous ceiling is divided | — | English | current |
| [47-commission-in-the-product](47-commission-in-the-product.md) | the design of the commission across the product, with an English summary | ADR-0037, ADR-0038 | Russian | current |
| [47-one-docs-stack](47-one-docs-stack.md) | the pre-registered spike that moved the documentation to React Router | — | English | historical |
| [48-merchant-wallet-onboarding](48-merchant-wallet-onboarding.md) | a payout wallet for a merchant new to crypto, and the product owner's answers | ADR-0005 | English | current |
| [49-ci-runtime](49-ci-runtime.md) | how long CI took and what made it faster | — | English | historical |
| [49-lighthouse](49-lighthouse.md) | Lighthouse scores of the public pages, with [the raw results](49-lighthouse-results.csv) | — | English | historical |
| [50-commerce-correctness-test](50-commerce-correctness-test.md) | defects a correctness test found in the purchase path, and their fixes | ADR-0012 | English | current |
| [52-release-delivery](52-release-delivery.md) | what the move to images built once in CI measured | ADR-0016 | English | current |
| [53-self-hosted-observability](53-self-hosted-observability.md) | how the logs and host telemetry of both channels reach the shared self-hosted observability stack | — | English | current |
| [54-self-service](54-self-service.md) | self-service responsibilities, merchant closure boundary and payment recovery evidence | ADR-0023, ADR-0027, ADR-0028 | English | current |
| [55-sign-in-mail-limits](55-sign-in-mail-limits.md) | how many sign-in and report links the dashboard mails, and what the channel's ceiling protects and costs | — | English | current |

The folders beside some notes hold their data and scripts:
`39-commission-split-experiment/`, `41-woo-parcel-probe/`,
`43-one-frontend-stack/` and `47-one-docs-stack/`.
