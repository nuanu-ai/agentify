# 0016. Two isolated release channels

Date: 2026-08-28
Status: accepted (Dmitry's live word, updated 2026-09-23)

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

GitHub Actions builds the five images once per pushed branch head, pushes them
to the GitHub Container Registry as public packages, and publishes their
digests as one notice the public API serves without a token, read by the rule
in the header of `.github/workflows/images.yml`. A host builds nothing and
pulls nothing by tag, because any later push can move a registry tag.

A PRODUCTION release is an `app-v*` tag, which only repository administrators
can create, and then `agentify-release app-v<release>` run on the host by a
person with access to the nuanu mesh. The command adds its conditions to the
one path: the build was a push to `main`, `main`'s CI run for the commit
succeeded, and the commit moves forward from the revision the host runs. That
rule trusts `main`, which the repository's rules protect. The same tag
publishes the SDK and the contracts to npm through Trusted Publishing, behind
the same main-ancestry and CI checks, as soon as it is pushed; production
gets the same revision when a person runs the command, which the runbook puts
right after the tag.

A TEST release is the `deploy-test` tag, moved directly or through the manual
workflow; a timer on the test host runs `agentify-release --timer deploy-test`
once a minute. It takes any commit with exactly one successful image build,
skips what already runs or already failed, and waits while a build is not yet
listed or still running. Activation comes from the candidate itself, so
whoever can push a branch here can run that commit's activation as root on
the test host.

The GitHub workflows check the candidate's reachable Git history for secrets
before CI tests, image publication, workflow-driven channel selection or SDK
publication. A detected secret or an unavailable scanner stops that workflow.
Existing fixture findings are suppressed by exact historical fingerprints, so
a new finding at the same path is still reported.

## Alternatives rejected

- Ansible on each host, building from source: slower, other bytes on each
  channel, recovery by hand (measured in `docs/research/00-open-questions.md`).
- A timer on PRODUCTION as on TEST: a production release stops the
  applications and migrates the live database, so a person starts it.
- Other carriers for the digests — commit statuses, an artifact, a registry
  tag, a release asset, signed provenance — each fail for a reason recorded in
  the same note.
- Pushing to hosts from GitHub: inbound SSH adds an expiring mesh credential,
  a webhook listener a public authenticated surface, and pull-request code on
  internal runners would cross the release boundary.
- A separate `sdk-v*` tag let the SDK ship from a revision production never
  accepted.
