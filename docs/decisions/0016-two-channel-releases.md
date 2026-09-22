# 0016. Two isolated release channels

Date: 2026-08-28
Status: accepted (Dmitry's live word, updated 2026-09-22)

## Context

Test and production need isolated configuration, credentials and data. The pilot
does not need a registry publication and immutable-image promotion pipeline.
The servers have outbound HTTPS access to the public repository, while a
GitHub-hosted runner has no stable private route to either server.

## Decision

The same root-owned pull agent runs independently on TEST and PRODUCTION. It
polls one fixed mutable tag over outbound HTTPS, fetches an exact source commit,
then runs the existing Ansible stage, activation and verification phases
locally. It accepts no repository URL, branch, tag or channel from the network
or from a command argument.

Moving `deploy-test` selects any repository commit for TEST. The manual GitHub
workflow is a convenience that resolves a branch, tag or SHA and moves that
pointer; moving the pointer directly has the same meaning. TEST does not require
main ancestry or prior CI. Candidate workflow code cannot replace the release
controller, which always comes from public `main`.

PRODUCTION keeps the immutable `app-v*` acceptance tag. Its GitHub workflow
requires the tagged commit to belong to public `main` history and requires green
CI for that exact SHA before it moves the internal `deploy-production` pointer.
The production agent independently requires an `app-v*` tag and successful main
CI for the exact SHA. It executes release mechanics from that accepted SHA, not
from a later `main`, and retains the main-ancestry and forward-only checks before
staging and immediately before activation. Operators do not move
`deploy-production` directly, and doing so bypasses none of these server gates.

The agent records `deploying`, `activating`, `failed` or `verified` state and an
append-only local history. A verified SHA is a no-op. A failed or uncertain SHA
is not retried automatically; an operator must inspect its retained evidence and
move the channel tag to make a new selection. An absent tag leaves the running
revision unchanged. There is no automatic rollback after a migration begins.

GitHub holds no server SSH key, host inventory, Headscale credential or runtime
secret. A one-time operator-controlled bootstrap installs the agent and its
channel-local inventory. The agent needs no GitHub credential because it reads a
public repository. GitHub Actions publishes intent and ends; runtime evidence
and failure details remain on the assigned server.

One Ansible procedure builds each selected commit on its assigned server from
the repository Dockerfiles and frozen lockfile. Each host records image IDs and
verifies source-revision labels. Separate builds are not claimed to have
identical bytes. Production credentials and data never cross into TEST.

The same `app-v*` tag publishes the public npm packages. The publish workflow,
behind the same main-ancestry and CI checks, releases whatever SDK and
contracts versions the tagged manifests carry and the registry does not hold,
through npm Trusted Publishing over GitHub Actions OIDC; a tag whose versions
are already public publishes nothing. There is no separate SDK tag, so every
SDK release is a release of the application it was tested with. SDK publication
grants no host-delivery authority.

## Alternatives rejected

Giving GitHub-hosted runners inbound SSH over Headscale adds an expiring mesh
credential and a route solely for deployment. A webhook listener creates a new
public authenticated surface. Building once and promoting registry digests gives
stronger artifact identity, but its publication and manifest machinery is not
needed for this pilot. Running public pull-request code on internal runners
would cross the release boundary. A separate `sdk-v*` tag let the SDK be
published from a revision never accepted for production and gave a reader two
tag rows to tell apart.
