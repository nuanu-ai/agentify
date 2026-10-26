# What the scanner could not read

The agent-readiness scanner gives each of its 18 checks a verdict from what it
fetched from the site. This note records how a check tells a document it read
from one it could not read, why a refusal and a size past the read limit are
verdicts, and why a check it could not settle lowers coverage and leaves the
score alone. The public account of the same rules is the
scanner's methodology page, `apps/docs/scanner/methodology.md`.

## The defect this answers

The checks used to read a response in two states, there or not there, and so
said "not there" about things the scanner had simply not read. An MCP server
card of exactly 1 MiB passed, and one byte more failed with "publish one",
because the fetch cut it at its 1 MiB limit and the cut JSON did not parse. A
card the site answered with 403 was told to "publish one", which is the wrong
advice when the card exists and is refused. A single-page
application that answers every address with its own page got "your llms.txt is
malformed" and "your A2A card cannot be used". A sitemap index whose second
sitemap answered 503 lost points, while one whose second sitemap answered 404
passed. In each case the result stated a fact about the site that the scan had
not observed.

## One reading of every request

Every request a check reads now comes to one of five outcomes:

1. Read whole: the answer was 2xx and shorter than the read limit.
2. Cut at the read limit: the answer was 2xx and longer than the limit, so
   only its first part was read. The limit is carried with it.
3. Absent: the answer was 404 or 410.
4. Refused: any other 4xx, such as 401, 403 or 451.
5. Unread: no answer at all, a timeout (408), a rate limit (429), a server
   error, or a status that is neither 2xx nor 4xx.

The read limits are the scanner's own and stay as they are: 512 KiB for
robots.txt and llms.txt, 1 MiB for a discovery document (MCP, UCP, A2A, OAuth),
2 MiB for a page, 5 MiB for a sitemap. A result that depends on a cut answer
names the limit in its evidence as `read_limit`.

Each check then judges the content by its format. A web page or an empty body
where a document belongs is no document, whether it was read whole or cut,
because a site that routes every address to its application says "not here"
that way. A web page is recognised by `<!doctype html` or `<html` anywhere in
its first KiB, since a comment, a server warning or an XML prolog can come
first. A JSON discovery document read whole is judged when it parses to an
object and is reported as unparseable, with a fix of its own, whatever else it
is, including a body that opens with a comment or a guard against script
inclusion. A gzip sitemap is named as compressed and left unread: the fetch
keeps a body as text, which loses a compressed file's bytes, so the scanner
cannot open it.

## How each outcome counts

A refusal at a path is a rule every agent asking meets, when the home page and
the agent probes were read: the scanner is refused for the same request an
agent would make. So a refused document is scored as the absence it is to an
agent, in words of its own that say the address answered with that status and
ask the owner to allow the document or answer 404. A required document fails;
the optional llms.txt and A2A card do not apply. Taking a refusal as unknown
is rejected, because it lets a static site that answers 403
for every missing file, or a rule that denies `/.well-known/`, score as if
it had been assessed favourably, and it lets any site raise its score by
refusing the paths it lacks. A refused request for Markdown counts as no
Markdown for the same reason.

A size is known once a response is cut. A discovery card larger than 1 MiB is
too large, a failure, as a page larger than 2 MiB fails the page-weight check;
an llms.txt with no heading and link in its first 512 KiB is too large for
what the file is for; and a robots.txt longer than 512 KiB is partial, because
crawlers are only required to read its first 500 KiB. A sitemap may lawfully
reach 50 MB, so the 5 MiB limit is the scanner's and not the site's: a cut
sitemap is judged by the entries read, and one cut before any entry is not
judged.

Only no answer, 408, 429 and a server error leave a document unread. Such a
check is unavailable, the state the scan already used for a request that timed
out. Its weight leaves the assessed denominator, so it lowers coverage and the
score is computed over what was assessed. Below 70% coverage the result is
provisional, and below 30% it has no score. Giving partial credit to an unread
document would invent a verdict, and raising the read limits would only move
the edge, because some limit has to stay to protect the scanner.

robots.txt is read the same way. A refusal is reported as refused with its
status; without its rules the scanner reads no other address of the site, and
crawlers may take the site as having no rules at all. A 408, 429 or server
error leaves the check unavailable.

## Sets of documents

When a check reads several documents, a defect proven by what was read
stands, while a pass, or a verdict that nothing complete exists, needs every
document read. A sitemap index whose listed sitemaps did not all answer is not
passed: it is partial when a defect was proven in what was read, such as a
listed sitemap that answered 404, and unavailable otherwise, with each sitemap
that did not answer named in `sitemaps_unread`. Entries and dates are counted
from sitemaps of pages, so an index's own dates no longer pass the set. One
complete MCP card at either location passes, but an incomplete card beside a
location that did not answer is left unjudged, since a complete card may sit
there. An OAuth document whose addresses do not use HTTPS stays a defect
though the other document did not answer. The OAuth check does not say that no
sign-in is declared while a card that could declare one was not read whole.

## One cause, one result

A result that is not a pass names one cause and the items involved. A summary
code covers one cause and its fix covers that cause. Where a code covered
causes that need different fixes, it was split: a sitemap that is empty, is not
a sitemap, lists a missing sitemap, has no dates or has stale dates, or could
not be read whole; a discovery document that is refused or too large; robots.txt
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
"entry 2 of the sitemap index" or "declared sitemap 1", because the report does
not show addresses and the prompt's filter drops any dotted word such as a
file name. Language codes the page wrote are shown at most 35 characters long.

## Figures beside a threshold

A coverage of 0.698 was shown as 70% beside the word "Provisional", which is
decided on the raw value under 0.7. Every place that shows coverage now uses
one rule that rounds a share down to the whole percent it has reached, so a
figure never shows a line it has not crossed and only a whole share reads
100%. The sitemap's stale-date rule, more than four in five dates older than
180 days, compares the counts exactly, and the evidence gives the two counts in
place of a rounded percentage.
