# A merchant without a crypto wallet: three ways to one they can be paid in and spend from

Date: 2026-10-15. A research note for the product owner, which may be
rewritten. It compares ways a merchant who has never held cryptocurrency gets
from the dashboard's settings to money they can use, and ends with the
questions only the product owner can answer. It chooses nothing, and nothing
is built from it until the product owner has chosen.

## The question

The last step before a merchant publishes goods is the payout wallet: the
dashboard asks for an address on Base, the network buyers pay in, and refuses
to publish without one. A merchant who has never held cryptocurrency stops
there, because to answer they must leave the dashboard, choose a wallet, learn
what Base and USDC are and come back with an address. The product owner's
working hypothesis is that a merchant who can get a wallet without leaving the
dashboard will finish.

Getting a wallet is the first of three places such a merchant stops, and a
way through the first alone moves the stop to the place where money has
already arrived and cannot be used. The second place is receiving: a buyer
pays the merchant's split, a contract nobody owns that keeps the money until
some transaction pays the merchant's share out to their wallet
(`docs/decisions/0037-every-payment-goes-to-the-merchants-split.md`). The
third is turning USDC, a dollar token on the chain, into dollars in a bank.
Each way below is followed through all three.

## How far the sources go

The sources were read on 2026-10-15: Coinbase's developer documentation at
docs.cdp.coinbase.com, the terms of Coinbase Wallet, Coinbase's user agreement
for the European Economic Area of July 2025, Coinbase Exchange's public API,
and the published packages themselves. Coinbase's help centre,
help.coinbase.com, answers this environment only with a Cloudflare challenge,
so what it says is known here only from a search engine's summary of the page,
and is marked so. In September 2026 Coinbase renamed the product the
dashboard would open, Base Account, to Coinbase Wallet; the package keeps its
name, `@base-org/account`, and the old pages at docs.base.org now redirect to
docs.cdp.coinbase.com.

Each claim below carries one of four marks. [checked] means it was read in a
primary Coinbase source, in a package's code, or in this repository.
[snippet] means only a search result's summary of a Coinbase help page says
it. [inferred] means it is a conclusion that was not executed. [don't know]
means the sources were searched and say nothing; where they say that
something does not exist, the text says "checked: there is none" instead.

A few words are used throughout. USDC is a dollar token issued by Circle;
Base is the network buyers pay on, and Base Sepolia is its test network,
where USDC has no value. A passkey is a sign-in key a phone or computer keeps
and unlocks with a fingerprint, face or PIN. A smart account is a wallet that
is itself a contract on the chain, so it can batch calls and have its network
fee paid by someone else. An offramp is a service that sells the token for
money in a bank account. ETH is the currency Base charges its network fee in,
and a gwei is a billionth of one ETH. A faucet is a service that hands out
test tokens. An SDK is the code a provider gives a site to talk to its
service. Multicall3 is a public contract, not Agentify's, that runs a batch
of calls in one transaction. ADR-NNNN names a decision record in
`docs/decisions/`, and the operator is the person who runs Agentify's
deployment and, among other things, sends the payout of every split. The origin is the scheme, host and port a page is
served from; on Agentify one origin carries every surface, and a script
running in it acts with the merchant's session
(`docs/decisions/0005-web-surface.md`).

## What every way shares: the payout from the split

Whichever wallet the merchant ends up with, money reaches it the same way. A
buyer pays the merchant's split; the split holds the USDC until a payout,
one transaction that anybody may send, distributes it and withdraws the
merchant's share to their wallet (ADR-0037). Until then the merchant's wallet
shows nothing, whatever wallet it is: the money is in a contract, and the
dashboard links to that contract in a block explorer rather than reading its
balance (`docs/research/47-commission-in-the-product.md`, "What the merchant
sees"). The dashboard's payout instruction asks the merchant to send a
transaction to Multicall3 with data copied from the screen, from a wallet that
holds a little ETH on Base and lets data be pasted into a transaction. A
merchant who cannot do that is paid when Agentify next pays out every split,
on no set date.

What a payout costs was read on 2026-10-15 at 06:49 UTC: the price of gas on
Base and on Base Sepolia was 0.006 gwei, and Coinbase's spot price of ETH
was $2,352.99. With the gas figures of note 47 (measured there in a
simulation, without a record), a merchant's payout of one new split costs
about $0.0046, of a split already on the chain about $0.0019, and the
operator's payout of twenty new splits about $0.078 [inferred from those
figures; the fee Base adds for publishing data to Ethereum is not counted].
The money is not the obstacle. The obstacle is that the merchant needs ETH on
Base and a wallet that sends raw data, and the sections below say for each way
whether the merchant has them.

## Way 1: Coinbase Wallet, opened in Coinbase's window

The settings screen gets a button. Its click loads the Base Account SDK and
opens a Coinbase window at `keys.coinbase.com`, outside Agentify's origin,
where the merchant creates a wallet or signs in to one they have, and the
window hands the dashboard the wallet's address, which fills the existing
field.

**Getting the wallet.** Coinbase's developer documentation describes signing
in with a passkey, "no installs, seed phrases, or network switches" [checked,
`coinbase-wallet/overview`]; its help centre also describes email codes
[snippet]. What a brand-new user sees in today's window, a passkey first or an
email first, I don't know: it needs a live run. Neither a Coinbase.com account
nor an identity check is needed [snippet; the wallet's terms ask only that the
user be eighteen and not barred by sanctions law, checked]. A user who already
has a Coinbase Wallet gets that wallet back [checked, the brand guidelines], so
the button says "create or connect". The help centre warns that the account
follows the sign-in method, so a merchant who signs in another way than before
may get another address [snippet]. The address is a smart account that may not
exist on the chain until its first outgoing transaction [checked], and it can
receive USDC before then, because a token transfer runs no code at the
recipient [inferred]. Its factory has the same code on Base and Base Sepolia
[checked by reading both networks' nodes for this note], so the address is very
likely the same on both [inferred]. What the merchant must understand here is
one thing, and it is not Base or USDC: the passkey is the wallet. The terms
say in capitals that Coinbase keeps no backup of it and cannot recover it
[checked, wallet.coinbase.com/terms-of-service, last updated 2026-09-08].

**Receiving.** The payout arrives in the wallet, and the merchant sees it by
signing in at `wallet.coinbase.com` [checked]. Whether that interface shows
Base Sepolia balances, which the test channel pays in, I don't know. Whether Coinbase's
own interface can send raw data to a contract I don't know: the documentation
describes no such screen, and the only documented way is Coinbase's connector
for AI assistants, Wallet MCP, which accepts arbitrary calls [checked]. As far
as the sources show, the merchant cannot follow the dashboard's payout
instruction with this wallet. The dashboard itself could
ask the wallet to send the payout through the same window, as one batch of
calls the merchant approves [checked, `wallet_sendCalls`], which is the
"Pay out" button the commission design deferred. Its fee would still need ETH
in the wallet or a paymaster, a Coinbase service Agentify would hold a key
for and pay into [checked, `paymaster/faqs`]. Without that button the merchant
waits for the operator.

**Dollars.** Whether the wallet has a cash-out of its own I don't know: the
documentation and the terms describe none, and "Magic Spend", which let a
wallet spend a linked Coinbase.com balance, is documented as disabled
[checked]. The ways out are sending the
USDC to a Coinbase.com account and selling it there, or Coinbase's offramp,
which requires "a Coinbase account with linked bank details" and says "Guest
checkout is not supported for fiat withdrawal" [checked,
`onramp/additional-resources/faq`]. Either way the merchant opens a
Coinbase.com account and passes its identity check at this point. The offramp
would also need a secret Coinbase API key on Agentify's server [checked], and
whether it sells USDC on Base at all I don't know: its examples show USDC on
Ethereum and Polygon. Whether Coinbase pays the network fee when the merchant
sends USDC from its own app I don't know: the page that said so now answers
404.

**Custody.** Agentify stays outside it. Every signature and transaction is
approved with the passkey in Coinbase's window [checked, the sub-accounts page:
"requires a user passkey prompt for each wallet interaction", and the SDK
routes every signing method to the window]. A script injected into Agentify's
page could open that window with a request it built, and the window would show
Agentify's name on it, so the last defence is the merchant reading the window
[inferred]. Two optional features would weaken this and stay off: sub-accounts
and spend permissions put a signing key in Agentify's origin that signs
without a prompt [checked]. By default the SDK keeps in the page's
`localStorage` only a key pair that encrypts its messages to the window, the
connected address and its settings [checked in the code].

**Code in Agentify's origin.** 160.8 KB of script, brotli-compressed, on the
click (measured below). By default it also inserts an inline script that starts
Coinbase's analytics and reports the page's name and origin to
`cca-lite.coinbase.com` [checked, `coinbase-wallet/more/telemetry`];
`telemetry: false` turns that off. The window opens from the dashboard today:
the edge sends no `Cross-Origin-Opener-Policy`, which Coinbase lists as
working, and only `same-origin` would break it [checked, `deploy/Caddyfile` and
`coinbase-wallet/guides/tips/popup-tips`].

**Who can use it, and testing.** The terms bar minors and sanctioned users and
name no countries [checked]; whether a business may hold a wallet meant for
"individual onchain accounts" I don't know. Base Sepolia works in the window
[checked], so creating the wallet and receiving test USDC can be tried without
money; seeing and sending it in Coinbase's interface on the test network I
don't know. Coinbase needs nothing from Agentify for the button: the SDK takes
no key [checked: its options have none]. A paymaster or the offramp would need
a Coinbase Developer Platform project and its keys.

## Way 2: a Coinbase.com account and its deposit address

The merchant opens an account at Coinbase.com, passes its identity check,
finds the address for receiving USDC on the Base network and enters it in the
existing field. Agentify builds no code for this; the dashboard and the
portal can only say how.

**Getting the wallet.** The identity check asks for a document and sometimes
a selfie and answers within a day [snippet]. The merchant must choose Base as
the network when asking for the address, and must copy it, so this way cannot
meet the brief's acceptance of a wallet set "without typing or copying the
address". Coinbase's help centre says individual accounts are "for personal
benefit or non-commercial purposes" [snippet], and the European agreement lets
an account be used "only for yourself, and not on behalf of any third party"
[checked, §3.1]. Business accounts are offered to companies in the United
States and Singapore [snippet]. A merchant elsewhere would have to receive
business income into a personal account, against Coinbase's own terms, or not
use this way.

**Receiving.** The payout reaches the deposit address as a USDC transfer whose
sender is the shared 0xSplits warehouse, inside a transaction sent to
Multicall3 by somebody else. Whether Coinbase credits that, I don't know. The
signals point both ways: a help page of Coinbase Exchange, the institutional
venue, says "ERC-20 deposits via Ethereum smart contracts" are supported
[snippet]; an old Coinbase Pro page said contract-generated sends were not
accepted [snippet]; the European agreement excludes "any smart contract
functionality" and lets Coinbase refuse a transfer whose "transfer type or
transfer mechanism" it does not support [checked, §5.4 and §5.18]. It cannot
be tried on the test network: Coinbase takes no Base Sepolia deposits [inferred
from its network lists], and its sandboxes do not do transfers [checked]. The
only test is a small real payout on Base. Checked: an exchange account cannot
send data to a contract, since its sending API has no field for it, so the
merchant can never send their own payout and always waits for the operator. In
the European Union and the United Kingdom a deposit can be held until the
merchant names its sender [snippet], and the forms offer an exchange or a
self-hosted wallet, not a contract [checked in the API schemas]. Coinbase does
not promise that a deposit address lasts, and may stop supporting an asset
[checked, §5.3]; if the address stops crediting, the merchant replaces it, and
on the live channel buyers keep paying the old split for the forty-eight hours
a replacement waits (ADR-0019). The minimum deposit for
USDC on Base I don't know.

**Dollars.** This is the one way where the third place is solved from the
start: USDC converts to dollars one to one without a fee below large volumes
in the United States [snippet], and the account withdraws to a bank on the
local rail. For euros and pounds the conversion is a trade with a spread whose
size I don't know.

**Custody.** Agentify stays outside it. Coinbase holds the money "on a
custodial basis" for the merchant and may hold, block or reverse a
transaction "for any reason" [checked, §5.29 and §7.1]. That is the merchant's
choice of custodian, not Agentify's. No code runs in Agentify's origin.

**Who can use it, and testing.** Wherever Coinbase.com serves the merchant and
offers USDC on Base; no list was found. Nothing can be tried without real
money. Coinbase needs nothing from Agentify.

## Way 3: Coinbase's embedded wallet, signed into by email

The settings screen gets Coinbase Developer Platform's embedded wallet. The
merchant types an email address, receives a six-digit code from
`no-reply@info.coinbase.com` [checked], types it in, and a wallet exists. All
of this runs inside Agentify's own page, not in a Coinbase window.

**Getting the wallet.** No Coinbase.com account or identity check is
described for the wallet [don't know of one; the quickstart says users "get a
self-custodial wallet instantly", checked]. Agentify must hold a Coinbase
Developer Platform project, list its domains in it and use its project
identifier; no business verification is asked for wallets the users hold
[checked, `get-started/initial-setup`]. Each operation costs $0.005 after the
first 5,000 a month [checked, `wallets/pricing`]. A wallet works on up to five
devices and a session lasts up to seven days [checked].

**Receiving.** The money arrives in the wallet, and the merchant sees it only
where Agentify draws it: no Coinbase-hosted screen for these wallets was found
[don't know of one], and checked, the React components of version 0.0.127 have
no balance view, so Agentify would build the balance and send screens. If the wallet is a smart
account, the dashboard can send the payout for the merchant with the fee paid
by Coinbase's paymaster, which Agentify is billed for at the gas used times
1.07 [checked]. The wallet is reachable only from origins on Agentify's
project, so if Agentify goes away the merchant's way out is exporting the key
through Agentify's page while it still runs, and a smart account's own key
cannot be exported at all, only its owner's [inferred from the documentation
of projects and export, checked].

**Dollars.** The same as way 1: the offramp needs a Coinbase.com account with
a bank linked, a secret API key on Agentify's server, and an endpoint whose
"misuse" Agentify is "liable" for [checked, `onramp/security-requirements`].
It pays out by ACH in the United States and by PayPal in some countries
[checked].

**Custody.** This is where the way differs. The wallet's code runs as
Agentify's own script in Agentify's origin, and while the merchant is signed
in, any script there can call `sendUsdc` or `sendEvmTransaction` without a
confirmation that Coinbase controls [checked in the package, which wraps these
calls only in a check for second-factor enrolment; inferred as to an attacker].
A merchant who enrolled a second factor is asked for it, but by default one
verification authorises every protected operation until it expires, and even a
per-request passkey "signs an opaque digest", so "the description the user
approves comes from your UI" [checked, `wallets/authentication/mfa`]. Where a
browser blocks third-party cookies, as Safari and Firefox do, the session's
refresh token sits in the page's `localStorage` [checked,
`wallets/security-and-policies/first-party-cookies`]. Agentify's server cannot
sign for the merchant unless Agentify turns on delegated signing [checked]. So
the rule of ADR-0019, that Agentify cannot move a merchant's money, holds
against Agentify's server and not against Agentify's pages: whoever controls a
script in the origin, Agentify or an intruder, can move a signed-in merchant's
money. ADR-0005 names an origin per surface as "the way out if script
isolation becomes a requirement"; this way would make it one.

**Code in Agentify's origin.** 86.4 KB on the click without Coinbase's
interface, 417.3 KB with it, which also carries the SDK of way 1 (measured
below). It reports analytics to `cca-lite.coinbase.com` unless told
`disableAnalytics: true` [checked].

**Who can use it, and testing.** Sanctioned jurisdictions are blocked and
transfers are screened [checked]; no other country list was found. Everything
but the offramp works on Base Sepolia, with a faucet that sends test USDC to
any address [checked]; the offramp has no test mode that I found. Coinbase
needs a project, the domain list and acceptance of its developer terms, which
could not be read from here.

## Side by side

| | Way 1: Coinbase Wallet window | Way 2: Coinbase.com deposit address | Way 3: embedded wallet by email |
| --- | --- | --- | --- |
| Getting the wallet | A click and a passkey or email code in Coinbase's window; no identity check | A Coinbase.com account, an identity check, choosing Base and copying an address | An email code in Agentify's page; no identity check |
| What the merchant must understand first | The passkey is the wallet | Which network to choose; that a personal account may not be meant for this | That the email account is the key to the wallet |
| Sending their own payout | Only through a dashboard button not yet built | Never | Only through screens Agentify builds |
| Seeing the money | wallet.coinbase.com | Coinbase.com | Only in Agentify's dashboard |
| Dollars in a bank | Needs a Coinbase.com account later | Already there | Needs a Coinbase.com account later |
| Who can move the money | The merchant, through Coinbase's window | The merchant, through Coinbase, which holds it and may hold or block it | The merchant, and any script in Agentify's origin while they are signed in |
| Script on the click | 160.8 KB | none | 86.4 KB, or 417.3 KB with Coinbase's interface |
| Testable without money | Getting and receiving; not cashing out | Nothing | Everything but cashing out |
| Needed from Coinbase | Nothing | Nothing | A project, its terms, $0.005 an operation |
| Unknown that decides | Today's sign-up screens; testnet balances | Whether a payout from the split is credited | Whether Agentify may hold that power over a signed-in merchant's money |

Read across, two things hold for all three. The third place, dollars in a
bank, passes through a Coinbase.com account with an identity check in every
way built on Coinbase: way 2 asks for it first, and ways 1 and 3 ask for it
when the money has already arrived. And the second place is open in every way:
as far as the sources show, no wallet a merchant gets here lets them follow
today's payout instruction, so
until a dashboard button sends the payout, the merchant's money reaches them
when the operator pays out. Other offramps than Coinbase's were not examined.

At ten times the merchants, way 2 turns into one compliance hold per payout
for every merchant in the European Union or the United Kingdom whom Coinbase
asks to name a contract as a sender; way 3 turns into a monthly bill past the
free operations and a larger set of signed-in sessions whose money a script
in the origin can reach; way 1 stays where it is, since Coinbase's window
carries the work.

## What only the product owner can decide

1. Does a merchant need dollars in a bank, or is USDC in a wallet enough to
   start? If dollars, every Coinbase way passes through a Coinbase.com account
   with an identity check, and the choice is only whether the merchant meets it
   at the start, in way 2, or after the money arrives, in ways 1 and 3. If USDC
   is enough to start, ways 1 and 3 remain. The external handoff of 2026-10-12
   says the product owner chose USDC first; that statement is not confirmed
   anywhere else.
2. Is a manual payout acceptable for a merchant who does not know crypto? The
   measurement above says the payout costs under a cent, and as far as the
   sources show none of the three wallets can send today's instruction. Way 2 can never send a payout;
   ways 1 and 3 can only through a button in the dashboard, which the
   commission design deferred and this note does not add. Without it, how long
   a merchant waits is the frequency of the operator's payouts, which is
   already an open question of the product owner's.
3. May Agentify's pages hold the power to move a signed-in merchant's money?
   Way 3 requires it. If the answer is yes, it is a change to ADR-0019 and
   ADR-0005 before any code, not a design note.
4. May the dashboard steer merchants to a personal Coinbase.com account for
   their sales income, which Coinbase's terms describe as non-commercial use,
   given that business accounts serve the United States and Singapore? Way 2
   depends on it.
5. May one payout on Base be sent with real money, capped at a few dollars, to
   learn whether Coinbase credits a payout from a split? Way 2 cannot be judged
   without it, and nothing else can answer it. Note 47 already requires a check
   on Base before the live channel sells into a split; the two could be one
   run.
6. Is Agentify to hold a Coinbase Developer Platform project, accept its
   terms and pay for operations or gas? Way 3 needs it, and so does a
   paymaster or the offramp in any way.

## What is not known

The research left these open, each of which a live run or Coinbase can
answer: what a brand-new user sees in today's Coinbase Wallet window and how
an account created by email is recovered; whether wallet.coinbase.com shows
Base Sepolia balances; whether Coinbase pays the fee for USDC sent from its own
app; whether the offramp sells USDC on Base; whether Coinbase credits a USDC
transfer sent from the 0xSplits warehouse inside another contract's call, and
whether it then holds it for a sender declaration; the minimum deposit for
USDC on Base; and the countries where each way is available, for which no list
was found for any of the three. Whether the embedded wallet's code runs in a
browser without a stand-in for Node's `Buffer` was not tested.

These were checked and are absent: a key or registration for the Coinbase
Wallet window; a field for contract data in a Coinbase.com account's sending
API; a balance view and an offramp component in Coinbase's embedded wallet
components of version 0.0.127; a Content-Security-Policy or
Cross-Origin-Opener-Policy on Agentify's origin today.

## The weight measurement, registered before it ran

The dashboard holds every page to 100 KB of script, compressed with brotli as
it is sent, on the page's first visit (`apps/dashboard/src/budget.ts`). On
this branch, built on 2026-10-15, the settings page, where the payout wallet
is set, loads 93.9 KB, and the heaviest page 95.1 KB. A wallet provider's
browser code can therefore only arrive after a click, through an `import()`,
which the budget check prints beside the page without counting it. This
section fixes, before anything is installed, what is measured, what is
expected and how the numbers are reported. Nothing in it changes after the
commit that adds it; the results are appended under their own heading.

The measurement lives on the branch `spike/wallet-weight`, which is deleted
once this note reaches `main`. For each provider in turn it adds the
provider's packages to the dashboard at an exact version and, on the settings
page, a button whose click handler loads by `import()` a module doing the
smallest thing the provider needs to hand back an address:

- B, the Base Account SDK, `@base-org/account@2.5.13`:
  `createBaseAccountSDK({ appName, appChainIds: [84532] }).getProvider()` and
  one `eth_requestAccounts` request.
- C, Coinbase Developer Platform's embedded wallet without its interface,
  `@coinbase/cdp-core@0.0.127`: initialisation with a project identifier,
  sign-in by email with its one-time code, and reading the wallet's EVM
  address, under the names its type declarations give.
- R, the same wallet with Coinbase's ready-made interface,
  `@coinbase/cdp-react@0.0.127` with `@coinbase/cdp-hooks@0.0.127`: its
  provider component and its sign-in button rendered where the button was.

The exchange's deposit address needs no browser code, so it is not measured.

What is measured, each time on a production build of the dashboard:

- M1. The brotli-compressed bytes of every script the click loads that the
  settings page has not already loaded, read from Vite's manifest the way the
  budget check reads it.
- M2. The first-visit script of every page, as the budget check prints it,
  against the figures above.
- M3. Whether `pnpm --filter @agentify/dashboard build` succeeds with the
  dashboard's Vite configuration unchanged. Where it does not, the error, and
  the smallest change to the configuration that makes it build, which is then
  the build measured.

What is expected:

- P1. M1 for B lies between 120 KB and 300 KB.
- P2. M1 for C is above 100 KB.
- P3. M1 for R is above M1 for C.
- P4. With each provider, no page's first visit grows by more than 0.5 KB.
- P5. B builds with the configuration unchanged; C and R do not, for want of
  a browser stand-in for a Node built-in such as `Buffer`.

How the numbers are read: the measurement chooses no provider. Its figures
enter the comparison below as they are. A provider for which P4 fails carries
into the comparison, as a cost of building it, the work of keeping its code
out of the first visit; a provider that needs a change to the build carries
that change. A prediction that fails is reported as failed, with the number
that failed it.

### Results

The measurement ran on 2026-10-15 at commit `14edad7` of `spike/wallet-weight`,
with Node 24.22.0, pnpm 11.12.0 and the dashboard's own Vite 7.3.6 and React
Router 8.4.0; `spike/measure.sh` there prints everything below, and
`spike/measured-2026-10-15.txt` is its output. One build was added that the
registration did not name: a control, the same button importing a module with
no provider in it, so that the button's own weight can be told apart from the
provider's.

| Build | M1: what the click loads, brotli | the same, uncompressed | M2: settings pages | M2: every other page | M3 |
| --- | --- | --- | --- | --- | --- |
| Control, no provider | 0.1 KB | 0.0 KB | 94.4–94.5 KB, +0.5–0.6 | +0.0 | builds |
| B, Base Account SDK | 160.8 KB | 550.3 KB | 94.5–94.6 KB, +0.6–0.7 | +0.0–0.1 | builds |
| C, CDP embedded wallet, no interface | 86.4 KB | 350.8 KB | 94.6–94.7 KB, +0.7–0.8 | +0.1–0.2 | builds |
| R, CDP embedded wallet with Coinbase's sign-in | 417.3 KB and a 5.1 KB stylesheet | 1880.8 KB | 94.8–94.9 KB, +0.9–1.0 | +0.3–0.4 | builds |

The changes in M2 are against the figures measured before the spike, 93.9 KB
on the settings pages and 91.5–95.1 KB elsewhere; the budget check prints one
decimal, so a change of 0.1 KB is within its rounding.

P1 held: B's click loads 160.8 KB, inside the predicted 120–300 KB. P2 failed:
C's click loads 86.4 KB, not more than 100 KB. P3 held, and for a reason the
prediction did not foresee: `@coinbase/cdp-react@0.0.127` depends on
`@base-org/account@2.5.13`, so R carries the Base Account SDK as well as its own
interface. P4 failed as it was written: the settings pages grew by 0.6–1.0 KB
with every provider. The control shows where that came from: the button and
its `import()` alone add 0.5–0.6 KB to the settings pages and nothing
elsewhere, and what each provider adds to any page's first visit on top of the
control is at most 0.1 KB for B, 0.2 KB for C and 0.4 KB for R, which is code
the provider shares with the dashboard being moved by the bundler into chunks
the first visit already loads. P5 failed for C and R: all three built with the
Vite configuration unchanged. Installing C and R did need a decision of
another kind: pnpm 11 refuses to install until `bufferutil` and
`utf-8-validate`, native modules of the WebSocket library `ws` reached through
Solana's client inside `@coinbase/cdp-core`, are allowed or declined a build
script, and the spike declined both. Whether C and R then run in a browser
without a stand-in for Node's `Buffer` was not tested: the measurement built
the code and did not run it.

Three things were read in the built code and the packages' sources while
measuring, outside the registration. B, unless told `telemetry: false`, inserts
an inline script into the page's head that starts Coinbase's analytics client
and sends events to `cca-lite.coinbase.com`
(`dist/core/telemetry/initCCA.js`; the option defaults to `true` in
`dist/core/provider/interface.d.ts`). C's code names the same host and its
configuration has a `disableAnalytics` switch. And B depends at run time on
`@coinbase/cdp-sdk@1.58.0`, Coinbase's server SDK, while the gateway uses
1.55.0, so the lockfile would carry two copies of it.

## Sources

Coinbase's pages are cited by their path under `https://docs.cdp.coinbase.com/`
unless a full address is given; each was read on 2026-10-15, most of them in
their Markdown form (the same path with `.md`).

- Coinbase Wallet: `coinbase-wallet/overview`, `coinbase-wallet/quickstart/web`,
  `coinbase-wallet/reference/core/createBaseAccount`,
  `coinbase-wallet/reference/core/provider-rpc-methods/wallet_connect`,
  `coinbase-wallet/reference/core/provider-rpc-methods/wallet_sendCalls`,
  `coinbase-wallet/reference/core/capabilities/auxiliaryFunds`,
  `coinbase-wallet/reference/ui-elements/brand-guidelines`,
  `coinbase-wallet/reference/onchain-contracts/smart-wallet`,
  `coinbase-wallet/improve-ux/sub-accounts`,
  `coinbase-wallet/improve-ux/sponsor-gas/paymasters`,
  `coinbase-wallet/guides/tips/popup-tips`, `coinbase-wallet/more/telemetry`,
  `coinbase-wallet/more/troubleshooting/usage-details/unsupported-calls`,
  `coinbase-for-agents/wallet-mcp/references/batch-calls`, and the terms at
  https://wallet.coinbase.com/terms-of-service.
- The embedded wallet: `wallets/non-custodial-wallets/overview`,
  `wallets/quickstart/user-auth`, `wallets/pricing`,
  `wallets/authentication/overview`,
  `wallets/authentication/session-management`,
  `wallets/authentication/mfa/protected-operations`,
  `wallets/authentication/mfa/per-request-verification`,
  `wallets/security-and-policies/security-overview`,
  `wallets/security-and-policies/first-party-cookies`,
  `wallets/using-wallets/delegated-signing`,
  `wallets/using-wallets/import-and-export`,
  `wallets/using-wallets/smart-accounts`, `get-started/initial-setup`,
  `faucets/introduction/welcome`.
- The offramp and the paymaster: `onramp/additional-resources/faq`,
  `onramp/offramp/offramp-overview`, `onramp/offramp/offramp-integration-guide`,
  `onramp/security-requirements`, `onramp/introduction/welcome`,
  `paymaster/faqs`.
- Coinbase.com and Coinbase Exchange: the EEA user agreement of July 2025,
  https://assets.ctfassets.net/o10es7wu5gm1/69f3BVnUTRgArQ8PalNZm8/08bf839897a08fc8672a723c9e616dd4/Coinbase_EEA_User_Agreement_July_2025.pdf;
  https://api.exchange.coinbase.com/currencies/USDC;
  `coinbase-app/transfer-apis/onchain-addresses`,
  `coinbase-business/transfer-apis/send-crypto`,
  `api-reference/exchange-api/rest-api/travel-rules/create-travel-rule`,
  `prime/concepts/transactions/deposits`, `exchange/introduction/sandbox`,
  `get-started/sandbox/overview`. Read only as search summaries:
  https://help.coinbase.com/en/exchange/crypto-transfers/depositing-to-coinbase-exchange,
  https://help.coinbase.com/en/pro/managing-my-account/funding-your-account/funding-your-account-with-cryptocurrency,
  https://help.coinbase.com/en/coinbase/other-topics/legal-policies/user-agreements-ind-bus,
  https://help.coinbase.com/en/coinbase/other-topics/business/business-overview,
  https://help.coinbase.com/en/coinbase/trading-and-funding/sending-or-receiving-cryptocurrency/send-receive-crypto-eu,
  https://help.coinbase.com/en/coinbase/getting-started/verify-my-account/id-doc-verification,
  https://help.coinbase.com/en/base/getting-started/sign-in,
  https://help.coinbase.com/en/wallet/getting-started/smart-wallet-recovery.
- The packages: `@base-org/account@2.5.13`, `@coinbase/cdp-core@0.0.127`,
  `@coinbase/cdp-hooks@0.0.127` and `@coinbase/cdp-react@0.0.127` from the npm
  registry.
