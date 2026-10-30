# Merchant onboarding implementation

The accepted onboarding path is built in seven slices. Each slice keeps a
working end to the path and adds its states to the product gallery. Approval
of a layout does not establish that a provider call, a payment or a delivered
email works.

| Slice | Scope | State |
| --- | --- | --- |
| 1 | Seller site from the confirmed shop origin | Implemented on the branch |
| 2 | Next-step function, platform choice, code instructions, test acknowledgement | Implemented on the branch; analytics belongs to authorised slice 8 |
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

## Slice 2: the next step

`nextStepOf` reads the publication rule in the core and selects a page and at
most one account-banner reason. Before a product exists, account requirements
stay on the setup page. Withdrawal and an unread account remain global notices.
The frame has a two-second read budget. Its product-presence check uses an
existence query for the active integration, and key metadata is read only for
the empty code path; ordinary pages receive no catalogue payload for the banner.

The platform answer and test acknowledgement belong to the signed-in account.
Authentication input cannot set them. Historical keys suppress the initial
question and the before-first-key navigation, while revoked keys do not satisfy
the active-key step. Opening another choice is a GET and keeps the saved answer;
only pressing a platform tile writes an answer. Existing connections and code
contact take precedence over an unanswered question.

Products draws the existing WooCommerce screens and their actions in its own
section. Integrations still opens the connector in its section. The code path
and API keys share key creation and the protected one-time disclosure. Its
native dialog keeps background controls inert, traps keyboard focus and closes
through Done. The static gallery and browsers without script draw the same
markup with a scrim; without script the existing issued-key page remains.
The test acknowledgement persists only after its explicit checkbox and press.

The current live endpoint is still email approval. A connected code integration
first puts any missing name or wallet right in Settings, then asks for approval;
an approved account with its profile ready gets the publishing guide. Settings
keeps its existing saving wallet button. No admission request or operator flow
from a later slice is introduced here.

The quickstart starts the existing order worker before publication, so its
first poll can establish contact before the reader returns to Settings for a
wallet. Publication is step 4, at `#_4-publish-one-card`; references in the buyer
program follow the worker's step 3. This uses the existing SDK and poll rules,
with no extra connection call. The documentation's How to start section explains
optional practice and the separation between the two accounts.

| Choice | Reason | Alternative considered |
| --- | --- | --- |
| Keep platform intent on the account | A return on another device sees the same answer | Store it in a browser preference |
| View alternatives without clearing the answer | Back and reload retain the merchant's choice | Reset the stored answer on navigation |
| Reuse the existing shop screens inside Products | The platform tile reaches the shop form directly | Add an intermediate connector door |
| Read existence instead of the full catalogue for the frame | Page navigation stays small as product counts grow | Read and validate every card on every page |
| Protect secrets with the same native dialog in both sections | Copy, leave, Back and Done follow one lifecycle | Create a second secret-disclosure implementation |
| Start the worker before asking the code path to finish its profile | The existing poll establishes contact without a published card | Add a new public probe or publish before its prerequisites |

Local verification covers the full offline suite: 381 test files and 6,951
unit tests, plus nine scanner operations tests. Three Chromium cases cover
native focus containment, explicit test acknowledgement, post-close focus,
reload secret handling and a 100-character key name on a phone. The route tests
cover Back and the page lifecycle that removes a cached secret. The two
focused PostgreSQL cases cover cross-instance persistence, the stored platform
constraint and product existence across merchant and integration boundaries;
the disposable test container is removed. The portal build verifies its seven
included examples and programs. The next-step quiet-bar mutation is killed by
16 tests, and the original source is restored byte for byte.

The gallery has 357 states. The builder captures seven changed states at 1440,
1024, 768 and 375 pixels, with a separately labelled long-key-name case and a
200% CSS zoom check. This is builder verification; independent visual review
and real newcomer acceptance remain separate. The bar uses the gateway's
sale-blocking silence fact, including the case where stale contact must not
hide unserved orders behind individually paused products.

Three independent reviewers inspect those 28 first viewports before reading
the sources. They find the npm package name broken across lines at 375px.
The package name now stays on one line, while the command can wrap at its
spaces. This follows the interface-review rule for identifiers; shrinking the
command's font is rejected. The gallery rebuild passes. A new screenshot of
this correction remains unverified: the browser's automatic URL review
rejects opening its local file. Keyboard and native-dialog evidence above
comes from the separate Chromium integration run, not the screenshots.

Platform, Connect and practice analytics belong to the authorised eighth
slice, which collects the path vocabulary, events, contract tests and
ADR-0042 together. The optional practice link goes directly to the existing
How to start documentation. No empty tracking route is kept. This slice does
not count those actions, and no claim about their frequency follows from it.

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
