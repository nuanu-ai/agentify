# 0016. Two isolated release channels

Date: 2026-08-28
Status: accepted (Dmitry's live word, updated 2026-09-24)

## Context

Test and production need isolated configuration, credentials and data. The
servers have outbound HTTPS access to the public repository, while a
GitHub-hosted runner has no stable private route to either server.

## Decision

A release is one command on the host, `agentify-release <name>`, the same on
both channels, which takes its channel from the host's root-owned
configuration. It resolves the name against the public repository, reads the
five image digests the commit's image build published, and runs that
commit's `deploy/activate.sh` with the images pinned by digest. It needs no
GitHub credential, and GitHub holds no host credential or secret. A channel is
one Compose project, whose configuration and secrets are one environment file.
A database is restored only when a person runs `agentify-release --restore`;
no failure restores one by itself.

GitHub Actions builds the five images once per pushed branch head, pushes them
to the GitHub Container Registry as public packages, and publishes their
digests as one notice the public API serves without a token, read by the rule
in the header of `.github/workflows/images.yml`. A host builds nothing and
pulls nothing by tag, because any later push can move a registry tag.

A PRODUCTION release is an `app-v*` tag, which only repository administrators
can create. The tag publishes the SDK and the contracts to npm through Trusted
Publishing as soon as it is pushed, behind the same main-ancestry and CI
checks. Production takes the tagged revision only when a person with access to
the nuanu mesh runs `agentify-release app-v<release>` on the host, never by a
timer, since a production release stops the applications and migrates the
live database. The command refuses it unless the build was a push to `main`,
`main`'s CI run for the commit succeeded and the commit moves forward from the
revision the host runs. So npm can hold a version production does not run, for
a while or at all: a merchant's contract is the published package and its
documentation, not the revision production runs, and every published version
is still one revision `main` reviewed and an administrator tagged.

A TEST release is the `deploy-test` tag, moved directly or through the manual
workflow; a timer on the test host runs `agentify-release --timer deploy-test`
once a minute. It takes any commit with exactly one successful image build,
skips what already runs or already failed, and waits while a build is not yet
listed or still running. Activation comes from the candidate itself, so
whoever can push a branch here can run that commit's activation as root on
the test host.

The GitHub workflows check the candidate's reachable Git history for secrets
before CI tests, image publication, channel selection or SDK publication, and
stop on a finding or an unavailable scanner; old fixture findings are
suppressed by exact fingerprints.

## Alternatives rejected

- Ansible on each host, building from source: slower, other bytes on each
  channel, recovery by hand (measured in `docs/research/00-open-questions.md`).
- Other carriers for the digests: each fails for a reason in the same note.
- Pushing to hosts from GitHub: a mesh credential or a public listener, and
  pull-request code on internal runners would cross the release boundary.
- A separate `sdk-v*` tag: a published version could come from a revision no
  `app-v*` tag accepted as the whole product that production can take.
