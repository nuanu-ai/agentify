# How the portal is written

In force since 2026-08-26, agreed with the product owner and calibrated on
their feedback. The requirements it comes from:
docs/research/19-portal-requirements.md.

The portal is written in English (the product owner, 2026-08-27), the same
language as the landing the pages sit behind.

## Readers, and who each page speaks to

The portal has three jobs for three readers. The owner of the business decides
whether to connect at all, and needs five minutes to see the gain, the risk and
the price — not the mechanism. The engineer builds the integration, and needs
to reach a test purchase without asking us a single question. Both then operate
the thing, and need an answer to an operational question in ten seconds.

One text, one reader. Every page addresses exactly one audience, names it, and
holds that address and that level of abstraction to the end: consequences and
decisions for the owner, mechanism and contract for the engineer. A page whose
address jumps between "you, the owner" and "your code" is a mixture, and a
mixture is a defect. The FAQ groups its questions by reader explicitly.

What follows for deduplication: the mechanism lives once, on the engineer's
page; what the mechanism means for a decision lives once, on the owner's. Those
are two different texts about one fact, not a duplicate. A duplicate is the
mechanism retold twice to the same audience.

## The test every element has to pass

Every section, table and column comes from a question the reader actually asks,
and is worded in the reader's own words. An element that answers the author's
question ("is my model complete?") is a defect. At review, every heading and
every column is given the reader's question that produced it; if there is no
such question, the element is rebuilt.

The vocabulary is the vocabulary of the situation, not of the architecture.
Internal notions from the model — "the owner of a deadline", "a terminal
state", "an outcome" — do not go outside; everything is named in words from the
reader's life ("you did not deliver in time", "the agent did not pay", "the
order closed"). A word a merchant would not use in conversation about their own
shop is a candidate for replacement.

The unknown is stated honestly and not used as furniture: everything unresolved
lives in one section, "What is not settled yet", at the end of the page, and
the body carries no columns and no cells saying "not named yet". A column with
no information in it does not exist.

The example comes before the abstraction: the mechanism is shown on a concrete
case — a request and an answer, a scenario with numbers — and the rule comes
after. Example numbers are marked as examples.

Inverted pyramid: the first paragraph of a section answers the question in its
heading, and the details and the reasons follow.

The ten-second test: an operational question is found through a heading or
through search in ten seconds, and the headings of operational sections are the
reader's scenarios rather than categories of the model.

## Kinds of page

**Guide** (`quickstart`). Numbered steps, each of them an action the reader
takes, with the result to expect and the sign that it worked. It ends at a
state the reader can actually reach; a guide that cannot be walked to the end
is not published. Concepts and reasoning are linked to, not restated.

**Reference** (`cards`, `orders`). The unit is a field, a deadline, a
situation. A summary table opens the section and the detail sits under it. No
paragraph runs longer than three sentences; anything enumerable is a list or a
table; the order runs from the required to the optional.

**Explanation** (`index`, `money`, `failures`). Connected prose; the frame the
page declares is held to the end. No fields and no signatures — those are a
link into the reference.

**FAQ** (`faq`). The question in the reader's voice, the answer in two to five
sentences, a link to the full page. The FAQ routes; it does not answer.

## Vocabulary

Canon: handler (not worker, not receiver); card; order; idempotency key;
receipt; the price in the card (not a snapshot); the price check, answered by
the price handler (in the same process as the order handler), with the price
hook (the HTTP alternative for a separate pricing service; not an endpoint)
named only as designed and not called; how long a price holds (not a quote); agent
on the engineer's pages, buyer on the owner's (with "it is a program" said
once, at the first use on that page).

Not used: worker, snapshot, quote as the merchant-facing word for a price,
endpoint, "It was decided that…", and calques such as fail-open without a
definition on the spot. The reader is addressed as "you" and never described as
"the merchant" — that is our word for them, not theirs. A term is defined once,
in the reference; everywhere else links to it rather than retelling it.

## Delivery

A table is an enumeration with two or more attributes; a list is an enumeration
with one; prose carries causation, trade-offs and models. Announce a number of
items and then give the list. Paragraphs vary in length. The contrastive "X,
not Y" appears at most once per page. The turns "this is a deliberate
decision", "we say it honestly", "not decoration", "not a formality" are not
used. The headings of one page do not all start with the same word. The note
about the public contract being versioned is one line in the header, identical
everywhere.

Plain and unnarrated (the product owner's rule, 2026-08-26; the specimen
defect was "the code enters the conversation only on the first path"):

- Abstractions do not act like characters: code does not "enter a
  conversation", a page does not "lead" anybody, honesty does not "work".
  People and systems act: "you only have to write code on the first path".
- Metaphor and imagery are barred from the guides and the references; in the
  explanations an everyday example is allowed, but not imagery. A sentence that
  reads as a translation is rewritten as English: actor, verb, object.
- The essayist's connectives ("and here is where this comes from", "it has a
  second role too", "let us be frank") are replaced by plain ones: "because",
  "for example", "and".
- The test: a sentence you would not say to a colleague across the desk in your
  own voice gets rewritten.
- Rhythm comes from the length and the structure of sentences, not from
  imagery.

## The order of hand-over

1. **Reading by role, against a task** — the main gate. Two agents with clean
   context are given roles and tasks rather than texts: the owner decides from
   the portal whether to connect, and names what was missing; the engineer
   walks the path to a test purchase from the texts alone, and names every
   place where they got stuck. The portal is ready when both roles reach the
   end and their questions match the "What is not settled yet" sections.
2. **Content review with clean context** — contradictions between the pages and
   with the canon, claims beyond their evidence.
3. **A technical writer's pass** — who each page speaks to, what kind of page
   it is, the vocabulary, tables against prose, links against repetition.
4. **The humanisation filter** — machine rhythm is rewritten, not softened.

## What the build understands

The pages are Markdown, drawn into HTML when the documentation is built by
markdown-it, the parser VitePress is built on, so a table, inline HTML and a
line break come out as markdown-it writes them. A few things plain Markdown
does not have are understood because the pages use them, and nothing else is.

A heading's anchor is made from its words the way VitePress makes it, so a link
into a page keeps its target; a heading that begins with a digit gets an anchor
that begins with an underscore (`_1-make-the-merchant-account-ready`). A heading
can name its anchor itself with `{#id}` at its end, which the scanner's pages
do so their old anchors keep working.

A box is written as a container: `::: warning <title>` up to a line of `:::`.
The kinds are `tip`, `info`, `warning`, `danger` and `note`; each but `note`
prints its kind where it is given no title.

An example payload is not written into a page but included from its file with
a line of its own, `<<< @/examples/card/access-monthly.json`, where `@/` is this
directory. The page then shows the very file the contracts tests validate. An
include always shows the whole file: a region (`#name`) or options (`{2,4}`)
after the path stop the build.

A diagram is a `mermaid` code block. The build does not draw it: it shows the
drawing kept in `diagrams/` under the hash of the diagram's source, and stops
when there is none. Give it an accessible name with `accTitle:` and explain
the sequence in `accDescr:` so a reader using a screen reader can follow it.
After writing or changing a diagram, run
`pnpm --filter @agentify/docs diagrams`, which draws what is missing in
Chromium and deletes what no page uses, and commit the drawings with the page.

What a deployment decides is not written into a page but named: `{{origin}}`
for the site's address, `{{abuse-email}}` and `{{operator}}` for the scanner's
contacts. Caddy fills each in when it serves the page, as it fills the notice
that names the channel, so the test channel's pages name the test site. A name
works in text, in inline code and in a link's address, and not in a code
block. A part of a page shown only while the operator's legal identity is not
published goes inside `:::: unless identity-confirmed` up to a line of `::::`.
A name the build does not know stops it.

A link to another page is written from the documentation's root, `/orders` or
`/orders#telling-a-repeat-apart`, and is followed without a reload; a link that
starts with `http` opens apart; inline HTML is passed through as written.

Everything else VitePress can do is not understood: code groups, highlighted
lines, imported regions of a file, emoji shortcodes, front matter and Vue
components either print as written or are dropped. Such a feature is written
into `app/markdown.server.ts` before a page uses it, with a test.

Each page is listed in `DOCS_GROUPS` in `packages/ui/src/docs.ts`, which the
contents, the header's menu and the scanner's `llms.txt` read, and given its
file in `app/pages.ts`. A
client that prefers Markdown is answered with the page's Markdown as the build
writes it out: examples included, boxes as quotations and links whole.
