# 0016. Two isolated release channels

Date: 2026-08-28
Status: accepted (Dmitry's live word, updated 2026-09-23)

## Context

Test and production need isolated configuration, credentials and data. The
servers have outbound HTTPS access to the public repository, while a
GitHub-hosted runner has no stable private route to either server.

## Decision

The same root-owned pull agent runs independently on TEST and PRODUCTION. It
polls one fixed mutable tag over outbound HTTPS, releases the exact commit that
tag names, and accepts no repository URL, branch, tag or channel from the
network or from a command argument. It needs no GitHub credential, and GitHub
holds no server SSH key, host inventory, Headscale credential or runtime
secret. A channel is one Compose project with one environment file.

Moving `deploy-test`, directly or through the manual GitHub workflow that
resolves a branch, tag or SHA, selects any repository commit for TEST, with no
main-ancestry or CI requirement. Candidate workflow code cannot replace the
release controller, which always comes from public `main`.

PRODUCTION keeps the immutable `app-v*` acceptance tag. Its GitHub workflow
requires the tagged commit to belong to public `main` history and waits for
successful `main` runs of CI and of the image build for that exact SHA before it
moves the internal `deploy-production` pointer. The production agent
independently requires an `app-v*` tag, successful main CI, main ancestry and a
forward-only move. Operators do not move `deploy-production` directly, and doing
so bypasses none of these server gates.

GitHub Actions builds the five first-party images once per pushed branch head
and pushes them to the GitHub Container Registry as public packages,
`ghcr.io/nuanu-ai/agentify-<name>:<full SHA>` (`.github/workflows/images.yml`).
Any later push can move a registry tag, so production will release only by the
digests main's own push run of that workflow published: one notice on its
`digests` job, which the public API serves without a token, read by the rule
the workflow's header states. That rule trusts `main`, and what protects `main`
is the repository's rules.

The same `app-v*` tag publishes the public npm packages through npm Trusted
Publishing, behind the same main-ancestry and CI checks. There is no separate
SDK tag, so every SDK release is a release of the application it was tested
with, and SDK publication grants no host-delivery authority.

GitHub checks the candidate's reachable Git history for secrets before CI
tests, image publication, channel selection or SDK publication. A detected
secret or an unavailable scanner fails closed. Existing fixture findings are
suppressed by exact historical fingerprints, so a new finding at the same path
still stops delivery.

## Alternatives rejected

- Each server building from source spent most of a release on it (4 min 40 s
  of 7 on TEST, `docs/research/00-open-questions.md`) and gave each channel its
  own bytes for the same commit.
- Commit statuses: a newer one, from any branch's workflow, replaces main's.
- A workflow artifact: downloading one needs a token.
- A registry tag holding the digests: any later push can move it.
- A release asset: it needs a release for every commit.
- Signed build provenance, GitHub artifact attestations checked against
  `images.yml@refs/heads/main`: every host would need a verifier that reaches
  the transparency log, where the notice needs a few plain HTTP reads.
- Inbound SSH for GitHub-hosted runners adds an expiring Headscale credential.
- A webhook listener creates a new public authenticated surface.
- Public pull-request code on internal runners would cross the release boundary.
- A separate `sdk-v*` tag let the SDK ship from a revision production never
  accepted.
