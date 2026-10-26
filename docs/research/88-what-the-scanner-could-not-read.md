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
4. Refused: any other 4xx, such as 401, 403 or 405.
5. Unread: no answer at all, a timeout (408), a rate limit (429), a refusal
   of the scanner's own request headers (431), an answer that depends on
   where the scanner asks from (451), a server error, or a status that is
   neither 2xx nor 4xx.

The read limits are the scanner's own and stay as they are: 512 KiB for
robots.txt and llms.txt, 1 MiB for a discovery document (MCP, UCP, A2A, OAuth),
2 MiB for a page, 5 MiB for a sitemap. A result that depends on a cut answer
names the limit in its evidence as `read_limit`.

Each check then judges the content by its format. A web page where a document
belongs is no document, whether it was read whole or cut, because a site that
routes every address to its application says "not here" that way. A web page
is an answer that opens with `<!doctype html` or `<html` once white space,
comments and an XML prolog are passed over; looking anywhere further in would
take a card or an llms.txt that mentions a page's markup for a page. A JSON
discovery document read whole is parsed first: an object is judged, an empty
body or a web page is no document, and anything else is reported as
unparseable, with a fix of its own, including a body that opens with a comment
or a guard against script inclusion. An empty llms.txt is malformed, an empty
sitemap is not a sitemap, and an empty robots.txt passes, as the robots
standard reads it.

A sitemap may be served as a gzip file, as `.xml.gz` sitemaps are. The fetch
recognises one by gzip's magic bytes, never by its media type alone, since a
server can send readable XML gzip-encoded under a gzip media type, and unpacks
it as it reads. The sitemap read limit bounds what it unpacks to, so a file
that expands without bound stops at the limit and reads as cut. Only a body
still gzip after that, as a file compressed twice is, is left unread. A gzip
file that cannot be unpacked keeps the status the site answered and a code of
its own, and the sitemap check reports it as broken, since the site's file is
known and an agent cannot read it either.

The bytes taken from the network for one body are bounded apart from what they
decode to, at twice the read limit and 64 KiB. A body built not to decode,
such as a stream of empty compressed blocks, would otherwise run until the
request's time ran out; it stops at the bound with a code of its own and the
status kept. Every decoder runs in a pipeline that closes the response when
decoding fails, so a body that cannot be decoded does not hold its connection
open.

## How each outcome counts

A refusal at a path is a rule every agent asking meets, when the home page and
the agent probes were read: the scanner is refused for the same request an
agent would make. So a refused document is scored as the absence it is to an
agent, in words of its own that say the address answered with that status and
ask the owner to allow the document or answer 404. A required document fails;
the optional llms.txt and A2A card do not apply. An MCP server card whose
address answers 401 with a Bearer or OAuth challenge fails in words of its
own, since discovery comes before sign-in and a card behind one serves none. Taking a refusal as unknown
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

Only no answer, 408, 429, 431, 451 and a server error leave a document
unread. A 431 is about the scanner's own request headers and a 451 depends on
where the scanner asks from, so neither says what an agent would meet. Such a
check is unavailable, the state the scan already used for a request that timed
out. Its weight leaves the assessed denominator, so it lowers coverage and the
score is computed over what was assessed. Below 70% coverage the result is
provisional, and below 30% it has no score. Giving partial credit to an unread
document would invent a verdict, and raising the read limits would only move
the edge, because some limit has to stay to protect the scanner.

robots.txt is read the same way. A refusal is reported as refused with its
status; without its rules the scanner reads no other address of the site, and
crawlers may take the site as having no rules at all. An answer that leaves a
document unread leaves the check unavailable.

## Sets of documents

When a check reads several documents, a defect proven by what was read
stands, while a pass, or a verdict that nothing complete exists, needs every
document read. A sitemap index whose listed sitemaps did not all answer is not
passed: it is partial when a defect was proven in what was read, such as a
listed sitemap that answered 404, and unavailable otherwise, with each sitemap
that did not answer named in `sitemaps_unread`. So is each sitemap the index
lists on another host that the scan did not fetch while it had read fewer
than its three files, as "listed on another site, not read". Entries and dates
are counted from sitemaps of pages, so an index's own dates no longer pass the
set. One complete MCP card passes whatever the other location answered, but
an incomplete card beside a location that did not answer is left unjudged,
since a complete card may sit there. OAuth metadata with one document missing
and the other unanswered says that a document is missing, since none was
read. An OAuth document whose addresses do not use HTTPS stays a defect
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
