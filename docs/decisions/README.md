# Architecture Decision Records

One decision — one file, `NNNN-slug.md`. An ADR records a decision that is
expensive to reverse: a dependency in a published package's tree, a schema on
disk, a wire contract, a security boundary, what money means, and the custody
boundary that keeps Agentify from holding money or goods. Everything else —
screens, flows, internal mechanics, process topology, toolchain, release
procedure and operations — is a design note in `docs/research/`.

The ceiling is about sixty lines. Enough to reconstruct the reasoning, not to
exhaust the subject; measurements and their status live in research, linked.
Decisions are living documents until the first external merchant or a second
permanent participant: an accepted change is an edit to the file itself, and
the history lives in git.

Template:

```markdown
# NNNN. The decision, named as a sentence

Date: YYYY-MM-DD
Status: accepted | superseded by NNNN

## Context
Why the question arose, and the constraint that decides it.

## Decision
What is decided, in a couple of paragraphs.

## Consequences
What this buys and what it costs. Alternatives rejected, and why.
```

## Retired numbers

A number is never reused. When a decision is merged into another or moved into
research, its number is retired and listed here with where its content now
lives, so that a citation in git history, a commit message or a changelog
still leads somewhere. Before this list was kept, two numbers were given out a
second time: 0004 first named the failure policy of a silent price hook, which
stands in ADR-0002 §3, and 0023 first named a self-service test purchase that
was reverted.

- 0001 (the pilot is exposed on the x402 Bazaar through the CDP facilitator):
  the closing section of `docs/research/04-spike-bazaar-listing.md`; what is
  expensive to reverse stands in ADR-0012, ADR-0019 and ADR-0020.
- 0007 (the confirmation mode's seam):
  `docs/research/40-confirmation-mode-seam.md`.
- 0008 (the sandbox facilitator): ADR-0020.
- 0009 (signing in to the dashboard): ADR-0026.
- 0015 (mail and confirming an address): ADR-0026.
- 0021 (what a payment challenge says):
  `docs/research/25-what-the-challenge-says.md`.
- 0022 (one answer envelope): ADR-0018.
- 0024 (the scanner's identity without Supabase): ADR-0026.
- 0025 (the Agentify namespace): a finished rename; its schema URN rule stands
  in ADR-0006 §4, and the names it fixed live in `deploy/README.md`.
- 0030 (the gateway and the dashboard are one process):
  `docs/research/35-one-process.md`.
