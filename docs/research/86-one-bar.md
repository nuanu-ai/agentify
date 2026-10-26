# The bar at the top of every page

This note describes the navigation bar that every page of `agentify.ad` draws,
and why it is built the way it is. It is a design note: the screens and the
mechanics may change without a decision record, as long as the reasons below
still hold or are replaced here.

## Who arrives, and what they look for

People reach the site by very different doors. A shop owner comes from an
advertisement or a search to the scanner's front page and runs a scan; some
return to their report from the link in an email. A business owner deciding
whether to sell through AI agents reads the merchant pages and then signs in.
The merchant's engineer lives in the documentation and comes back to the
dashboard for an API key. A merchant at work opens the dashboard from a
bookmark. An operator switches between the operator's workspace and their own
seller dashboard, often in two tabs. A site owner whose logs show our scanner
follows the address in its user agent to the page about the scanner bot, and
a person using their data rights opens the privacy pages, often from an email.

Two kinds of orientation follow from that. The first is what the site offers,
which is the reason a stranger came: the scanner and selling to agents. The
second is the places a person comes back to: the documentation, the
dashboard, and their own account. Reference pages, such as the scanning
methodology, the page about the scanner bot, the privacy notice and the terms,
are needed at the moment someone asks about them, and the links that lead to
them sit where that question comes up: the documentation's contents, the
report, the scan pages and the footer.

## What the bar is

One bar, the same component on every page: the public pages, the merchant
landings, the scan and report pages, the published result, the documentation,
the sign-in pages, the seller dashboard and the operator's workspace. It has
one height, one rule under it, and it stays at the top of the window.

On the left stands the lockup. On the public pages two links follow it, the
site's offers: "Scanner", the scanner itself on the front page, and "Sell to
agents", the merchant page. On a working page, the seller dashboard and the
operator's workspace, the lockup stands alone, because the page's sections live
in its sidebar; the operator's workspace keeps its "Operator" mark beside the
lockup, so it is never taken for a merchant's dashboard.

The right end is the same on every page: "Docs", "Dashboard", "Admin" for an
operator, and last the account menu, a button that shows the signed-in address
and opens the account's settings and the way out. A guest sees "Docs" and
"Dashboard" and nothing after them. The dashboard's door is the same word and
the same address for everybody: it leads to the sign-in, which sends somebody
already signed in on to their dashboard. A word that depended on the visitor,
such as "Sign in" for a guest, would need to know who is visiting before the
page is drawn, and the scanner's pages and the documentation are kept by
shared caches as one page for everybody, so the word would change after the
page loads, and without a script it would never appear.

The part of the site a page belongs to is underlined in the accent colour at
the bar's foot, as the dashboard's tabs mark theirs: Scanner on the front page,
the scan, the report and a published result; Sell to agents on the merchant
pages; Docs on every page of the documentation, the scanner's methodology
included; Dashboard on the sign-in pages and in the seller dashboard; Admin in
the operator's workspace. Nothing is marked on the privacy pages. Instead, the
data request and the email preferences carry a short trail above their heading,
"Privacy / Data request", whose first part leads to the privacy notice, so a
person who arrives there from an email knows where they are.

The lockup stands in the site's content column on the site's pages and at the
window's edge, above the sidebar, on a working page. Each layout has one
position, and every page of that layout uses it.

Every page offers "Skip to content" as the first thing a keyboard reaches, and
it leads to the page's main part.

## Who is signed in

The dashboard knows who is signed in when it draws a page. The scanner's pages
and the documentation do not: they are the same for everybody, and the
documentation is built ahead of time. Those pages ask the site once, from the
browser, who is signed in, and draw the account when the answer comes. While
they wait, and for a guest, the bar shows nothing after the doors, so a guest
never sees a placeholder appear and go. When the site cannot tell who is
visiting, the bar says "Sign-in unknown", which is not the same as showing
nobody: not knowing who somebody is must not look like knowing they are
nobody.

The account menu and the narrow window's menu are details elements. They open
and close before the page's script runs, need no script of their own to work,
and add nothing to a page's script budget beyond closing on Escape and when
the focus moves away. Signing out is a form that posts, because signing out
changes something and a link can be followed by anything that reads the page.

## A narrow window

Below 910 pixels the row keeps the lockup, "Docs", "Dashboard" and a menu
button, down to the 320-pixel minimum the site supports; in the operator's
workspace the mark takes that room and the doors move into the menu. The menu
lists, under rules between them, what the page has of its own (the
documentation's contents, the dashboard's sections, the workspace's groups),
then the site's offers and the doors the row left out, then the account: the
whole address, the settings and the way out. The sign-in pages have the menu
too, so the site's offers do not disappear on a phone.

## What the bar does not carry

The methodology and the page about the scanner bot are documentation pages
and live in the documentation's contents, in its Scanner group. The privacy
notice, the terms, the data request and the abuse contact live in the footer,
which is the same on every page. The merchant landing at `/sell` has no
navigation of its own; its "How it works" button leads into the page.

Every link the bar adds is something a stranger has to learn, so the bar holds
the two things the site offers and the three places people return to, and
nothing else.
