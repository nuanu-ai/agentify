# 0016. Two isolated release channels

Date: 2026-08-28
Status: accepted (Dmitry's live word, updated 2026-09-23)

## Context

Test and production need isolated configuration, credentials and data. The
servers have outbound HTTPS access to the public repository, while a
GitHub-hosted runner has no stable private route to either server.

## Decision

A release is one command on the host, `agentify-release <name>`, the same
program on both channels, which takes its channel from the host's root-owned
configuration. It resolves the name with `git ls-remote` against the public
repository, reads the five image digests the commit's image build published,
fetches the commit and runs that commit's `deploy/activate.sh` with the images
pinned by digest. It needs no GitHub credential, and GitHub holds no server
SSH key, host inventory, mesh credential or runtime secret. A channel is one
Compose project with one environment file.

GitHub Actions builds the five first-party images once per pushed branch head
and pushes them to the GitHub Container Registry as public packages; its
`digests` job publishes their digests as one notice, which the public API
serves without a token (`.github/workflows/images.yml`, whose header states
the rule a reader follows: exactly one successful push run for the commit,
every page of its annotations counted against their count, exactly one
notice). A host builds nothing and pulls nothing by tag, because any later
push can move a registry tag.

A PRODUCTION release is an `app-v*` tag, which only repository administrators
can create, and then `agentify-release app-v<release>` run on the host by a
person with access to the nuanu mesh. The command adds its conditions to the
one path: the name is an `app-v*` tag, the image build is a push to `main`,
`main`'s CI run for the commit succeeded, and the commit moves forward from
the revision the host runs. That rule trusts `main`, which the repository's
rules protect. The same tag publishes the public npm packages through npm
Trusted Publishing behind the same main-ancestry and CI checks, so every SDK
release is a release of the application it was tested with.

A TEST release is the `deploy-test` tag, moved directly or through the manual
workflow that resolves a branch, tag or SHA; a timer on the test host runs
`agentify-release --timer deploy-test` once a minute. It takes any commit
whose image build succeeded, skips what already runs or already failed, and
waits while the images are being built. Activation comes from the candidate
itself, so whoever can push a branch here can run that commit's activation as
root on the test host.

The GitHub workflows check the candidate's reachable Git history for secrets
before CI tests, image publication, workflow-driven channel selection or SDK
publication. A detected secret or an unavailable scanner stops that workflow.
Existing fixture findings are suppressed by exact historical fingerprints, so
a new finding at the same path is still reported.

## Alternatives rejected

- Ansible on each host, building from source and activating with mechanics
  taken from `main`: about 2,500 lines; seven minutes a release on TEST, 4 min
  40 s of it building images (`docs/research/00-open-questions.md`), each
  channel with its own bytes; recovery by hand edits of state files; a lock
  that outlived a killed run; five attempts at the first merged TEST release.
- A timer on PRODUCTION as on TEST, polling a production pointer tag:
  Dmitry chose on 2026-09-23 that a person starts a production release, which
  stops the applications and migrates the live database.
- Commit statuses: a newer one, from any branch's workflow, replaces main's.
- A workflow artifact: downloading one needs a token.
- A registry tag holding the digests: any later push can move it.
- A release asset: it needs a release for every commit.
- Signed build provenance checked against `images.yml@refs/heads/main`: every
  host would need a verifier that reaches the transparency log, where the
  notice needs a few plain HTTP reads.
- Inbound SSH for GitHub-hosted runners adds an expiring mesh credential.
- A webhook listener creates a new public authenticated surface.
- Public pull-request code on internal runners would cross the release boundary.
- A separate `sdk-v*` tag let the SDK ship from a revision production never
  accepted.
