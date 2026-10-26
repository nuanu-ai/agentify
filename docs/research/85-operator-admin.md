# The operator's admin

2026-10-23. Design note: who the admin serves and why, what it does and what
it never does, how its actions are protected, how it is built, and its screens
from the map of the workspace down to the marks on a chart. The screens were
also drawn as a clickable prototype on example data, kept outside the
repository; nothing here depends on it.

## What the admin is

Agentify sells a merchant's goods to AI agents without anybody at Agentify
taking part in a sale: the gateway takes the purchase, the agent pays into the
merchant's own payout contract, the merchant's code or shop delivers, and the
outcome of a payment is settled by the facilitator's answer or by evidence on
the chain. What is left to people is small and specific. Somebody decides
which merchant may sell for real money. Somebody notices when a part of the
machine has stopped, or when a payment's outcome has stayed unknown for too
long. Somebody answers a merchant who writes in about an order and wants to
know what happened. Somebody steps in when a key leaks or a session is stolen.
Somebody watches whether the product is growing. The admin is the private part
of the site where those people do that work.

Today that work is spread over three places that do not know about each other.
`/admin` shows the scanner's numbers: visitors, scans, registrations, the
scanner's own budget and the latest scans. `/dashboard/admin/live-sales` finds
a merchant by the email they sign in with and admits them to live sales.
Everything else is a set of commands typed at the terminal of the channel's
host: withdrawing an admission, taking a listing name away, disabling a key,
ending a person's sessions, granting the operator flag, printing payout
transactions, forgetting an address on the test channel. The product owner
decided on 2026-10-23 that those commands were a stand-in until the admin
existed, and that the admin now takes them over. This note designs one
workspace in place of all three.

## Words this note uses

A *channel* is one deployment of the product: the test channel settles
payments on Base Sepolia with test funds, the live channel on Base with real
money. Each channel has its own database, its own merchants and its own admin.

The *gateway* is the part of the product that takes an agent's purchase, keeps
the order and its state, and hands the order to the merchant. The *dashboard*
is the merchant's own site, where they sign in, set their seller name and
payout wallet, issue keys and read their orders. The two run in one process.
The *scanner* is the public front page that checks a shop's readiness for
agents; it runs as an application of its own. The *facilitator* is the payment
service that verifies an agent's signed payment and executes it on the chain.

An *operator* is a person who runs a channel. On the site an operator is an
account carrying the operator flag, and every admin page checks the flag on
every request. The *terminal* is a shell on the channel's host, inside the
application's container, where the administrative commands run today.

A *merchant* is a seller on one channel, created by an account that signed in.
A merchant sells through one *integration* at a time: their own code written
against the SDK, whose running process is the *worker*, or a WooCommerce shop
connected from the dashboard. A *card* is one product as an agent reads it. An
*order* is one purchase of one card, with a state the gateway keeps.

A *split* is a merchant's payout contract. Every payment goes into the split
of the wallet the merchant had set when the payment was verified. A payout, a
transaction anybody may send for the price of gas, distributes what a split
holds by crediting 99.9% to that wallet and 0.1% to Agentify's commission
wallet in a warehouse the splits share, and withdraws the merchant's share;
Agentify's share waits in the warehouse until it is withdrawn the same way. A
merchant who changes wallets gets a new split, and the old one keeps whatever
was paid into it until a payout covers it.

A payment's outcome is *unknown* when the facilitator did not say whether the
money moved and the chain has not yet shown either the transfer or proof that
it cannot happen. Unknown is a state of its own: it is neither paid nor
refused.

A *fresh sign-in* is a sign-in made in the last fifteen minutes, by the same
email link or Google account the operator always uses. The *journal* is the
record of administrative actions this design adds: who did what to which
merchant or account, when, from where, the reason given and the outcome.

## Who needs the admin, and for what

The roles below are hats, not job titles. At this stage one or two people wear
all of them; the design serves the questions each hat asks, so that the
screens stay right when the hats go to different people.

The product owner asks whether the product is working as a business. How many
merchants came in, how far each got, which of them sell, how much was sold
this week and what Agentify earned from it. The owner also holds the one
decision the product reserves for a person: admitting a merchant to sales for
real money. For this hat the admin is a page read once a day, and a decision
taken whenever a merchant is ready for it.

Whoever looks after the channel asks whether anything is stuck that the
automation cannot resolve, and where to look first. A payment whose outcome is
still unknown after hours, a merchant whose worker stopped answering while
their cards are on sale, payment recovery that has no chain endpoint to read,
sign-in mail close to the channel's hourly ceiling. Request latency, error
rates and host capacity are already answered by the channel's Service health
dashboard in Grafana; the admin answers the same question in the product's own
terms, with the names of the merchants and the orders involved, and links to
Grafana for the time series behind it. The same hat steps in when something
goes wrong with a person or a credential: a merchant reports a leaked key, an
account behaves like an attacker's, a seller name impersonates somebody.

Whoever answers a merchant's message asks what happened to one order, one
payment or one merchant, and needs to find it from whatever the merchant
pasted: an order identifier, a transaction hash, an email address, a site.
They need the order's whole story in the words the merchant and the agent were
shown, so that the answer they write matches what both sides saw. They
explain; they do not change the outcome. Nothing in the product promises a
merchant that anybody will answer, and the admin does not change that.

Whoever looks after the scanner asks how many people arrive, how many scan,
how many go on to sign in and become merchants, and whether the scanner's paid
browser budget is safe from abuse. This is today's `/admin`, and it stays.

Two groups never use the admin. Merchants have their own dashboard, which
already shows them everything about their own selling. Buyers and their agents
read orders and receipts through the API. And no sale ever waits for anybody
in the admin: if every operator were asleep for a week, every purchase would
still complete, settle and be delivered as it does today.

## What the admin does, and what it never does

The admin reads everything about its channel. Its actions are exactly the
administrative ones the live-sales page and the terminal hold today, each
moved to the screen where its subject is:

| What does it today | Where it is in the admin |
| --- | --- |
| The live-sales page, and `pnpm approve <email>` | Admit to live sales, on the merchant's page |
| `pnpm approve --withdraw <email>` | Withdraw the admission with a note the merchant reads, on the merchant's page |
| `merchant keys <merchant>` and `merchant disable <key>` | The merchant's keys, each with Disable, on the merchant's page |
| `merchant list` and `account list` | The Merchants and Accounts lists |
| `account revoke <email>` | End every session, on the account |
| `account operator <email>` and `--off` | Make an operator, or remove the flag, on the account |
| `gateway payout` | Each split's payout transaction, on Money |
| `facilitator-key` and `smoke:listing` | Check now, on Health; both stay as engineering's checks too |
| `pnpm forget <email>`, on the test channel | Forget this account, on the test channel's admin only |

Two commands are not carried over, and are deleted with the rest.
`woo:recover` binds an existing WooCommerce order to its sale acting as the
merchant, and the merchant already has their own recovery page reached from
their Orders; the admin shows that such an order waits and says that the
merchant recovers it there. `listed-as` sets a merchant's seller name for them
or takes it away. The seller name is the merchant's own, and the admin does not
touch it: the one lever the operator holds over a merchant is the admission. A
merchant whose name, cards or conduct do not belong on the live channel has
their admission withdrawn with a note that tells them why, and is admitted
again once that is put right (the product owner, 2026-10-24). Each
administrative command is deleted once its counterpart ships, so that a power
exists in one place only. The two checks are the exception, because they
change nothing: the release runs the facilitator-key check before it activates
a revision, and the listing check is one of engineering's smoke checks, so
both stay where they are, and the admin runs the same checks on demand.

What stays outside the admin is engineering, not administration: taking a
release, migrating a database, the paid smoke purchases with their spending
caps, the check of the commission wallet, and the nightly privacy clean-up a
release installs. A button that migrates a database or spends money is the
kind of control that can take a deployment down without anybody meaning to,
and those keep the release process and its checks.

Every action is idempotent, names its consequence on a checkbox that has to be
ticked, asks for a fresh sign-in, records itself in the journal, and when its
answer is lost says that the outcome is unknown and that reading the record
again shows the truth. Each consequence is the one the terminal's command has
today. Withdrawing an admission takes every one of the merchant's cards off
sale on the live channel at once, because selling there requires it; it
cancels no order already taken and moves no money. The merchant's dashboard
then says that their live sales were stopped, since when, and the operator's
note, until they are admitted again. Disabling a
key stops that key and touches no other. Ending a person's sessions signs them
out everywhere and keeps their account.

The admin never changes an order, never says whether a payment went through,
never confirms or promises a refund, never edits a merchant's wallet, cards or
the name they chose, never makes up a product, never signs in as a merchant,
never sends a message to a buyer and never moves money. These are not
omissions to fill later. The product is built so that the merchant owns
fulfillment, cancellation and refund policy, so that payment outcomes come
only from the facilitator or from the chain, so that Agentify holds neither
the merchant's money nor their goods, and so that no staffed step stands
inside an ordinary sale. The decisions on silent charges and on unfulfilled
orders reject, by name, a button with which an administrator declares a
payment's outcome or declares the parties settled. Such a button would make
Agentify the adjudicator the product refuses to be. For the same reason an
operator repeats the order's own word about its payment and never their own
reading of the chain: a transaction link is shown so that its existence can be
checked, not so that an operator can overrule the order. The order screen says
this in one sentence under every order, so that nobody looks for the button.

## How an action is protected

Moving these actions into a browser moves their risk with them. At the
terminal, taking every live merchant off sale or making a new operator needs a
shell on the channel's host. In the admin it would need only an operator's
session, which slides for thirty days and has no second factor; one stolen
cookie would be enough. The design keeps the powers and narrows what a session
alone can do.

Every action asks for a fresh sign-in. An operator who last signed in an hour
ago is asked to sign in again, by the same email link or Google account. The
new sign-in brings that browser back to the page the press came from, and the
operator presses again: nothing is queued while the sign-in is pending, and
nothing is carried out on the operator's behalf when the link is opened, so a
stolen cookie cannot leave an action waiting for the real operator's click.
The mail says that it confirms an administrative action and what to do if
nobody asked for it. The session records when it was opened, and a renewed
session keeps that moment, so the check needs nothing new and renewing a
cookie never makes a sign-in fresh. A stolen cookie can still read the admin
for as long as its thief keeps using it, since a session slides; it cannot act
without the operator's inbox or Google account. This is not a second factor,
since it asks for the same thing again.

Anybody who types an operator's address on the public sign-in form spends that
address's links, three an hour, and could keep an operator from acting during
an attack. The link the step asks for is therefore counted apart from the
public form's, and an operator whose Google account is eligible can use it
instead.

Every intervention asks for a reason: a withdrawal, a key disabled, sessions
ended, a flag granted or removed. The reason goes into the journal with the
action. An admission needs none. A withdrawal's reason is also the note its
merchant reads: their dashboard shows the newest withdrawal of their own
merchant while it stands, and nothing else of the journal, so the form says
that the merchant will read it and that it must name no buyer.

Granting or removing the operator flag mails every operator of the channel and
the account it changes, so that a new operator cannot appear without the
others hearing about it. The change waits until the mail has been handed to
the provider, as a payout wallet change does, and a refused hand-over leaves
the flag as it was. The mail names what changed and when, in the manner of the
dashboard's other notices: it says nothing like "you did this" and carries no
link that acts. Where a channel has one operator, the only inbox told is that
operator's own, which an attacker who holds it also reads; a second operator
is the remedy, not the mail. The last operator's flag cannot be removed, and
whether an operator is the last is decided under one lock, so that two
removals at once cannot both pass.

One power stays outside the browser on purpose: making the first operator of a
channel. The channel's configuration names an address; the first time the
channel has no operator, the account with that address receives the flag at
its next sign-in, the journal records that it came from the configuration, and
from then on the configuration is never read again, even if the channel later
has no operator. The last operator's account cannot be forgotten on the test
channel, and the scanner's deletion of an account without a merchant keeps an
operator's account until its flag is removed. A channel that has lost every
operator anyway is recovered on its host, by the statement `deploy/README.md`
names for it, which the journal records as the terminal's.

The author's own preference was to keep the operator flag at the terminal, as
the safest place for a power that creates more power. The product owner's
decision is that the admin takes it over; the fresh sign-in, the mail to every
operator and the journal are the conditions under which this design does so.

## How it is built

The workspace lives in the dashboard, under `/dashboard/admin`, drawn in the
same frame as the merchant's pages with a sidebar of its own. The dashboard is
where the operator flag is read, and it runs in one process with the gateway,
so the admin reads merchants, cards, orders, receipts and splits without a
second service between them. The frame already accepts an administrative set
of sections; the live-sales page uses it today and is folded into the
merchant's page. The site's header, and the dashboard's own header for an
account that holds the operator flag, carry a door named Admin that leads to
the workspace; nobody else's page names it.

The scanner's page stays the scanner's, at `/admin`. Its figures are read from
the scanner's own tables by the scanner's own code, and the dashboard and the
scanner share a database but not each other's tables, so the workspace shows
no scanner fact of its own: its Scanner section is a link to that page. The
page is drawn in the workspace's frame all the same. The frame is one
component in the shared interface package, with its stylesheet in the shared
visual package, and both applications draw it: the operator's mark, the
channel, the three groups of sections, the lookup and the phone menu. From
the scanner's page every other section is a link to the dashboard's page of
it, and the page's content is drawn in the workspace's own tiles, panels,
chart and lists. The sections' counts are the gateway's figures, which the
scanner's process does not read, so the scanner's page draws no count rather
than a zero.

The workspace's pages sit under a layout of their own inside the dashboard's
gate, and that layout checks the operator flag before any page's reading or
action runs, so a page added there is guarded by being there. Every action
checks the flag again when it is pressed, and a test walks every admin route,
reading and pressing, as a signed-in account without the flag. A visitor who
is not signed in meets the gate's sign-in; a signed-in account the flag does
not confirm gets the site's 404; while the identity service cannot answer, the
gate answers with its error page, as it does for every dashboard page. A form
posts only from the dashboard's own origin and names the account it was drawn
for, as every dashboard form does.

The operator's reads cross merchants. The tenancy decision says every screen
of the merchant's dashboard is scoped to one merchant and lists the readers
that look across merchants on purpose; the admin is among them. Its reads run
inside read-only transactions with a bounded statement time. The dashboard
hands its reader only to admin pages, after the flag check, and a test holds
that no route a merchant key or a buyer reaches can get it. A database role
that can only read would be a privilege rather than a transaction's mode; it
needs a role, a secret on both hosts and a change to the deployment, and is
left for when the channel has more than one person running it. A split waiting
behind a merchant's pending wallet change stays inside the registry of splits,
as the tenancy decision requires: the admin says that a wallet change waits
and when it lands, never the new split's address, and the lookup does not
resolve it.

The admin speaks the product's own words. A merchant's state is drawn with the
dashboard's view functions and vocabulary, and an order's state with the
function that writes its status on the wire, so the operator, the merchant and
the agent read one story in three places. Where the merchant reads
"Unfulfilled" and the agent reads `unfulfilled`, the operator reads both, side
by side, and nothing in between.

Every figure is read from the database when the page is asked for, carries the
moment it was read, and says "could not be read" when the read fails, never a
zero. A zero is drawn only from a read that succeeded and found nothing,
because "there are none" and "I do not know" lead an operator to opposite
conclusions. Figures are counted in the database with one predicate per
question, shared by every place that shows it: the count of payments with an
unknown outcome on the overview and the Payment unknown segment of the orders
use the same predicate, which covers a charge still settling as well as one
whose answer was lost, as the agent's `unresolved` does, and both read through
the partial index the orders table keeps for it. The channel's metrics are not
reused for this: they count only answers that were lost, they carry no
identifiers, and they stop at a thousand rows that include every order made in
the last fifteen minutes, which anybody can create in numbers.

The journal is a table that only grows. Withdrawing an admission today sets
the approval back to empty and keeps no trace of it, and the line the
dashboard logs for an administrative press is a process log that rotates away
with the container. Each row of the journal says when, which account acted,
which action, on which merchant, account or key, the reason given and the
outcome: done, unchanged where an idempotent repeat found the change already
made, or refused with its code. Accounts are named by their identifier, never
by an address, so that forgetting or erasing a person removes their address
and leaves the row saying that a deleted account acted. Only presses made
after the flag check write a row; a refused attempt, which changes nothing,
writes its row in a transaction of its own. An action and its row commit
together: the dashboard writes its own actions' rows in its own transaction,
and the gateway's actions take their row into the gateway's transaction, the
way its analytics outbox does today; withdrawing an admission gets the
transaction it lacks today. While a terminal command still exists, its rows
name the terminal as the actor, because the command does not know who typed
it. "Only grows" binds the application; whoever holds the database's own
credentials can still change a row, and the decision that creates the table
says so.

Each channel's admin reads only its own channel. The test channel and the live
channel share no database by design, and the workspace does not join them; an
operator who wants both opens both. The channel is named on every page, so an
admission is never given on the wrong one.

Some things never appear, even to an operator: the buyer's key and the status
address that carries it, a parcel's delivery address, the values a buyer
entered at purchase, the goods a merchant delivered, a shop's consumer key and
secret, a WooCommerce order key or download link, a scanner visitor's email
address, and a session's network address and browser. The order screen says
that such a thing exists and when it was erased, without showing it. A payer's
wallet is not shown either: where money moved, the transaction link already
names it, and where it did not, the order holds only the signer of an
authorization that never executed; any wallet address inside the facilitator's
own words is replaced by the words "a wallet". Accounts that signed in without
making a merchant or holding the flag, most of them people who only opened a
scanner's report, are counted and not listed.

The admin does not rebuild what the channel's Grafana dashboard already
answers: request rates, errors and latency, the host's capacity, and the
delivery of logs and metrics. It links there from the screens where those
questions arise.

The workspace runs without script, as the live-sales page does today. Every
page is drawn on the server; a chart is an SVG drawn there with its numbers
written beside it; a search is a form; an action is a form that posts and is
answered with the page in its new state. An identifier is shown short and
opens to its whole value, ready to select, instead of a copy button that would
need script, and a second press of an action is harmless because every action
is idempotent.

At ten times today's data the screens behave the same way. Lists are searched
and cut, and the cut says which rows of how many are shown. The Payment
unknown segment counts through its partial index. The other segments, and the
list across every merchant, have no index of their own yet: the list sorts by
creation time and identifier and needs an index on them, and each segment's
count reads every order's record, which a payment column written from the
record, as the state column is, would spare. Every read runs inside one
repeatable-read transaction with a statement bound, so a count and the rows it
counts agree; a section's count that takes longer than two seconds is left
off the sidebar while its statement runs to its bound.
Unpaid attempts that ended with nothing charged, which anybody can create and
which the gateway forgets after thirty days, are counted apart as lapsed, the
way the merchant's own Orders lists them. Charts are summed by day in the
database, so a busier month draws the same number of bars.

## The map of the workspace

The workspace has two levels. The first is its sections, always in the
sidebar: Overview, Merchants, Orders and Money about the business; Health and
Scanner about the machine; Accounts and Journal about the people. The second
is the records: one merchant, one order, one account. A record opens from any
list that names it, from the attention list on the overview, and from the one
box at the top of every page that finds anything by what an operator has in
hand.

That box is the workspace's most used control, because the usual reason to
open the admin is a message that quotes something. It reads what is pasted and
goes straight to the record: an order identifier (`ord_…`) to the order, a
merchant identifier (`mch_…`) to the merchant, a transaction hash to the order
it paid for, a wallet or a split a payment has gone to to the merchant it
belongs to, an email address to the account and its merchant, a site's address
to the merchant selling from it. When the text matches more than one record it
lists them. When it matches nothing it says so in words that claim no more
than the lookup knows: for a transaction hash, that no order on this channel
names that transaction yet, since an order whose payment is unknown may hold
none, with a link to the payments whose outcome is unknown. The identifiers
carry their kind in their prefix, so the box needs no choice of what to search
for.

Every section answers one question, and its first screen answers it before any
scrolling:

| Section | The question it answers |
| --- | --- |
| Overview | Does anything wait for me, and how is the channel doing? |
| Merchants | Who is on this channel, how far has each got, and who is selling? |
| Orders | What happened to this order, and which orders are in an unusual state? |
| Money | How much was sold, what did Agentify earn, and what is still unknown? |
| Health | Is every moving part answering, and since when not? |
| Scanner | How many arrive, scan and go on to sign in, and is the budget safe? |
| Accounts | Who can sign in, who holds the operator flag, and whose sessions are open? |
| Journal | Who did what to which merchant or account, and when? |

## The screens

### Overview

The overview opens with what waits, because it is the reason to come. A group
headed "Needs you" holds the decisions only an operator can take, with its
count in the red pill the merchant's dashboard uses for the same idea: today
that is a merchant who has a seller name and a payout wallet and is not
admitted to live sales. Whether their integration has connected and whether
cards are published are shown as facts beside them, not as conditions, since a
merchant may wait to run their worker on the live channel until they may sell
there. The merchant's own dashboard tells them they are not approved and has
no way to ask; this group is how the operator finds out that somebody is
waiting.

Under it a group headed "Worth a look" holds what the automation has not
resolved and an operator may want to understand, each as one sentence with the
record it names: payments whose outcome has stayed unknown, with the age of
the oldest; payment recovery not configured on the channel; a merchant whose
worker has not connected for longer than the gateway waits while their cards
are on sale, so that their cards are out of the catalogue and their purchases
are refused; on
the test channel, a WooCommerce order whose shop order may or may not exist;
analytics or ad reports given up; sign-in links near the channel's hourly
ceiling. Each item is a fact the database holds, not a task with a deadline;
nothing in the product waits for it to be cleared, and the group says so in
its heading's aside. When both groups are empty the overview says "Nothing
waits for you" and the moment it looked.

Under the attention groups stand four figures, each a tile in the dashboard's
style with a label in capitals, a figure in the monospaced face and a line
qualifying it: merchants selling now, out of all merchants on the channel;
orders in the last seven days, not counting lapsed attempts, with how many
were delivered; settled sales in the last seven days, in dollars, with the
count behind them; Agentify's commission accrued on those sales. The
commission's line says it is accrued in the splits, not received, because the
money stays in each split until somebody pays it out.

Below the figures, a chart of settled sales per day over the last thirty days
and a funnel of merchants sit side by side, the chart wider. The funnel starts
where somebody meant to sell, at an account that created a merchant, because
every account counts as signed in, including people who only opened a
scanner's report. Its steps are facts a table already holds: created a
merchant, set a seller name, saved a payout wallet, issued a key or connected
a shop, had its integration connect, was admitted, has a card on sale, made a
first sale. It is a picture of where people stop as things stand today, not a
measurement of how long they took. The overview ends with the latest rows of
the journal and a link to the rest.

### Merchants

The list of merchants opens with a search box and a row of segments with their
counts, the pattern the merchant's own lists use: All, Waiting for admission,
Selling, Setting up, Paused. Each row names the merchant by their seller name,
or by "Seller name not set" and their account's email address where there is
none, with the shop's site beside it. The other columns are the integration,
with whether its worker or shop has connected; the setup, drawn as three dots
for the three checks the live channel runs before it sells a merchant's card
(seller name, payout wallet, admission), with the missing ones hollow and
named in words beside the dots; cards on sale out of cards published; orders
and settled sales over thirty days, with the last sale; and the merchant's
state. The test channel runs the first two checks only, and its list draws two
dots. The list is sorted by what needs the operator first, then by the last
sale.

### One merchant

A merchant's page opens with the seller name, the site, the state in the
dashboard's badge, the merchant identifier, the account's email address and
when the merchant was created. Its left column holds the panel "Ready to
sell": four lines, each with a tick or a hollow circle and the fact behind it.
Three of them are the checks the gateway runs at every sale on the live
channel, and the panel says so; the fourth, the integration, is what publishes
the cards and takes the orders.

The first line is the seller name as buyers see it. The second is the payout
wallet, set in groups of four characters, with the split it pays out from and the link to that split on the chain's explorer;
where a wallet change waits, the line says when it lands. The third is the
integration: for code against the SDK, every key by its label with when it was
issued and last used, a working key with the action Disable; for a connected
shop, its address, when it connected and the permissions it granted, and any
order whose shop order is uncertain, which the merchant recovers from their
own Orders. The fourth is the admission, with the action that changes it:
"Admit to live sales" for a merchant not admitted, behind a checkbox that
names the consequence; for one admitted, when, and the action "Withdraw
admission", which opens in place a required note, which the merchant reads on
their dashboard, and a second checkbox that says what follows. For a merchant
whose admission was withdrawn, the line says when, by whom and with what note.

Every action on the page answers the same way. A press without a fresh sign-in
opens, in place, the step that asks for one: a link mailed to the operator's
address, or their Google account, which brings the browser back to this page
signed in afresh, where the operator presses again. The answer is the panel in
its new state with the journal row that recorded it; a refusal is one sentence
under the button; a lost answer says the outcome is unknown, that reading the
merchant again shows it, and that pressing again is safe.

The right column holds the merchant's selling: cards on sale out of published,
a thirty-day sparkline of settled sales, the orders that are open, unfulfilled
or waiting on the buyer, each linking to its order, and the merchant's history
from the journal. A sentence at the foot names what this page never does: it
edits nothing the merchant chose, and no order.

### Orders

The orders list is the operator's search across every merchant. It opens with
the search box, a filter by merchant, and segments drawn from the states the
gateway keeps, ordered by how unusual they are: Payment unknown, Unfulfilled,
Delivered not paid, In progress, Ended, Lapsed, All. Lapsed attempts are the
ones that ended with nothing charged; the segment says they are forgotten
after thirty days. A row names the moment the price was set, the merchant, the
product, the amount, the state as the merchant's dashboard words it, whether
the original payment is paid, not paid or unknown, and the order identifier.
The list is cut at fifty rows, and the cut says how many there are and links
to the earlier ones.

### One order

An order's page opens with the product, the amount, the merchant, the state
and the order identifier. Under the heading, two boxes side by side show the
two voices the order has outside: what the agent reads (its `status`,
`payment_status` and the reason it was given) and what the merchant reads in
their Orders, in their dashboard's words. The operator sees exactly what each
side sees, which is what an answer to either has to agree with.

The order's story follows as a timeline, oldest first, one dot for each step
the order went through. A step carries its time where the order's record keeps
one: when the order was made, when it was priced, when a charge was sent, when
it became paid, the last hand-over to the merchant with how many there were,
when a parcel's shipment was recorded, when the merchant closed fulfillment,
when a payment completed after that, when a parcel's address was erased, and
each thing the facilitator said, with its moment. Every other step, such as
the delivery of a download or the moment a deadline ended the order, carries
the words "time not recorded", never a time worked out from a deadline's
length. A step is captioned with what kind of step it is; an actor is named
only where the record names one, as a merchant's closure and the source of a
completed payment do. The screen says in one line under the timeline that the
record keeps the moments of its steps, not a log of every transition.

Beside the timeline, the payment panel: the amount and the split it was paid
into, the attempt and its state, the transaction with its link to the chain's
explorer where money moved, what the facilitator said in its own bounded
words, with any wallet address in them replaced, and the count of any that
fell off, and for an unknown outcome how long it has been unknown and what
recovery has recorded about it so far. Under it, the receipt, where the
gateway issued one, and for a parcel when its address was erased. The page
ends with the sentence that names its boundary: Agentify does not change an
order's outcome from here; the merchant closes fulfillment, and a payment's
outcome comes from the facilitator or the chain.

### Money

Money answers the owner's question in one place: settled sales and their count
over seven days, thirty days and all time; Agentify's commission accrued on
them; the payments whose outcome is unknown, counted apart and never added to
sales or to failures; and the splits. A settled sale is an order whose payment
settled, whatever became of the goods: an unfulfilled order counts, because
its money is in the merchant's split, and the screen shows how much of the
total such orders make up. A sale is dated by the moment the order records it
as paid: for a payment charged at purchase that is when the money moved, for
one charged after the goods it is when the payment was verified, and for one
recovered from the chain it is the time of its block. A sale with no such
moment recorded is counted in the totals and listed apart from the days, and
the screen says how many there are. Days are counted in UTC, and a past day
can still grow when a late outcome lands; the chart says so.

Commission accrues only where a payment went into a split. Live payments made
before payments went to splits, on 15 October 2026, went straight to the
merchant's wallet with no commission; the screen counts them apart and adds
nothing for them. The splits are listed one row per split, not per merchant,
because every wallet a merchant ever set has its own split and money can wait
in an old one; each row names its merchant, the wallet it pays and how much
has settled into it. Under the list stands the operator's payout, the
transactions the terminal's payout listing prints today: every recorded split
in parts of twenty, each created where it has no code yet, distributed and its
merchant's share withdrawn, the commission last, for a person to send from a
wallet of their own. The admin signs and sends nothing, and refuses to show
the transactions where the gateway would refuse to start on the registry of
splits. What a split has already paid out, and so what Agentify's commission
wallet has received, is on the chain; the screen links to each split on the
explorer and does not claim a balance.

### Health

Health is a list of the channel's moving parts, each a row with a state in the
dashboard's badge, the fact behind it and when it was read. The application
reads these facts for itself. The release row shows the source revision the
build wrote into the image, linked to its commit, or "unknown" with no link
for an image built on a laptop. Payment recovery is either not configured,
which turns it off, or reads the channel's network from an endpoint whose host
it names; whether its recent attempts reached the chain is in the logs, and
the row links there. The merchants' workers row says how many connected within
the gateway's window of ten and a half minutes, and which merchants with cards
on sale are out of touch, since when. The WooCommerce row counts connected
shops and the orders whose shop order is uncertain, and on the live channel
says that the connector is not offered there. The sign-in row counts the
sign-in and report links sent in the last hour against the channel's ceiling
of two hundred each. The outbox rows count analytics events and ad reports
given up. Two rows carry the action "Check now": whether the facilitator
accepts the channel's key, and whether Coinbase's x402 validator would take
the channel's paid resources, each with the moment of its last check; neither
check buys anything. The scanner's health is on the scanner's page, and this
list links there.

Some parts the application cannot see today, and the page says so rather than
leaving them out. The version tag a release was taken from and the last
production backup are written in files on the host, which no application
container reads; the facilitator's availability and the mail provider's
bounces are recorded nowhere. Each is a row drawn as "Not measured", with a
dashed dot and one sentence on where the fact lives, never as a green dot. The
test channel's backup row says instead that the test channel is not backed up,
by decision, because that is a fact and not a gap. Mounting the host's release
and backup status files read-only into the application would turn two of the
gaps into facts; that is a change to the deployment, with its own review.

### Scanner

The scanner's page keeps today's content and takes the workspace's
conventions: the acquisition figures as tiles, the thirty-day chart of landing
views against scans, the self-check, the abuse controls with their limits and
today's browser spending, and the latest scans as a list whose states are
drawn with the dashboard's badges instead of capitals in pills. Contact
details and raw evidence stay absent, as they are today. Four things change.
Today's chart scales both of its series to the landing views, so a day with
more scans than measured landing views is cut off at the top; the new chart
scales to the larger of the two. The limits shown beside the abuse controls
are read from the code that enforces them, not written a second time in the
page, so the page cannot go on showing a limit after the limit changes. The
worker's health, which only the scanner's health check reads today, joins the
page by that check's own rules; the daily browser cap lives only in the
worker's settings and the heartbeat does not carry it, so the page shows the
spending alone and says why no cap stands beside it. And the page counts the
access requests visitors have made through the route the privacy page names,
with the oldest still waiting; nothing records an answer to one today.

### Accounts and the journal

Accounts lists the accounts that made a merchant or hold the operator flag:
the address, the merchant if there is one, whether they hold the flag, how
many sessions are open and when the newest of them began. The accounts that
only signed in, most of them people who opened a scanner's report, are counted
and not listed. Segments separate the operators and the accounts with a
merchant. An account opens to its actions: End every session; Make an
operator, or Remove the operator flag; and on the test channel only, Forget
this account, which removes the account and its merchant so that the address
signs in again as a newcomer, and is refused while the merchant has orders or
receipts and for the last operator. Each asks for a fresh sign-in and a
reason, and the flag's two actions mail every operator and the account they
change.

The journal lists every administrative action, newest first, with the moment,
who acted, the action, its subject linked to the record, the reason, where it
came from (the workspace, or the terminal while a command remains) and its
outcome: done, or refused with its reason. It filters by kind of action and is
cut and searched like every other list.

## How it behaves

The workspace follows the merchant's dashboard in every interaction it shares
with it, so that an operator who is also a merchant meets one product.

A list is searched by a box and narrowed by segments that show their counts;
the segment in use is marked, and choosing another is a link, so the filtered
list has an address that can be sent to somebody else. A list longer than its
page is cut, and the line under it says which rows of how many it shows.

A record's identifier is shown short in the monospaced face and opens to its
whole value, ready to select. A transaction or an address links to the chain's
explorer for the channel's network.

An action is a form. Its consequence is named on a checkbox that has to be
ticked, and the button says exactly what happens. There are no pop-up dialogs:
the confirmation and the fresh sign-in stand where the action is, so they read
the same on a phone and to a screen reader. The answer is the page in its new
state, with the journal row that recorded the action.

Every screen of figures says when it was read. Nothing updates by itself and
nothing pulses, because a page that does not watch must not look as if it
does; reading the page again reads the figures again.

The workspace reads on a phone as the dashboard does: under 910 pixels the
sidebar gives way to the menu at the end of the header's row, the channel
moves to the head of the content, lists stack their cells into lines, and the
two columns of a record become one. An operator can admit a merchant, disable
a key or read an order from a phone; long reading of the money and the health
is meant for a wider window.

## How it looks

The admin is drawn in the product's one visual language: the paper ground, the
cards on it, the hairlines, the ink, the one teal accent, the verdict colours
for pass, partial and fail, the notice colours of pale amber with dark amber
ink, Schibsted Grotesk for words and IBM Plex Mono for figures, identifiers
and captions. It adds no colour and no face. What it adds are a few marks,
each built from tokens.

The operator's mark is a small dark chip reading "Operator" beside the logo
and name in the header, in the ink the footer band uses. It tells the
operator's workspace from a merchant's dashboard at a glance, which matters to
somebody who has both open in two tabs.

The channel stands at the head of the sidebar on every page, as its name and a
monospaced line with its address and network, marked with an ink dot for the
live channel and the notice colour for the test channel. The live channel's
dot is ink rather than the pass colour, because a channel is not a verdict and
a green dot would read as "healthy".

The sidebar groups its eight sections under three quiet captions in the
monospaced face, and a section with something waiting carries its count in the
pill the dashboard already uses, red only for what needs the operator.

States are badges: a dot and a few words in sentence case, the dot hollow for
a state not settled yet and dashed for one the admin could not read. Today's
scanner page writes its states in capitals inside coloured pills, and
separates a caveat with a coloured bar down its side; the workspace draws
neither, as the dashboard's own rules ask.

The chart of sales is bars on one scale with a hairline grid behind them, the
newest day in the darker accent. Every bar is labelled with its day and value
for a screen reader, and the figure the chart sums is written in words beside
it, so the chart is never the only place a number lives. A day with nothing
settled is a thin bar in the hairline colour, not a gap, so an empty day is
not mistaken for a missing one. On Money the part of a day paid for orders
with no delivery recorded sits on top in the partial colour.

The funnel draws each step as a track as long as the first step's count,
filled to the step's own count, so a drop reads as the empty part of a track
rather than as a number to compare. Each step carries its count and its share
of the step before, in one colour; the funnel shows where people stop and
leaves the judgement to the reader.

The setup dots, the timeline's dots and the readiness ticks all use the
verdict colours with a filled or hollow mark, so a reader who does not tell
colours apart reads the same thing from the shapes and the words beside them.

## In what order to build it

The size of each step is set by the stage the product is in: the first
external merchant coming onto the live channel, a handful of accounts in
setup, and one or two people wearing every hat. Each step below is useful
alone and leaves the workspace complete for what it covers.

The first step is the workspace with Merchants and one merchant, the admission
moved from the live-sales page, the fresh sign-in and the journal. The last
two come first because every later action stands on them, and they are built
once.

The second step moves the terminal's administrative commands into the
workspace, one at a time, and deletes each command as its counterpart ships:
the admission's withdrawal with its note, the keys, Accounts with sessions and
the operator flag, and on the test channel forgetting an account; the two
commands not carried over are deleted with them. The payout listing moves with
Money, in the fifth step. After the fifth step the terminal holds only
engineering's tools, its two checks among them, and the documented statement
that recovers a channel which lost every operator.

The third step is the lookup box and the orders with their timelines. It
answers a merchant's message without a database console and without asking the
merchant for more than they pasted.

The fourth step is the overview and Health, and the fifth Money, the funnel
and the scanner page's restyling in place. The scanner comes last on purpose:
it already has a page, and the product's selling path matters more.

## Decisions this design records

The product owner's word of 2026-10-23, that the terminal's administrative
commands move into the admin, is entered in the registration decision
([ADR-0014](../decisions/0014-registration.md)) and in the decision on one
identity ([ADR-0026](../decisions/0026-one-way-in.md) §6), which also carries
how the admin guards its actions: the fresh sign-in, the reason, the mail to
operators and the configured first operator. The tenancy decision
([ADR-0010](../decisions/0010-merchant-tenancy.md)) lists the admin among the
readers that cross merchants, inside read-only transactions. The journal has a
decision of its own
([ADR-0045](../decisions/0045-every-administrative-action-leaves-a-journal-row.md)).
The product owner's word of 2026-10-24, that the admission is the one lever
the operator holds over a merchant and that a withdrawal's note is the
merchant's to read, is entered in ADR-0026 §6 and in ADR-0045.

## Open questions

Whether a merchant is also told by mail when they are admitted, when their
admission is withdrawn, with its note, or when a key of theirs is disabled.
Their dashboard shows a withdrawal and its note; nothing else reaches them.

Whether an operator is told when something lands in "Needs you" or "Worth a
look", by mail or by a message, rather than finding it when they open the
admin. Nothing in the product alerts anybody today, and the observability work
chose the same.

Whether a fresh sign-in means fifteen minutes or another window, and whether
reading the admin should ask for one too.

Whether the money section should read the splits' balances from the chain, so
that commission received is a figure and not a link.

Who answers the access requests the scanner records through the route its
privacy page names; the scanner's page counts them and nothing records an
answer.

What "on sale" means in the admin. The counts of merchants and cards on sale,
the funnel's step "has a card on sale" and each merchant's cards on sale read
a card as on sale from the merchant's switch, the card's pause, the
integration and what the channel asks of the merchant. The public catalogue
also leaves out a card while its seller's own code is silent or while the
seller has left as many paid orders unserved as the gateway allows, and the
admin's counts do not; the silent sellers are named on Health and Overview,
and the unserved stop on the merchant's page. Folding those two into the
admin's "on sale" means a fifth copy of the rule in SQL and in the memory
reader, and makes the funnel's step move with a seller's worker, so it waits
for the owner of the admin to say which reading the counts should give.

Whether a merchant whose admission was withdrawn should stay under "Needs you".
Today they count there again, since they have a seller name and a payout
wallet and are not admitted, and the operator meets a decision they already
took; their page shows the withdrawal and its note.
