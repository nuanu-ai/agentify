# 0016. Two isolated release channels

Date: 2026-08-28
Status: accepted (the product owner's live word, updated 2026-09-24)

## Context

Test and production need isolated configuration, credentials and data, and
what can reach production and npm decides whose money and whose installs a
change can touch. The servers have outbound HTTPS access to the public
repository, while a GitHub-hosted runner has no stable private route to either
server.

## Decision

The hosts pull, and nothing pushes to them. A release is one command on the
host, `agentify-release`, the same on both channels, which takes its channel
from the host's root-owned configuration, resolves a name against the public
repository and runs that commit's activation with its images pinned by
digest. It needs no GitHub credential, and GitHub holds no host credential or
secret: a channel's configuration and secrets are one root-owned environment
file on its host. GitHub Actions builds the images once per pushed branch head,
pushes them to the GitHub Container Registry as public packages and publishes
their digests in one notice. A host reads it by the rule in the header of
`.github/workflows/images.yml`, which wants exactly one annotation titled
`images`, so one a branch adds refuses the release instead of replacing the
digests. A host builds nothing and pulls nothing by tag, because any later push
can move a registry tag. How a release runs, waits, fails and is restored is
`deploy/README.md`.

A PRODUCTION release is an `app-v*` tag, which only repository administrators
can create. The tag publishes the SDK and the contracts to npm through Trusted
Publishing as soon as it is pushed, behind the same main-ancestry and CI
checks. Production takes the tagged revision only when a person with access to
the nuanu mesh runs the release on the host, never by a timer, since a
production release stops the applications and migrates the live database. The
command refuses it unless the build was a push to `main`, `main`'s CI run for
the commit succeeded and the commit moves forward from the revision the host
runs. So npm can hold a version production does not run, for a while or at
all: a merchant's contract is the published package and its documentation,
not the revision production runs, and every published version is still one
revision `main` reviewed and an administrator tagged.

A TEST release is the `deploy-test` tag, which a timer on the test host
follows. It takes any commit with exactly one successful image build, and
activation comes from the candidate itself, so whoever can push a branch here
can run that commit's activation as root on the test host.

The GitHub workflows check the candidate's reachable Git history for secrets
before CI tests, image publication, channel selection or SDK publication, and
stop on a finding or an unavailable scanner; old fixture findings are
suppressed by exact fingerprints.

## Alternatives rejected

- Ansible on each host, building from source: slower, other bytes on each
  channel, recovery by hand (measured in `docs/research/52-release-delivery.md`,
  which also says why the digests travel as they do).
- Pushing to hosts from GitHub: a mesh credential or a public listener, and
  pull-request code on internal runners would cross the release boundary.
- A separate `sdk-v*` tag: a published version could come from a revision no
  `app-v*` tag accepted as the whole product that production can take.
