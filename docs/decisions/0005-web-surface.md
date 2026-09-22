# 0005. The web surface: one origin, server-rendered pages, no client build

Date: 2026-08-27
Status: accepted (autonomous mandate of 2026-08-26; revisited on Dmitry's word)

## Context

The pilot needs something a merchant's engineer can be shown and can click
through: a landing that says what this is, the documentation portal that
already exists, and the merchant cabinet the pilot plan calls for — cards with
a working pause, orders, receipts. Dmitry's instruction of 2026-08-27 is to get
that chain running locally first, in Docker, and only then to put it on a
server.

Until now the repository has had no human-facing surface at all. The gateway
serves the contract's route table to machines; the portal is a separate
VitePress project. Adding a cabinet is the first time this project renders a
page for a person, so the shape of that is a decision rather than a detail.

## Decision

1. **One origin locally.** Caddy, in Docker, is the only door: `/` is the
   landing, `/docs` the portal, `/cabinet` the cabinet, `/v0/*` the merchant's
   API and `/x402/*` the storefront an agent buys at — both of them the gateway
   — and `/healthz` the gateway's own probe. A merchant's engineer sees one
   address and never reasons about ports. The same file describes the server
   later, so what is demonstrated locally is what gets deployed.

   Both deployed channels have the same application routing (Dmitry,
   2026-09-17): production at `agentify.ad`, test at `test.agentify.ad`. The scanner's application answers `/` and its own paths in
   place of the static landing; `/cabinet`, `/docs`, `/v0`, `/x402` and
   `/healthz` go to the commerce stack by path, as below, and nothing the
   scanner serves shares a prefix with them. `app.agentify.ad` retires. The
   resource address in every challenge and every listing is pinned from the
   public origin (ADR-0012), so the move is one value, one re-listing and a
   documentation release of the SDK, which chooses no address itself and names
   the old one only in its README and in one error. The test channel has isolated data, secrets and the test payment network.
   Its scanner front page and commerce paths match production. A shared origin
   also shares browser-script authority: cookie paths separate session handling,
   not protection against script injection in another surface. Scanner content
   must remain escaped; a second origin is the alternative if script isolation
   becomes a requirement. Cheapest before the first external merchant, which is why it is
   not deferred.

   `/healthz` is the last path and the only one that is not a surface anybody
   integrates against. Whether the door is open has to be answerable from
   outside it, and this endpoint reports only the gateway's own readiness. It sits
   outside both of the gateway's prefixes because those are the contract, and an
   operational probe is not part of what a merchant's code calls. It answers for
   the gateway
   alone: not for the cabinet, which reports itself at `/cabinet/healthz`, and
   not for Postgres. There is deliberately no aggregate health document — a
   single verdict over several services is read as one and is wrong the first
   time one of them goes down by itself.

2. **The cabinet is its own process (`apps/cabinet`), not a part of the
   gateway.** The gateway is the money path: a resident process whose surface
   is the contract's route table, mounted in one generic loop. Pages for people
   change for reasons that have nothing to do with money, and mixing the two
   audiences in one process puts that churn on the payment path.

3. **The cabinet reaches the gateway through the public API with a merchant
   key** — the same door a merchant's own tooling uses. It holds no database
   connection of its own. This is deliberate dogfooding: if the cabinet cannot
   show something, the API is missing it, and the merchant would have hit the
   same wall.

   Narrowed by ADR-0009: the cabinet owns two tables of its own, accounts and
   sessions, which are the people who sign into it and hold nothing about a
   merchant's data. Everything on every screen still comes from the public API,
   and no query in the cabinet can reach the gateway's tables — that is the
   part of this section the dogfooding argument is about, and it is unchanged.

4. **Server-rendered HTML, no client-side framework and no client build step.**
   The cabinet v0 shows three lists and offers one real action. A single-page
   application would add a build pipeline, a dependency tree and a second
   surface to keep in step, for nothing the pilot needs. Pages are rendered on
   the server and tested with the same HTTP harness the gateway's routes are.
   Interactivity that earns its place is plain form posts and small inline
   scripts; anything more is a decision to be recorded, not a habit to drift
   into.

5. **There is one front page and it is the scanner's** — on a laptop and in
   both deployed channels, selected by the same name in the same route table.
   A second static page stood in for it locally while the scanner was a
   separate stack to bring up; it is deleted, because a fixture that renders
   what the product does not is a page nobody keeps true. The scanner is a
   Next.js application by inheritance (ADR-0024)
   and is not the cabinet, so §4 stands for the cabinet as written.

6. **One visual language, held in `packages/visual/tokens.css`.** One file
   carries the colour, the type, the radius and the border weight, the base
   element rules that follow from them, and the few primitives every surface
   draws — the page width, the button, the focus ring, the lockup. It
   covers the scanner, the cabinet, the documentation portal and the static
   landing that is the local fixture. Nothing serves it over HTTP on the
   deployed origin, because the shared-asset route names each path and this is
   not one of them; every reader takes it at build time or off disk instead.
   The portal is the one exception and copies its eight colours, because it is
   a separate project with its own lockfile; a test reads both files and fails
   the suite when a value stops matching.

   The language is **light**, with no dark set and no theme switch. The page a
   merchant lands on is the scanner's, which has never had one; what a dark
   set would cost is in the rejected alternatives. The corners are a
   scale of four rather than one value: a control is 12px, a card 14px, a panel
   20px, and a pill is a pill. One radius described nothing, and every surface
   that had one broke it within a few rules.

7. **The whole chain runs from one command locally** (`docker compose up`),
   including Postgres, and that is the state Dmitry inspects before anything
   goes to a server.

## Consequences

- Gained: a chain a person can click through end to end; the cabinet proves
  the API is usable by construction; no build step to keep green; the local
  arrangement is the deployment rehearsal.
- Paid: server-rendered pages make rich interactivity awkward, and the day a
  screen genuinely needs it, that screen argues for a client framework on its
  own merits — a named trigger, not a slide.
- The cabinet needs API surface the contract does not yet carry: a merchant's
  own cards, a pause and its release, and receipts. Those are contract
  additions with the ordinary ceremony, not cabinet-private endpoints.

## Rejected alternatives

- **The cabinet inside the gateway** — fewer processes, but it mixes the
  machine contract with human pages and puts UI churn on the money path.
- **A single-page application (React or similar)** — a build pipeline and a
  dependency tree bought before any screen needs them. The trigger to revisit
  is named above.
- **The cabinet talking to Postgres directly** — faster to write, and it would
  have hidden exactly the API gaps this cabinet exists to expose.
- **A dark theme across the origin** — three of the four surfaces had one and
  the scanner did not, so a merchant whose machine is dark crossed from a paper
  front page into a dark cabinet. Closing that by giving the scanner a dark set
  meant inventing twenty-two colours and redesigning a footer that is a dark
  band on a light page; dropping it was a few hundred lines deleted. The cost
  is real: readers of technical documentation expect the portal to have one,
  and the way back is to do the expensive half.
- **The portal keeps its dark set while the scanner and the cabinet stay
  light** — nothing to build, and it leaves one address with two behaviours:
  a reader who crosses from the documentation into the cabinet changes
  palette at the click, which is the seam this section exists to close. If
  the portal's readers turn out to miss it, the way back is the expensive
  half above, not a switch on one surface of three.
