# Publishing the merchant SDK

Status: contracts `0.3.2` and SDK `0.2.5` are published, and `latest` points at
both. The bootstrap release, SDK `0.2.4`, was verified against the retained
tarball digests, with a successful external install and CLI check.
Every version under the former package names is deprecated with a replacement
message; registry history remains available. Both Agentify packages trust
`nuanu-ai/agentify` and `publish-sdk.yml` for GitHub Actions publishing. Dmitry
authorized enabling that workflow on 2026-09-16, as recorded in ADR-0016.
Test and production host delivery are outside this release, and the namespace
cutover remains paused.

The tag `sdk-v<version>` publishes two public npm packages from one immutable
commit:

- `@nuanu-ai/agentify-contracts`, because every SDK install resolves it at runtime;
- `@nuanu-ai/agentify`, whose version must be the version written in the tag.

The workflow is `.github/workflows/publish-sdk.yml`. It runs on a GitHub-hosted
runner, accepts GitHub's OIDC token through `id-token: write`, and publishes
public provenance. It carries no npm credential.

## Prepare a release

Every public change has a Changeset. Prepare the versions on `main`, review the
generated changelogs and run the same gates the tag will run:

```sh
pnpm changeset version
pnpm check
pnpm typecheck
pnpm test
pnpm build
pnpm outside
```

`pnpm outside` needs the public npm registry but no registry credential. It
packs both packages, installs them with npm outside the workspace, compiles a
strict TypeScript consumer, imports the SDK with Node, and runs the documented
command with positive and negative cards.

The bootstrap release is contracts `0.3.2` and SDK `0.2.4`; subsequent releases
require new versions and a new tag. The package-name move does not change the wire, so
`CONTRACT_VERSION` remains `"2"`. Schema identities use
`urn:agentify:contract:2:*`; schema bodies and payload validation are unchanged.
Consumers keyed to the previous schema identities must switch directly; no
alias schemas are published. See [ADR-0025](../decisions/0025-agentify-namespace.md).

Commit and push the prepared version, then wait for the `CI` workflow to pass
on that exact commit. Before making the tag, run the publish workflow manually
on `main` with `release_tag=sdk-v0.2.4` and `dry_run=true`. For SDK `0.2.4`,
the normal release after the package names have been bootstrapped starts with:

```sh
git tag sdk-v0.2.4
git push origin sdk-v0.2.4
```

For the first registry release, use the bootstrap sequence below instead; it
keeps the tag local until both package names and their trusted publishers
exist.

The workflow refuses a tag whose version differs from the SDK manifest, a tag
whose commit is not the commit being built, and a tagged commit that is not
reachable from `origin/main`. It also waits for the `CI` workflow to succeed
for that exact commit. Stage 0 publishes stable versions only and assigns them
npm dist-tag `latest`; prereleases are refused instead of deriving another
public channel from an unchecked name.

## Bootstrap the two package names once

npm can attach a trusted publisher only after a package name exists. The first
release therefore needs one authenticated publication from the exact commit
after its CI has succeeded. Use an npm account that owns the
`nuanu-ai` organization and requires 2FA. Create the release tag locally but do
not push it yet and check that it names `HEAD`. Pack with pnpm so
`publishConfig` and `workspace:*` become registry-ready manifests; publishing a
package directory with raw npm would publish the source manifest instead. Then
publish the contracts tarball before the SDK tarball. This one-time sequence is
authorized only for the exact versions named above:

```sh
git tag sdk-v0.2.4
test "$(git rev-parse 'sdk-v0.2.4^{commit}')" = "$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
./scripts/check-sdk-release-tag.sh sdk-v0.2.4
release_dir="$(mktemp -d)"
pnpm --filter @nuanu-ai/agentify-contracts exec pnpm pack --pack-destination "$release_dir"
pnpm --filter @nuanu-ai/agentify exec pnpm pack --pack-destination "$release_dir"
npm publish "$release_dir/nuanu-ai-agentify-contracts-0.3.2.tgz" --access public --tag latest
npm publish "$release_dir/nuanu-ai-agentify-0.2.4.tgz" --access public --tag latest
```

Keep those exact pnpm-packed tarballs until bootstrap acceptance is complete.
Before publishing, record the npm-compatible SHA-1 shasum and SHA-512 SRI
integrity of each tarball's bytes. After each exact version becomes readable
from the registry, compare those recorded values with its `dist.shasum` and
`dist.integrity`:

```sh
npm view @nuanu-ai/agentify-contracts@0.3.2 dist.shasum dist.integrity
npm view @nuanu-ai/agentify@0.2.4 dist.shasum dist.integrity
```

Both pairs must match before installing the exact registry versions in a fresh
directory. A clean external install and import then prove that the matching
bytes are usable. The first tag workflow performs its own exact-version
registry install, but it does not replace this bootstrap digest comparison.

Do not save a token in the repository or GitHub. An interactive `npm login`
session or another short-lived authenticated session is enough for this
one-time command.

After both names exist, npm 11.15 or newer can configure the same trusted
publisher on each package:

```sh
npm trust github @nuanu-ai/agentify-contracts --repo nuanu-ai/agentify --file publish-sdk.yml --allow-publish --yes
npm trust github @nuanu-ai/agentify --repo nuanu-ai/agentify --file publish-sdk.yml --allow-publish --yes
npm trust list @nuanu-ai/agentify-contracts
npm trust list @nuanu-ai/agentify
git push origin sdk-v0.2.4
```

Because bootstrap already published contracts `0.3.2` and SDK `0.2.4`, that
first tag run validates the registry artifacts but its Changesets publish is a
no-op; it does not itself exercise OIDC. The authenticated `npm trust list`
reads above are therefore part of bootstrap acceptance. The next new version
is the first registry write performed by the trusted publisher.

The equivalent npm website settings are:

- provider: GitHub Actions;
- repository: `nuanu-ai/agentify`;
- workflow file: `publish-sdk.yml`;
- allowed action: `npm publish`.

Then set package publishing access to require 2FA and disallow ordinary tokens.
Every later `sdk-v*` tag publishes through OIDC on a GitHub-hosted runner
without an npm secret.

## Acceptance

A green workflow is not registry evidence. The last workflow step reads the
exact contracts and SDK versions back from npm, confirms that `latest` points
at both versions, then installs and imports those exact registry artifacts in
a fresh directory. An HTTP 200 from npm or a green build alone does not prove
that a merchant can import the release.

For the one-time bootstrap, acceptance also includes the recorded tarball
shasum and integrity comparisons above before the fresh registry install.

Only after that acceptance passes, deprecate every released version under the
former package names with a message that directs installers to
`@nuanu-ai/agentify-contracts` and `@nuanu-ai/agentify`. Do not unpublish them:
existing lockfiles must keep resolving to the immutable artifacts they named.
