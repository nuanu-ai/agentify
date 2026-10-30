# Merchant onboarding implementation

The accepted onboarding path is built in seven slices. Each slice keeps a
working end to the path and adds its states to the product gallery. Approval
of a layout does not establish that a provider call, a payment or a delivered
email works.

| Slice | Scope | State |
| --- | --- | --- |
| 1 | Seller site from the confirmed shop origin | Implemented on the branch |
| 2 | Next-step function, platform choice, code instructions, test acknowledgement | Pending |
| 3 | Public catalogue assessment before asking for access | Pending |
| 4 | Stored shop jobs, automatic checks, grouped results and synchronization | Pending |
| 5 | Request for live sales, seller name, wallet after request, operator decision | Pending |
| 6 | Publication after approval or first wallet, decision emails | Pending |
| 7 | Withdraw a shop product when a purchase confirms it is no longer sold | Pending |

## Slice 1: the seller site

A callback that consumes a valid connection grant with read and write access
also fills a missing seller site from that connection's origin. Neither the
callback body nor a retry form can choose a different origin. A site already
chosen in Settings survives a concurrent fill: the comparison and write share
the existing merchant row lock. The public API schemas and SDK stay unchanged;
the additional entry point in ADR-0034 is recorded in the same change.

Once the connection has been saved, a failed site write cannot fail the
callback: WooCommerce would revoke the access it just granted. The connected
page instead offers a retry based on the site currently stored. A timed-out
write has an unknown outcome and may finish later. A site that cannot be read
fails the page rather than looking absent. Import checks for a missing site
before reading any shop product.

The gallery and the callback tests read the same three scenarios in
`apps/dashboard/src/testing/woo-site-cases.ts`: empty site, existing different
site, failed write. A fourth gallery state shows a connected shop with a port.
The connection remains valid, while the seller-site rule points to Settings.

| Decision | Rule | Alternative considered |
| --- | --- | --- |
| Compare emptiness inside the existing store write | Preserve the seller's choice, including concurrent Settings saves | Read the site and then assign it unconditionally |
| Retry uses only the stored connection origin | The confirmed grant identifies the shop | Accept a hidden origin field from the browser |
| Derive retry from the current empty site | Use existing facts; no new durable milestone | Store a second site-write status beside the connection |
| Show site recovery before import or rate forms | One primary action for the blocking step | Leave several filled actions beside a disabled import |
| Show the site notice on return only when it matches the stored site | The screen describes a fact it has read | Claim that every callback saved the site |
| Use the existing filled link style for Settings | Buttons and links §6 | Draw the only next step as plain text |
| Preserve the gateway's uncertainty message | A timeout does not establish a failed write | Replace every unsuccessful answer with a definite failure |

## Implementation corrections accepted on 30 October

Settings retains its existing wallet panel. Its **Change wallet** button saves
the new address; this work adds no separate wallet editing page.

Product counts use English thousands separators, including assessment, results,
emails and Needs you. One additional product reads “1 more can go on sale once
you fix it in your shop”; plural counts use “fix them”. The Products summary
follows the same agreement, with tests for one and two.

The operator's request block uses the page's existing fact pairs: Asked,
Seller name, Products and Payout wallet. “No payout wallet yet” uses the normal
text face; a wallet address uses the monospaced face. **Check again** follows
the “Checked …” line directly instead of being pushed to the opposite edge.

Slice 3 uses IRT for the absent Coinbase reference-rate example. XAF has a
reference rate and is not a truthful example of that refusal. These corrections
are applied in the slices that implement the corresponding screens.
