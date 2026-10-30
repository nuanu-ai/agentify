# Merchant onboarding implementation

The accepted onboarding work is built in eight slices. The first seven build
the functional path; the eighth adds its analytics together. Each functional
slice keeps a working end to the path and adds its states to the product gallery. Approval
of a layout does not establish that a provider call, a payment or a delivered
email works.

| Slice | Scope | State |
| --- | --- | --- |
| 1 | Seller site from the confirmed shop origin | Implemented on the branch |
| 2 | Next-step function, platform choice, code instructions, test acknowledgement | Implemented on the branch; analytics belongs to authorised slice 8 |
| 3 | Public catalogue assessment before asking for access | Engineering checkpoint; protected catalogue dependency remains in slice 4 |
| 4 | Stored shop jobs, automatic checks, grouped results and synchronization | Pending |
| 5 | Request for live sales, seller name, wallet after request, operator decision | Pending |
| 6 | Publication after approval or first wallet, decision emails | Pending |
| 7 | Withdraw a shop product when a purchase confirms it is no longer sold | Pending |
| 8 | Path analytics vocabulary, events, contract tests and ADR-0042 | Authorised; pending |

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

## Slice 3: check the public catalogue before access

Check my shop reads at most the first 100 public products in one request.
The same answer supplies the catalogue count, the currency sample and its
written decimals. A missing, invalid or contradictory count stays unknown.
A partial list retains its total and read count even when none of the read
products looks ready. A successful empty list differs from a blocked or
unreadable list. Known count and price facts survive missing readiness fields,
so an unread estimate cannot silently bypass the size or currency door.

The estimate infers managed stock only for products in stock and not on
backorder, from nonempty availability text or a non-null low-stock quantity,
including zero. Its groups are disjoint: unavailable is tested before variable,
then inferred stock, then a ready simple product. A variable product out of
stock is counted as unavailable. The alternative was to put every variable
product in options regardless of availability; the selected order avoids
counting a product twice. The estimate does not invent the private shipping,
download or tax facts checked after connection.

The address accepts bare hosts, http and a trailing slash, and shows the
normalized HTTPS origin without removing www. Credentials, paths, queries and
fragments keep the address refusal. HTML from WordPress at status 200 or 404
is the Plain-permalink refusal; a forbidden response remains unknown even if
it carries WordPress assets, since a firewall can serve that page. A readable
HTML page without WordPress traces asks the merchant to check the shop address.
No second WordPress or grant-page probe runs on the first Check.

The one form keeps its result between the address and its button. Editing
invalidates it immediately. Without script, Connect carries the checked
origin; a different origin checks again and cannot receive a grant. Every
explicit Connect repeats the read-only size, currency, current-shop and open
orders guards. Only after that does it inspect the actual approval page and
persist the existing one-time grant. A refusal of the approval page keeps the
estimate and Connect shop; a check-stage refusal keeps Check my shop. The
sentence about the upcoming WooCommerce approval appears only with a current
assessment and Connect shop; the test-purchase warning also appears before
the first check. Less than Read/Write access remains a warning, and a
write-only grant is not called read-only.

All reads needed for the response, including the existing shop view, share
one fifteen-second budget. The answer is drawn from those collected facts,
without repeating gateway, catalogue or reference reads after the check. An
unread account is a failed account read, rather than a guessed empty shop.
The outer check starts no subsequent stage after its deadline, and late results cannot issue a grant. The existing
signed-in frame retains its own bounded read and rendering lifecycle.

IRT is the unsupported-rate example. The product owner verified Coinbase's
USD rates on 30 October 2026: IRR and XAF are present, IRT is absent. This is
an observed example, not a fixed list of currencies Coinbase supports. No
commerce-v1 path vocabulary or events are introduced here; they belong to the
authorised eighth slice.

The three equally weighted platform tiles remain an explicit product-owner
choice above the general one-filled-control rule. The inherited key window
keeps its disclosure through automatic polling until Done, pauses code polling
while a native dialog is open and resumes it afterward. It puts Copy and Done
in one final row, and the Node.js prerequisite precedes the
installation control, following the interface review's action-order rule.

Verification at this checkpoint includes 321 focused unit tests across seven
files, the workspace typecheck, the portal build with seven included examples
and programs, and four real Chromium cases. The new browser case uses the
actual application at four widths and verifies pending controls, edit
invalidation, Enter, result-before-action geometry and no grant from Check.
The other three retain native dialog and TEST acknowledgement proof after the
presentation fixes. Final proof and capture provenance accompany the handoff.

**Open dependency on slice 4:** the current full import still reads its list
through the anonymous Store API before protected per-product inspection. A
shop whose public list is closed has not been proved to complete the accepted
"After you connect, we read them directly" path. Slice 4 must supply the
protected catalogue read and its proof before this draft, undeployed task can
be described as ready for release. This slice does not claim end-to-end
acceptance of that branch, independent visual acceptance or live shop coverage.

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

## Dashboard script budget repair

The first-visit script check found that the shared frame imported the whole
onboarding screen for its test acknowledgement. The dashboard groups the
`app/components` directory into every merchant page's common chunk. Conditional
dialogs and account notices now live outside that directory, and their CSS
remains eager. The first-test acknowledgement loads when its facts require it. The account
banner stays in the initial graph: a paused account needs it on first hydration,
which the native browser owner verifies. The Products route similarly loads the WooCommerce or onboarding screen
only for its chosen branch. The server waits for the complete response, including where JavaScript is
disabled. React also outlines large completed Suspense boundaries into hidden
HTML that requires script to reveal. The renderer's internal progressive chunk
size now keeps these boundaries inline, matching the existing whole-page
response policy. The cold-browser owner detects the hidden-content case.

The shared key form and the one-time key disclosure are separate from the key
list. The disclosure remains a static dependency before Create key: an issued
secret does not depend on fetching a new module after the action. List tools
and the transaction renderer belong to the screens that use them rather than
the universal component chunk. The alternative was changing the chunk policy
or the 102 KiB budget; both stay unchanged.

Resolved content and CSS values are preserved. On client navigation, a first
visit may briefly show “Loading…” inside Products or “Loading your shop…”. A
first-test acknowledgement waits for its module on client navigation; the
account notice is eager. The server response already contains them on an ordinary page load. This does not
establish a new independent visual acceptance or browser zoom result.

The product owner authorises eight slices: the first seven implement the
functional path without new path instrumentation; slice 8 implements its
analytics vocabulary, events, contract tests and ADR-0042 together, incorporating
the analytics team's reply if it arrives. Existing unrelated events remain.


## Native first-visit budget correction

The initial route graph does not by itself describe every first visit. A paused
account rendered the conditionally loaded account notice immediately, and the
native browser correctly found scripts that the static graph called later. The
account notice is eager. Its heading formatter is separate from order vocabulary,
and order disclosure and copy controls belong to the screens that use them.

Products loads the catalog, onboarding or WooCommerce branch as needed. The
catalog's initial module is declared in the route handle and traversed by the
budget tool; a declared source missing from the build fails rather than being ignored. The
unchanged native equality checks the actual default visit against this graph.
The same 102 KiB limit is also checked against actual initial requests for code,
platform choice with TEST acknowledgement, Woo, and Woo with TEST and a paused
account. No filename whitelist or larger limit is used.

The code form and its disclosure load together before Create key. Native proof
requires issuance to fetch no new script, and an issued secret takes priority
over catalog or shop data that arrived with it. WooCommerce loads its disconnected or connected panels for the current state;
both keep the same shop context and eager CSS. The default disconnected module
is also declared in the route handle. Native measurements include TEST with a
paused account and each WooCommerce state. The import-result table and refusal
details load after their respective presses. The server still waits for
complete markup; no special server import or top-level await is added for the
tests. Existing screen assertions use asynchronous prerender, matching the
server's complete-render policy. Cold no-script refusal and denied clipboard
copy are exercised through the actual local application.

The client navigation assertion is isolated from asynchronous server prerender
in its own test file. The combined file reports a nested Router after asynchronous server prerender;
the unchanged client assertion passes alone. The two readers have separate test
environments.
No production workaround or weaker assertion is added for that interaction.
