# A merchant without a crypto wallet: three ways to one they can be paid in and spend from

Date: 2026-10-15. A research note for the product owner, which may be
rewritten. It compares ways a merchant who has never held cryptocurrency gets
from the dashboard's settings to money they can use, and ends with the
questions only the product owner can answer. The comparison chooses nothing;
the product owner chose on 2026-10-15, and the section "What the product owner
decided" records the choice.

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
and is marked so. Coinbase has renamed the wallet the dashboard would open:
the package's own README says "Base Account is now Coinbase Wallet" and that
the package, still named `@base-org/account`, "is still the current recommended
SDK for connecting to Coinbase Wallet until the next-generation Coinbase Wallet
SDK is ready" and that "Existing integrations do not need to migrate"; the old
pages at docs.base.org now redirect to docs.base.org/sdks/migrated-products,
which points to docs.cdp.coinbase.com [checked]. A next SDK is announced, and
whether a site built on this one will have to move to it is not said.

Each claim below carries one of four marks. [checked] means it was read in a
primary Coinbase source, in a package's code, or in this repository.
[snippet] means only a search result's summary of a Coinbase help page says
it. [inferred] means it is a conclusion that was not executed. [don't know]
means the sources were searched and say nothing; where they say that
something does not exist, the text says "checked: there is none" instead.

A few words are used throughout. USDC is a dollar token issued by Circle;
Base is the network buyers pay on, and Base Sepolia is its test network,
where USDC has no value. Agentify's test channel sells on Base Sepolia and its
live channel on Base. Gas is the network's fee for a transaction, paid in
ETH, and a gwei is a billionth of one ETH. A block explorer is a public website
that shows any address's balance and transactions. A passkey is a sign-in key
a phone or computer keeps and unlocks with a fingerprint, face or PIN. A smart
account is a wallet that is itself a contract on the chain, so it can batch
calls and have its fee paid by someone else, a service called a paymaster. An
offramp is a service that sells the token for money in a bank account; ACH is
the United States' bank transfer, and a spread is the difference between the
price a trade is made at and the market price. A faucet hands out test tokens.
An SDK is the code a provider gives a site to talk to its service, and
Coinbase Developer Platform, CDP for short, is Coinbase's set of services for
developers, under which the embedded wallet, the paymaster and the offramp are
sold. A lockfile is the file that pins the exact version of every package the
repository installs. Multicall3
is a public contract, not Agentify's, that runs a batch of calls in one
transaction, and the 0xSplits warehouse is the shared contract every split
pays its shares through. ADR-NNNN names a decision record in
`docs/decisions/`, and the operator is the person who runs Agentify's
deployment and, among other things, sends the payout of every split.

Some words concern the browser. The origin is the scheme, host and port a
page is served from; on Agentify one origin carries every surface, and a
script running in it acts with the merchant's session
(`docs/decisions/0005-web-surface.md`). `localStorage` is storage a page keeps
in the browser, which any script in the same origin can read. A refresh token
is what keeps a session alive after its short-lived access token expires.
Content-Security-Policy and Cross-Origin-Opener-Policy are headers a site sends
to limit which scripts may run in its pages and how its pages relate to the
windows they open. Brotli is the compression the dashboard's scripts are sent
in, so their size in brotli is what a browser downloads.

## What every way shares: the payout from the split

Whichever wallet the merchant ends up with, money reaches it the same way. A
buyer pays the merchant's split; the split holds the USDC until a payout,
one transaction that anybody may send, distributes it and withdraws the
merchant's share to their wallet (ADR-0037). Until then the merchant's wallet
shows nothing, whatever wallet it is: the money is in a contract, and the
dashboard links to that contract in a block explorer rather than reading its
balance (`docs/research/47-commission-in-the-product.md`, section «Что видит
мерчант»). The dashboard's payout instruction asks the merchant to send a
transaction to Multicall3 with data copied from the screen. It need not come
from the wallet it pays: "any wallet of yours whose app shows the field, and
which holds a little ETH for the fee, can send it" (`apps/docs/money.md`). A
merchant with no such wallet is paid when Agentify next pays out every split,
on no set date.

What a payout costs follows from figures read on 2026-10-15 at 06:49 UTC: the
price of gas on Base and on Base Sepolia was 0.006 gwei, and Coinbase's spot
price of ETH was $2,352.99. With the gas figures of note 47, which were
measured there in a simulation without a record, a merchant's payout of one new
split costs about $0.0046, of a split already on the chain about $0.0019, and
the operator's payout of twenty new splits about $0.078 [inferred: arithmetic
on those figures]. Base also charges for publishing the transaction's data to
Ethereum. The gateway's own payout builder makes a merchant's payout of one
split 1,572 bytes of data and the operator's payout of twenty 30,404 bytes
[checked], and Base's price contract (`getL1FeeUpperBound` at
`0x420000000000000000000000000000000000000F`) put the upper bound of that fee
at about $0.00002 and $0.00039 for them at 07:26 UTC, at an ETH price of
$2,367.01 read then [checked]. The money is
not the obstacle. The obstacle is that the merchant needs ETH on Base in some
wallet that can send raw data, and the sections below say for each way whether
the wallet it gives can.

## Way 1: Coinbase Wallet, opened in Coinbase's window

The settings screen gets a button. Its click loads Coinbase's SDK and opens a
Coinbase window at `keys.coinbase.com`, outside Agentify's origin, where the
merchant creates a wallet or signs in to one they have, and the window hands
the dashboard the wallet's address, which fills the existing field.

**Getting the wallet.** Coinbase's developer documentation describes signing
in with a passkey, "no installs, seed phrases, or network switches" [checked,
`coinbase-wallet/overview`]; its help centre also describes email codes
[snippet]. What a brand-new user sees in today's window, a passkey first or an
email first, I don't know: it needs a live run. A Coinbase.com account is not
needed [snippet], and the wallet's terms ask only that the user be eighteen
and "not barred from using the Services under applicable law" [checked]; that
no identity check is asked I infer from those two and could not check. A user
who already has a Coinbase Wallet gets that wallet back [checked, the brand
guidelines], so the button says "create or connect". The same guidelines
ask that Coinbase's sign-in button "Always use 'Sign in with Base' unless
there's an explicit 'Sign in' heading prior", which the dashboard would have to
weigh against its own wording [checked]. The help centre warns
that the account follows the sign-in method, so a merchant who signs in
another way than before may get another address [snippet]. The address is a
smart account that may not exist on the chain until its first outgoing
transaction [checked], and it can receive USDC before then, because a token
transfer runs no code at the recipient [inferred]. Its factory has the same
code on Base and Base Sepolia [checked by reading both networks' nodes for
this note], so the address is very likely the same on both [inferred]. What
the merchant must understand here is not Base or USDC but that the passkey,
any recovery key they create and the email account if they sign in by email
are the wallet: the terms make the user "solely responsible" for "any recovery
key you create for your Smart Wallet, or any email or social media account
used to access the Services" and for their passkeys, and say in capitals that
Coinbase keeps no backup and cannot recover them [checked,
wallet.coinbase.com/terms-of-service, last updated 2026-09-08].

**Receiving.** The payout arrives in the wallet, and the merchant sees it by
signing in at `wallet.coinbase.com` [checked]. Whether that interface shows
Base Sepolia balances, which the test channel pays in, I don't know. Whether
Coinbase's interface can send raw data to a contract I don't know either: the
documentation describes no such screen, and the only documented way is
Coinbase's connector for AI assistants, Wallet MCP, which accepts arbitrary
calls on Base and Base Sepolia [checked]; who pays the fee for such a call I
don't know. The dashboard itself could ask the wallet to send the payout
through the same window, as one batch of calls the merchant approves [checked,
`wallet_sendCalls`], which is the "Pay out" button the commission design
deferred. Its fee would still need ETH in the wallet or a paymaster, which
Agentify would hold a Coinbase key for and pay into [checked,
`paymaster/faqs`]. Without that button the merchant sends the payout from
another wallet that holds ETH, or waits for the operator.

**Dollars.** Whether the wallet has a cash-out of its own I don't know: the
documentation and the terms describe none, and "Magic Spend", which let a
wallet spend a linked Coinbase.com balance, is documented as disabled
[checked]. The ways out are sending the USDC to a Coinbase.com account and
selling it there, or Coinbase's offramp, which requires "a Coinbase account
with linked bank details" and says "Guest checkout is not supported for fiat
withdrawal" [checked, `onramp/additional-resources/faq`]. Either way the
merchant opens a Coinbase.com account at this point, with whatever identity
check it asks. The offramp would also need a secret Coinbase API key on
Agentify's server [checked], and whether it sells USDC on Base at all I don't
know: its examples show USDC on Ethereum and Polygon. Whether Coinbase pays the
fee when the merchant sends USDC from its own app I don't know: the page that
said so now answers 404.

**Custody.** Agentify stays outside it. Every signature and transaction is
approved with the passkey in Coinbase's window [checked, the sub-accounts page:
"requires a user passkey prompt for each wallet interaction", and the SDK
sends every signing request to the window]. A script injected into Agentify's
page could open that window with a request it built, and the window would show
Agentify's name on it, so the last defence is the merchant reading the window
[inferred]. One optional feature would weaken this and stays off:
sub-accounts, extra accounts a site creates under the user's wallet, put a
signing key in Agentify's origin that signs for them without a prompt
[checked]. By default
the SDK keeps in the page's `localStorage` only a key pair that encrypts its
messages to the window, the connected address and its settings [checked in
the code].

**Code in Agentify's origin.** 159.7 KB of script on the click, brotli
compressed (measured below). Unless told `telemetry: false`, the SDK also
inserts an inline script that starts Coinbase's analytics and sends the
application's name and origin to `cca-lite.coinbase.com` [checked in the code
and in `coinbase-wallet/more/telemetry`]. Coinbase's window should open from
the dashboard as it stands: the edge sends no Cross-Origin-Opener-Policy,
Coinbase lists that as working and only `same-origin` as breaking the window
[checked, `deploy/Caddyfile` and `coinbase-wallet/guides/tips/popup-tips`]; it
was not run.

**Who can use it, and testing.** The terms name no countries beyond the bar
on use where the law forbids it [checked]; whether a business may hold a
wallet the terms describe as an individual's I don't know. Base Sepolia works
in the window [checked], so creating the wallet and receiving test USDC can be
tried without money; seeing and sending it in Coinbase's interface on the test
network I don't know. Coinbase needs nothing from Agentify for the button:
checked, the SDK's options take no key. A paymaster or the offramp would need
a Coinbase Developer Platform project and its keys.

## Way 2: a Coinbase.com account and its deposit address

The merchant opens an account at Coinbase.com, passes its identity check,
finds the address for receiving USDC on the Base network and enters it in the
existing field. Agentify builds no code for this; the dashboard and the
portal can only say how.

**Getting the wallet.** The identity check asks for a document and sometimes
a selfie and answers within a day [snippet]. The merchant must choose Base as
the network when asking for the address, and must copy it, so this way cannot
give what the button of ways 1 and 3 gives: a wallet set without typing or
copying an address. Coinbase's help centre says individual accounts are "for
personal benefit or non-commercial purposes" and business accounts for
"accepting crypto payments or conducting sales as a business" [snippet]. The
European agreement says: "you will use the Coinbase Services only for
yourself, and not on behalf of any third party, unless you have obtained prior
approval from Coinbase" [checked, §3.1]. A sole trader's own sales income may
fit "for yourself"; a company paid into its director's personal account does
not [inferred]. Business accounts are offered to companies in the United
States and Singapore [snippet].

**Receiving.** The payout reaches the deposit address as a USDC transfer whose
sender is the 0xSplits warehouse, inside a transaction sent to Multicall3 by
somebody else. Whether Coinbase credits that, I don't know. The signals point
both ways. A help page of Coinbase Exchange, the institutional venue, says
"ERC-20 deposits via Ethereum smart contracts" are supported, ERC-20 being the
standard USDC follows [snippet]; a page
of Coinbase Pro, its former trading venue, said it did not "accept sends from
contract-generated transactions" [snippet]. The European agreement says, unless Coinbase
"specifically announced" otherwise on its site, of "any smart contract
functionality, which may supplement or interact with a Supported Crypto
Asset": "Do not use your Coinbase Account to attempt to receive" it, and "Any attempted transactions in such items will result in loss
of the item"; it also lets Coinbase refuse a transfer whose "transfer type or
transfer mechanism" it does not support [checked, §5.4 and §5.18]. Whether a
plain USDC transfer made inside a contract call counts as such functionality
the agreement does not say. It cannot be tried on the test network: Coinbase
takes no Base Sepolia deposits [inferred from its network lists], and its
sandboxes do not do transfers [checked]. The only test is a small real payout
on Base. Checked: an exchange account cannot send data to a contract, since
its sending API has no field for it, so the merchant sends the payout from
another wallet holding ETH, or waits for the operator. In the European Union
and the United Kingdom a deposit can be held until the merchant names its
sender [snippet], and the forms for it offer an exchange or a self-hosted
wallet as the sender, not a contract [checked in the API schemas]. How long a
deposit address keeps working the agreement does not say (checked: there is no
such statement), and Coinbase may end support for an asset [checked, §5.3]. If
the address stops crediting, the merchant replaces it, and on the live channel
buyers keep paying the old split for the forty-eight hours a replacement waits
(ADR-0019). The minimum deposit for USDC on Base I don't know.

**Dollars.** This is the one way where the third place is solved from the
start: USDC converts to dollars one to one without a fee below large volumes
in the United States [snippet], and the account withdraws to a bank by the
country's own bank transfer. For euros and pounds the conversion is a trade
with a spread whose size I don't know.

**Custody.** Agentify stays outside it. Coinbase holds the money "on a
custodial basis" for the merchant and may "place on hold, block, cancel or
reverse a transaction" for "any reason" [checked, §5.29 and §7.1]. That is the
merchant's choice of custodian, not Agentify's. No code runs in Agentify's
origin.

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
devices and a session lasts up to seven days [checked]. The email account is
the way into the wallet [inferred from the sign-in, which has no other step].

**Receiving.** The money arrives in the wallet. No Coinbase-hosted screen for
these wallets was found [don't know of one], and checked, the React components
of version 0.0.127 have no balance view, so the merchant would see the balance
where Agentify draws it, or in a block explorer, and send from screens Agentify
builds. If the wallet is a smart account, the dashboard can send the payout
for the merchant with the fee paid by Coinbase's paymaster, which bills
Agentify the gas used times 1.07 [checked]. The wallet is reachable only from
origins on Agentify's project, so if Agentify goes away the merchant's way out
is exporting the key through Agentify's page while it still runs, and a smart
account's own key cannot be exported at all, only its owner's [inferred from
the documentation of projects and export, checked].

**Dollars.** The same as way 1: the offramp needs a Coinbase.com account with
a bank linked and a secret API key on Agentify's server, and Agentify is
"liable for any misuse of your endpoints due to improper implementation of
these security measures" [checked, `onramp/security-requirements`]. It pays
out to a Coinbase.com balance in every country Coinbase serves but Japan, to a
card in the United States and over ninety other countries, by ACH in the
United States and by PayPal in Canada, the United Kingdom and a few others
[checked,
`onramp/additional-resources/payment-methods`].

**Custody.** This is where the way differs. The wallet's code runs as
Agentify's own script in Agentify's origin, and while the merchant is signed
in, any script there can call `sendUsdc` or `sendEvmTransaction` without a
confirmation that Coinbase controls [checked in the package, which wraps these
calls only in a check of the session and of second-factor enrolment; inferred
as to an attacker]. It may be able to do more than spend while the session
lasts. Coinbase's page says "User wallet exports always happen inside a
secure, isolated iframe. Your application code never has access to the raw
key material" [checked, `wallets/using-wallets/import-and-export`], yet
`@coinbase/cdp-core@0.0.127` still exports `exportEvmAccount`, marked
deprecated and to be "removed soon", whose code decrypts the account's raw
private key in the page under the same two checks [checked in the package];
whether Coinbase's service still answers that call I don't know. If it does, a
script that runs once while the merchant is signed in can take the key and
move the money later, after the merchant signs out and after the script is
removed [inferred]. The package also exports `createDelegation`, which lets a
developer's server "sign on behalf of an end user" for a chosen period once
the developer has turned delegation on [checked]. A merchant who
enrolled a second factor is asked for it, but by default one verification
authorises every protected operation until it expires, and even a per-request
passkey "signs an opaque digest", so "the description the user approves comes
from your UI" [checked, `wallets/authentication/mfa`]. Where a browser blocks
third-party cookies, as Safari and Firefox do, the session's refresh token sits
in the page's `localStorage`; Coinbase's remedy, a cookie served from a
subdomain of Agentify's own, is in "limited access" [checked,
`wallets/security-and-policies/first-party-cookies`]. Agentify's server cannot
sign for the merchant unless Agentify turns delegation on in its project and a
delegation is created [checked]. So the rule of ADR-0019, that Agentify cannot
move a merchant's money, holds against Agentify's server and not against
Agentify's pages: whoever controls a script in the origin, Agentify or an
intruder, can take a signed-in merchant's money. ADR-0005 names an origin per
surface as "the way out if script isolation becomes a requirement"; this way
would make it one.

**Code in Agentify's origin.** 86.4 KB on the click without Coinbase's
interface, 203.6 KB and a 5.1 KB stylesheet with it (measured below). It sends
analytics to `cca-lite.coinbase.com` unless told `disableAnalytics: true`
[checked].

**Who can use it, and testing.** Sanctioned jurisdictions are blocked and
transfers are screened [checked]; no other country list was found. Everything
but the offramp works on Base Sepolia, with a faucet that sends test USDC to
any address [checked]; the offramp has no test mode that I found. Coinbase
needs a project, the domain list and acceptance of its developer terms, which
could not be read from here.

## Side by side

The table restates the sections above with their marks; where it and a
section differ, the section holds.

| | Way 1: Coinbase Wallet window | Way 2: Coinbase.com deposit address | Way 3: embedded wallet by email |
| --- | --- | --- | --- |
| Getting the wallet | A click and a passkey or email code in Coinbase's window; no Coinbase.com account [snippet] | A Coinbase.com account, an identity check, choosing Base and copying an address | An email code in Agentify's page; no Coinbase.com account [don't know of one] |
| What the merchant must understand first | The passkey, any recovery key and the email if used are the wallet; Coinbase cannot recover them | Which network to choose; whether their account may receive business income | The email account is the way in [inferred] |
| Sending their own payout | From this wallet only through a dashboard button not built, or Wallet MCP [fee: don't know]; else from another wallet with ETH | Never from this account; from another wallet with ETH | Through screens Agentify builds, with a smart account and a paymaster or with ETH; or from another wallet with ETH |
| Seeing the money | wallet.coinbase.com; test balances [don't know] | Coinbase.com | Agentify's screens or a block explorer |
| Dollars in a bank | Needs a Coinbase.com account later | Already there; credit of a split's payout [don't know] | Needs a Coinbase.com account later |
| Who can move the money | The merchant, through Coinbase's window | The merchant, through Coinbase, which holds it and may block it | The merchant, and any script in Agentify's origin while they are signed in; for good if the key can still be exported [don't know] |
| Script on the click | 159.7 KB | none | 86.4 KB, or 203.6 KB with Coinbase's interface |
| Testable without money | Getting and receiving; not cashing out | Nothing [inferred] | Everything but cashing out |
| Needed from Coinbase | Nothing | Nothing | A project, its terms, $0.005 an operation |
| What decides it | Today's sign-up screens and test balances, which a live run answers | Whether a split's payout is credited, which only real money answers | Whether Agentify's pages may hold that power, which is a decision, not a fact |

Read across, two things hold for all three. The third place, dollars in a
bank, passes through a Coinbase.com account in every way built on Coinbase:
way 2 asks for it first, and ways 1 and 3 ask for it when the money has
already arrived. And the second place is open in every way: as far as the
sources show, none of the three wallets can itself send today's payout
instruction, so until a dashboard button sends the payout, the merchant either
keeps a second wallet with ETH or waits for the operator. Other offramps than
Coinbase's were not examined.

At ten times the merchants each way grows in its own direction. Way 1 grows
in wallets whose only keys are a passkey, a recovery key or an email account
that Coinbase cannot recover, and in payouts the operator sends for merchants
without ETH.
Way 2 grows, if Coinbase does hold deposits from a contract in the European
Union and the United Kingdom [snippet], into one held deposit per payout for
every merchant there, and in the same operator payouts. Way 3 grows into a
monthly bill once the merchants together pass 5,000 operations a month, about
2,500 sent transactions since a send counts as two, plus the paymaster's gas
times 1.07 for every payout it carries, and into more signed-in sessions whose
money a script in the origin can reach.

## What only the product owner can decide

1. Does a merchant need dollars in a bank, or is USDC in a wallet enough to
   start? If dollars, every Coinbase way passes through a Coinbase.com account,
   and the choice is only whether the merchant meets it at the start, in way 2,
   or after the money arrives, in ways 1 and 3. If USDC is enough to start,
   ways 1 and 3 remain. An implementation handoff prepared outside this
   repository on 2026-10-12 says the product owner chose USDC first; nothing
   in the repository confirms it.
2. Is a manual payout acceptable for a merchant who does not know crypto? A
   payout costs under a cent by the arithmetic above, and as far as the
   sources show none of the three wallets can send today's instruction
   itself: way 2's never can, and ways 1 and 3 can only through a button in the
   dashboard, which the commission design deferred and this note does not add.
   Without it a merchant needs a second wallet with ETH, or waits as long as
   the operator's payouts take, whose frequency is already an open question of
   the product owner's.
3. May Agentify's pages hold the power to spend a signed-in merchant's money,
   and perhaps to export the wallet's key, which Coinbase's page says cannot
   happen and its package still allows? Way 3 requires the first. If the answer is
   yes, it is a change to ADR-0019 and ADR-0005 before any code, not a design
   note.
4. May the dashboard point merchants to a Coinbase.com account for their
   sales income, given that Coinbase's European agreement limits an account to
   use "only for yourself" without its approval, that its help centre calls
   individual accounts non-commercial [snippet], and that business accounts
   serve companies in the United States and Singapore [snippet]? Way 2 depends
   on it, and the answer may differ for sole traders and for companies.
5. May one payout on Base be sent with real money, capped at a few dollars, to
   learn whether Coinbase credits a payout from a split? Way 2 cannot be judged
   without it, and nothing else can answer it. Note 47 already requires a check
   on Base before the live channel sells into a split; the two could be one
   run.
6. Is Agentify to hold a Coinbase Developer Platform project, accept its
   terms and pay for operations or gas? Way 3 needs it, and so does a
   paymaster or the offramp in any way.

## What the product owner decided

The product owner answered the six questions on 2026-10-15.

1. USDC only. A merchant is paid in USDC in their own wallet, and turning it
   into dollars in a bank is not part of this work.
2. The merchant sends their own payout, and pays its fee in USDC, provided it
   takes one press and one confirmation; copying data into a wallet is not
   something a merchant who does not know crypto is asked to do. This brings
   in the dashboard's "Get your payout" button, which the commission design
   had deferred.
3. Every payment is confirmed by the merchant. Way 3 is out, and so are
   Coinbase Wallet's sub-accounts, which sign without a prompt.
4. No exchange deposit address: way 2 is not offered. Entering an address by
   hand stays open to everyone, whatever wallet it belongs to.
5. A capped payout with real money was allowed; with way 2 out nothing needs
   it, and none is sent.
6. No Coinbase Developer Platform project where it can be avoided, so no
   paymaster and no offramp.

What is built is therefore way 1. The settings screen gets a button that opens
Coinbase's window to create or connect a Coinbase Wallet and puts its address
into the existing field, which the merchant then saves as today, the save
being consent to the commission. Beside the payout instruction, a button sends
that same transaction through Coinbase's window, where the merchant approves
it and chooses to pay its fee in USDC. Coinbase's analytics are turned off in
Agentify's page.

Three things stay to be seen in a live run on the test channel, which the
product owner does by hand: what a new merchant sees in Coinbase's window;
whether Coinbase Wallet lets the fee be paid in USDC without a paymaster of
Agentify's, as its documentation says it does for "a set of universally
supported tokens, such as USDC" [checked, `coinbase-wallet/improve-ux/sponsor-gas/erc20-paymasters`];
and what happens on a merchant's first payout, when the wallet holds no USDC
yet to pay the fee with [inferred: it cannot pay, and that payout arrives with
the operator's]. If the fee cannot be paid in USDC, this comes back to the
product owner as one choice, not a set of combinations.

What a real browser showed on 2026-10-15, with the built dashboard on the test
channel's configuration in headless Chromium, Playwright 1.61.1 driving a
Chromium of revision 1194, no person and no passkey: the settings page drawn
with the browser's script switched off shows no Coinbase button and saves an
address typed into the box; with script, the button opens
`https://keys.coinbase.com/connect` for `@base-org/account` 2.5.13, whose first
screen, under a banner reading "Base Account is now Coinbase Wallet", offers
"Sign In" and "Create Account" above "You agree to our Terms & Privacy
Policy"; closing that window as a person closes it gives the page's "Coinbase
Wallet was closed" within two seconds, and the payout button opens the same
window; the page itself requests nothing but its own origin. Two things only
that run could show changed the code. A window closed without its unload
handlers running, as Playwright closes one and as a phone may drop a tab,
never answers the page, so a button held disabled while waiting stayed held;
no button is held now. And the SDK keeps the account it connected, with the
keys of its session, in the page's `localStorage`, and answers the next
request for an address from there without a window, for whichever account of
the dashboard is signed in; the dashboard now clears that before and after
every press, and after a press the store held no account and no keys. Signing
in, creating a wallet, approving a payout and paying its fee were not tried:
they need a person with a passkey.

As built on 2026-10-15, the settings page loads 95.4 KB of script on its first
visit, 1.5 KB more than before, for the two buttons and their words; no other
page changed by more than the budget check's rounding; and a press can fetch
161.1 KB more, Coinbase Wallet's code with the dashboard's requests to it, as
the budget check prints beside the page.

## What is not known

The research left these open, each of which a live run or Coinbase can
answer: what a brand-new user sees in today's Coinbase Wallet window and
whether it asks for any identity check; how an account created by email is
recovered; whether wallet.coinbase.com shows Base Sepolia balances; whether
Coinbase pays the fee for USDC sent from its own app or through Wallet MCP;
whether the offramp sells USDC on Base; whether Coinbase credits a USDC
transfer sent from the 0xSplits warehouse inside another contract's call, and
whether it then holds it for a sender declaration; the minimum deposit for
USDC on Base; and the countries where each way is available, for which no list
was found for any of the three. Whether the embedded wallet's code runs in a
browser without a stand-in for Node's `Buffer` was not tested, and the build of
Coinbase's interface for it warned that it lacks one; its smart account was
not measured separately. Whether Coinbase's service still answers the
deprecated export of a wallet's raw key from the page I don't know.

These were checked and are absent: a key or registration for the Coinbase
Wallet window; a field for contract data in a Coinbase.com account's sending
API; a balance view and an offramp component in Coinbase's embedded wallet
components of version 0.0.127; a statement of how long a Coinbase deposit
address keeps working; a Content-Security-Policy or Cross-Origin-Opener-Policy
on the dashboard's pages today.

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

The measurement ran twice on 2026-10-15 on `spike/wallet-weight`, with Node
24.22.0, pnpm 11.12.0 and the dashboard's own Vite 7.3.6 and React Router
8.4.0. The first run, at commit `14edad7`, broke the registration: it installed
every provider's packages together rather than each in turn, and
`@coinbase/cdp-react@0.0.127` declares `@base-org/account` an optional peer
that it fetches by `import()` only for its "Sign in with Base" option, so with
both installed R's code could load way 1's SDK as a separate 210.6 KB file and
its figure at most was 417.3 KB; what R's click loaded at once, 203.7 KB, was
not affected.
The second run, at commit `0dc7199`, installs exactly each probe's packages
before its build; its output, `spike/measured-2026-10-15-second-run.txt`, is
what the table shows, and B's and C's figures are the same in both runs.

Two more things depart from the registration. A control build was added, the
same button importing a module with no provider in it, so that the button's
own weight can be told apart from the provider's. And M1 is given twice: what
the click loads at once, and everything the loaded code can fetch later
through a further `import()`, since "every script the click loads" can be read
either way. The comparison the registration calls "below" stands above it in
this note.

| Build | M1, at once | M1, at most | the same, uncompressed | M2: settings pages | M2: every other page | M3 |
| --- | --- | --- | --- | --- | --- | --- |
| Control, no provider | 0.1 KB | 0.1 KB | 0.0 KB | 94.4–94.5 KB, +0.5–0.6 | +0.0 | builds |
| B, Base Account SDK | 159.7 KB | 160.8 KB | 550.3 KB | 94.5–94.6 KB, +0.6–0.7 | +0.0–0.1 | builds |
| C, CDP embedded wallet, no interface | 86.4 KB | 86.4 KB | 350.8 KB | 94.6–94.7 KB, +0.7–0.8 | +0.1–0.2 | builds |
| R, CDP embedded wallet with Coinbase's sign-in | 203.6 KB and a 5.1 KB stylesheet | 203.7 KB and the stylesheet | 987.7 KB | 94.8–94.9 KB, +0.9–1.0 | +0.3–0.4 | builds |

R's stylesheet belongs to the file its click loads at once, as Vite's
manifest of that build records. The changes in M2 are against the figures
measured before the spike, 93.9 KB
on the settings pages and 91.5–95.1 KB elsewhere; the budget check prints one
decimal, so a change of 0.1 KB is within its rounding.

P1 held: B's click loads 159.7 KB at once and 160.8 KB at most, inside the
predicted 120–300 KB. P2 failed: C's click loads 86.4 KB, not more than
100 KB. P3 held: R's click loads 203.6 KB against C's 86.4 KB, the difference
being Coinbase's interface. P4 failed as it was written: the settings pages
grew by 0.6–1.0 KB with every provider. The control shows where that came
from: the button and its `import()` alone add 0.5–0.6 KB to the settings pages
and nothing elsewhere, and what each provider adds to any page's first visit
on top of the control is at most 0.1 KB for B, 0.2 KB for C and 0.4 KB for R,
which is code the provider shares with the dashboard being moved by the
bundler, the tool that packs the dashboard's scripts into files, into files
the first visit already loads. P5 failed for C and R: all
three built with the Vite configuration unchanged. Installing C and R did need
a decision of another kind: pnpm 11 refuses to install until `bufferutil` and
`utf-8-validate`, native modules of the WebSocket library `ws` reached through
Solana's client inside `@coinbase/cdp-core`, are allowed or declined a build
script, and the spike declined both. Whether C and R then run in a browser
without a stand-in for Node's `Buffer` was not tested: the measurement built
the code and did not run it. R's build did warn, twice, that the module
`buffer` "has been externalized for browser compatibility, imported by"
`safe-buffer@5.2.1`, which Coinbase's interface reaches through an encoding
library; the builds of B and C gave no such warning. `safe-buffer` reads
`Buffer` from that module when it loads, so R may fail when it runs
[inferred]. C and R ask for an ordinary account
(`createOnLogin: "eoa"`); a smart account is chosen by the same setting at run
time, so its code is very likely in the same bundle [inferred], but it was not
measured.

Two things were read in the packages while measuring, outside the
registration. B, unless told `telemetry: false`, inserts an inline script into
the page's head that starts Coinbase's analytics client and sends events to
`cca-lite.coinbase.com` (`dist/core/telemetry/initCCA.js`; the option defaults
to `true` in `dist/core/provider/interface.d.ts`), and C's code names the same
host. And B depends at run time on `@coinbase/cdp-sdk@1.58.0`, Coinbase's
server SDK, which only its server-side subscription functions use, while the
gateway, Agentify's server that answers agents and merchants' code, uses
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
  https://docs.base.org/sdks/migrated-products,
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
  `onramp/additional-resources/payment-methods`,
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
- Base: `eth_gasPrice` and `getL1FeeUpperBound` at
  `0x420000000000000000000000000000000000000F` read from https://mainnet.base.org,
  and the ETH price from https://api.coinbase.com/v2/prices/ETH-USD/spot, on
  2026-10-15.
- The packages: `@base-org/account@2.5.13`, `@coinbase/cdp-core@0.0.127`,
  `@coinbase/cdp-hooks@0.0.127` and `@coinbase/cdp-react@0.0.127` from the npm
  registry.
