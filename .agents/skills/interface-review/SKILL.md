---
name: interface-review
description: "Reviewing, accepting, building or changing any Agentify screen or its copy: an expert review of whether a person understands the screen and can act on it, and whether it reads as designed by a person or assembled by a generator."
---

# Interface review

This skill reviews an Agentify screen as an experienced interface designer
would: whether a person understands it and can act on it, and whether it reads
as decided by a designer or assembled by a generator. Acceptance reviewers use
it for the U stories of the test plan, `docs/research/42-manual-test-plan.md`.
Whoever builds or changes a screen runs steps 1, 4 and 5 of the method on their
own screenshots at the four widths before handing the change over.

It is an expert review. Heuristic evaluation and the cognitive walkthrough are
expert methods by design: people who know how users behave inspect the
interface in the users' place. The verdict is evidence about the screen. It
does not measure whether a particular newcomer understood; that stays a
separate measurement with a person who took no part in the work, reported apart.

## The product's own rules

The look is defined in code, and a review points to it instead of restating it:
`packages/visual/tokens.css` for colours, the teal accent, faces, the four radii,
type sizes, spacing and rhythm, the 48px button and the mono uppercase
`.eyebrow`; `frame.css`, `editorial.css` and `workspace.css` beside it for the
signed-in frame and its rows, the reading pages and the operator's workspace;
"How it looks" in `docs/research/85-operator-admin.md` for badges and the
monospaced face; `docs/research/86-one-bar.md` for the bar at the top. The
scanner's front page is the reference for the look.

A size, radius, colour or gap that is none of these tokens is a finding,
because one-off values are how surfaces drift into looking like different
products. Where impeccable or the Vercel guidelines disagree with these rules,
ours win: impeccable bans the small label above a heading, and our tokens
define one, `.eyebrow`. No rule says how often a page may use it, so a reviewer
records a page that puts one over every section as a sign of step 4 and leaves
the limit to the owner. `pnpm gallery` draws every state into
`packages/gallery/dist/index.html`.

## Method, in this order

### 1. First look

From the screenshot of the first viewport alone, before the page text, the
accessibility tree or any code (after those nobody sees the screen fresh), write
down what the page is, whose it is (which account, test or live channel), what
state things are in, and the one next action. Then read the page and the data
behind it, and compare. A wrong first reading is a finding even when the page
corrects it further down, since most people decide from the first viewport. So
is a first viewport with no next action, or with two of equal weight.

### 2. Walk the task

Take the person and goal from their brief in the test plan ("People and
independent first attempts"): a shop owner who has just signed in and wants one
product on sale, a returning merchant looking for what needs attention today.
They know their business and none of our vocabulary. At every step answer the
four questions of the cognitive walkthrough; each "no" is a finding there.

1. Will they try to do the right thing? A banner that stops new sales because
   buyers have not paid gives the merchant no goal of their own to form.
2. Will they notice the control that does it? A report page for someone else's
   scan that offers no action fails here.
3. Will they connect that control with their goal? A banner saying sales are
   paused because the integration went silent passes only when it also says
   that sales resume on their own once the integration connects again.
4. After acting, will they see that it worked? "Your closure could not be
   confirmed" after closing an order leaves them unable to tell.

### 3. Ten heuristics, in this product's terms

Nielsen's ten, each a question to put to the screen; a failure is a finding
against its number.

1. The system says its state. Times are in the viewer's zone, with the zone
   named. Unknown reads differently from none: an unknown payment outcome is
   not "not paid", and a list that failed to load is not an empty list.
2. The merchant's own words. They sell goods, not "cards"; "your engineer" is
   wrong to a reader who may be the engineer, "New to Agentify?" to one whose
   session just ended. Protocol words appear only where the reader acts on
   them, and a rule not ours, like the seller name's limit, says whose it is.
3. A way back and a way on. Every state offers a next step. Search, filters and
   a list's page live in the address, so Back, reload and a shared link work.
4. The same thing drawn and named the same everywhere: one message panel with
   one frame, shadow and vertical placement, one status marker, one header with
   the same items in the same order, "Docs" everywhere and never "Documentation"
   on the next page. The channel is said once, in a band that stands out from
   the app, never per row.
5. Prevent errors rather than explain them. A limit shows when it hits, by
   disabling the action and saying when it frees up. A payout, which cannot be
   undone, shows amount, recipient and network before the press.
6. Recognition over recall. The menu marks the current section, nobody has to
   remember which account or channel they are in, and an order is found by the
   product and time a person remembers.
7. One main action per row. A row has one button; a rarely used action is a
   small icon beside its object, as an order identifier carries its copy icon.
8. Nothing without a job: a disclosure that opens onto one date, a plaque
   repeating the host and network the person is obviously on, a caption glued
   in to line up a column.
9. An error or banner says what happened, whether it fixes itself and what to
   do. "Your orders could not be loaded. Loading them changed nothing." answers
   only the first.
10. Explanation lives in the documentation, linked once. A working screen shows
    the result and the next action; a receipts page that teaches how to read a
    receipt is doing the documentation's job.

### 4. Made by a person, or generated

This part carries the most weight. A generator makes the choice that fits the
widest range of products; a designer makes one for this product and this
reader. The test that sums it up: could an unrelated product use this screen
unchanged? If it could, nobody decided anything about Agentify on it. Record
every sign; several on one screen are what make it read as generated.

Signs in the interface, each met on this product's screens:

- One kind of thing drawn several ways: message panels with and without a
  shadow, one pinned to the top of the window and another centred in it.
- Values from no scale: a box with its own tiny headings, or one summary line
  mixing a red word, a large digit and a brown word.
- Spacing left to chance: a different gap above a row of buttons than below it,
  a result line pressed under its button, line height changing between
  paragraphs, though the tokens name each of these gaps.
- Markers off their column: status dots placed after words of different
  widths, so they jump left and right down a list of checks.
- Boxes as the structure: a card in a card in a card, every block bordered and
  shadowed, a big number over a small label as the default way to show a count.
- A small label over every heading, so the label stops marking anything: the
  sell page puts one over each of its sections.
- Machine data as content: full identifiers and addresses as the main text,
  times to the second in UTC, internal state names as chips, Title Case names.
- Browser defaults left in place: a select's arrow pressed to its edge, money in
  proportional figures or aligned left instead of right in tabular figures.
- A phone layout that is the desktop squeezed: a table collapsed into stacks of
  label and value, an identifier broken mid-string, a link one word a line.

impeccable and the Vercel guidelines add signs not yet met on this product:
the monospaced face as a costume on prose (ours is for figures, identifiers and
captions), emoji for icons, a modal that interrupts for nothing, state in colour
alone, something that looks pressable and is not, navigation drawn as a button
that a middle click cannot open, gradient text and decorative glass.

Signs in the words. Run the humanizer skill (`.claude/skills/humanizer/SKILL.md`)
over every string for the general prose tells; these are specific to screens:

- Reassurance nobody asked for: "Nothing happens unless the button is pressed",
  "Nothing is lost", accepted orders that "play out as usual".
- One state chopped into short sentences that restate each other, like a
  sign-in failure saying three ways that it does not know if the email went out.
- A warning about a limit not yet reached ("these are the free links for the
  hour").
- Teaching what the screen shows: a receipt explaining that it shows the amount
  three times, a caption on how to read the chart above it.
- A hedge about the page as a whole, such as "This page does not show all of
  your money", which names no particular gap.
- A banner holding every case in one paragraph, so the reader must read all of
  it to find their part, and a note that hangs whatever the state, like a line
  about selling through WooCommerce on every Orders page.
- Internal names shown to people ("Price set", an enum value), and sentences
  too long for a reader whose first language is not English.
- From impeccable and Vercel, not yet met here: a button named for a gesture
  (Continue, OK) instead of its outcome, and an empty state that does not say
  whether nothing exists, a filter hides it or the read failed.

What the fifth gate in `AGENTS.md` asks a screen to say stays even when it costs
words: what is unknown, what was cut, what was guessed. Say it shorter and never
drop it. "Showing the newest 50 of 213" and "Payment outcome unknown" stay;
the hedge above goes because it names nothing. Check this before any cut.

### 5. Real data and real devices

- Data: the longest product and merchant names of a real catalogue (the lab
  shop's or a real merchant's), a long email, amounts in thousands with cents,
  a price in another currency, lists of 0, 1, 51 and 200 rows with more than 50
  unresolved. The gallery's examples are short; where data is missing, lengthen
  the text with the browser's script tool and label the screenshot as edited.
- Widths: 1440, 1024, 768 and 375 pixels, the last being the phone width the
  test plan's U stories use; tablet and phone are layouts of their own. The page never scrolls sideways; a wide table may, inside its box.
- Keyboard: every action reachable by Tab, the focus ring visible and never
  under a sticky header or banner, Enter submits, a disclosure opens.
- 200% zoom: everything readable, nothing cut off, no sideways page scroll.
- Hit targets of at least 24px, 44px on touch; our buttons are 48px and 36px.

### 6. Several reviewers

One evaluator finds a minority of the problems; Nielsen's studies put it near a
third (35 percent), with three to five independent evaluators finding most. A
review for acceptance uses three reviewers with no shared context: separate
sessions, each given this skill, the screens or path, the person and the goal,
and none of the others' notes. The orchestrator merges them. One screen,
element and criterion is one finding listing every reviewer who found it;
severity is settled by the rules below, not by vote, and a finding only one
reviewer saw is not weaker for it.

## A finding

Each finding gives the screen and state (address or gallery state name); the
width, with zoom or keyboard where they matter; the element, by its visible
words; the criterion it fails (first look, a walkthrough step and question, a
heuristic's number, a generated sign, real data); what a person would believe
or do because of it; the severity; and a screenshot the reviewer has looked at.
No finding stands without one, since a measurement, the DOM or the code shows
what is there and only the image shows what a person sees.

Severity follows "Reading the stories" in the test plan. P0 misleads about
money, goods, identity or privacy, or leads to an unsafe action or a lost
obligation. P1 blocks a task or comprehension. P2 is recoverable. A generated
look on its own is P2; when it causes a misreading it takes the severity of
what is misread. A one-line suggestion is welcome; the fix is the builder's.

## The report

Open with what was reviewed: screens and states, widths, commit, person and
goal. Then each screen's first look, believed beside true; the walkthrough step
by step; the findings by severity. End with what the review did not check:
states it could not reach, widths it skipped, data that stayed short, a screen
reader it did not use (the U stories ask for one on sign-in and key issuance),
and that no newcomer read these screens. Write in the language the task asks
for and quote the screen in its original English.

## Sources

- Jakob Nielsen, [10 usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
  and [The theory behind heuristic evaluations](https://www.nngroup.com/articles/how-to-conduct-a-heuristic-evaluation/theory-heuristic-evaluations/).
- Wharton, Rieman, Lewis and Polson, the cognitive walkthrough (1994), [summarised by NN/g](https://www.nngroup.com/articles/cognitive-walkthroughs/).
- [impeccable](https://github.com/pbakaus/impeccable) (Apache-2.0), its references
  `critique.md`, `craft-floor.md`, `clarify.md`, `layout.md` and `typeset.md`;
  the [Vercel web interface guidelines](https://github.com/vercel-labs/web-interface-guidelines).
- The humanizer skill in this repository, and the fifth gate in `AGENTS.md`.
