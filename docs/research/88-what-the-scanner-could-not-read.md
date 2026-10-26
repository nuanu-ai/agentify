# What the scanner could not read

The agent-readiness scanner gives each of its 18 checks a verdict from what it
fetched from the site. This note records how a check tells a document it read
from one it could not read, and why a check it could not settle lowers coverage
and leaves the score alone. The public account of the same rules is the
scanner's methodology page, `apps/docs/scanner/methodology.md`.

## The defect this answers

The checks used to read a response in two states, there or not there, and so
said "not there" about things the scanner had simply not read. An MCP server
card of exactly 1 MiB passed, and one byte more failed with "publish one",
because the fetch cut it at its 1 MiB limit and the cut JSON did not parse. A
card the site answered with 403 was reported as absent. A single-page
application that answers every address with its own page got "your llms.txt is
malformed" and "your A2A card cannot be used". A sitemap index whose second
sitemap answered 503 lost points, while one whose second sitemap answered 404
passed. In each case the result stated a fact about the site that the scan had
not observed.

## One reading of every request

Every request a check reads now comes to one of four outcomes:

1. Read whole: the answer was 2xx and shorter than the read limit.
2. Cut at the read limit: the answer was 2xx and longer than the limit, so
   only its first part was read. The limit is carried with it.
3. Absent: the answer was 404 or 410.
4. Unread: anything else, which covers no answer at all, a server error, a
   refusal such as 401 or 403, and a rate limit.

The read limits are the scanner's own and stay as they are: 512 KiB for
robots.txt and llms.txt, 1 MiB for a discovery document (MCP, UCP, A2A, OAuth),
2 MiB for a page, 5 MiB for a sitemap. A result that depends on a cut answer
names the limit in its evidence as `read_limit`.

Each check then judges the content by its format. A JSON discovery document
read whole is either an object, which is judged, or something that opens as
JSON and does not parse to an object, which is reported as unparseable with a
fix of its own. An answer that does not open as JSON at all, such as a web
page, a line of text or an empty body, is no document, whether it was read
whole or cut, because a site that routes every address to its application says
"not here" that way. The same holds for a web page served where robots.txt,
llms.txt or a sitemap belongs. A JSON answer that opens as JSON and was cut is
not judged.

What was read proves what it contains and nothing about the rest. A heading
and a link found in the first 512 KiB of an llms.txt pass the check; their
absence from a cut file leaves the check unjudged. A sitemap cut at 5 MiB is
judged by the entries read, and one cut before any entry is unjudged. The HTML
checks already followed this rule for pages cut at 2 MiB. It holds only while
the readers draw nothing from a construct the cut left open, such as a script
block, a comment or an attribute that never closes.

## How an unsettled check counts

A check the scanner could not settle is unavailable, the state the scan already
used for a request that timed out. Its weight leaves the assessed denominator,
so it lowers coverage and the score is computed over what was assessed. Below
70% coverage the result is provisional, and below 30% it has no score.

The alternatives were weighed as follows. Counting an unread document as a
failure is the defect itself, since the read limit is the scanner's and a
refusal to the scanner is often a bot rule that a real agent would not meet;
the home page already follows this rule for a 401, 403 or 429. Giving partial
credit to an unread document would invent a verdict in the other direction.
Raising the read limits only moves the edge, because some limit has to stay to
protect the scanner, and the defect was the edge reported as the site's fault.

Three results keep a verdict because the fact is known. A page cut at 2 MiB
fails the page-weight check, since its size is over the budget. robots.txt
follows RFC 9309, under which a crawler treats a 4xx answer as having no rules
at all, so a robots.txt answered with 403 is reported as refused, a failure
with the status named. A robots.txt longer than 512 KiB is partial, because
crawlers are only required to read its first 500 KiB.

A verdict that nothing usable exists needs every location answered. When one
of the two MCP card locations answered 404 and the other timed out, the check
is unavailable. When a sitemap index lists a sitemap that answered 503, the
check is judged by the sitemaps read, the unread one is named in
`sitemaps_unread`, and the score is not lowered; one that answered 404, was
empty or was not a sitemap is a defect named in `sitemaps_missing`. The OAuth
check no longer says that no sign-in is declared when a card that could
declare one went unread.

## One cause, one result

A result that is not a pass names one cause and the items involved. A summary
code covers one cause and its fix covers that cause. Where a code covered
causes that need different fixes, it was split: a sitemap that is empty, is not
a sitemap, lists a missing sitemap, has no dates or has stale dates; robots.txt
that is refused, served as a web page's media type, too long or partly
malformed; a page without JSON-LD and one whose JSON-LD cannot be parsed;
missing required fields and too few recommended ones; a page too large and a
page too slow. Where a result checks one contract, such as the fields of an MCP
card or the Markdown negotiation, one code stays and the evidence lists each
unmet item by name.

The report drops an evidence key whose name contains a word it treats as
private, such as `url`, `ip` or `endpoint`, so `url_count`, `script_count` and
`endpoint_present` never reached the owner. Those keys were renamed or folded
into a `fields_missing` list. A sitemap is named by where it was listed, such as
"entry 2 of the sitemap index", because the report does not show addresses.

## Figures beside a threshold

A coverage of 0.698 was shown as 70% beside the word "Provisional", which is
decided on the raw value under 0.7. Every place that shows coverage now uses
one rule that rounds a share down to the whole percent it has reached, so a
figure never shows a line it has not crossed and only a whole share reads
100%. The sitemap's stale-date rule, more than four in five dates older than
180 days, compares the counts exactly, and the evidence gives the two counts in
place of a rounded percentage.
