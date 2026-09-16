# Publishing the merchant SDK

Status: the Agentify package names are prepared but unpublished. SDK
publication is paused by ADR-0016. None of the bootstrap, tag or workflow steps
below is authorized merely because this document or a release commit exists.

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

The pending Changesets prepare contracts `0.3.2` and SDK `0.2.4`; do not reuse
the existing `sdk-v0.2.3` tag. The package-name move does not change the wire,
so `CONTRACT_VERSION` remains `"2"` and the generated JSON Schemas remain the
same bytes.

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
publish the contracts tarball before the SDK tarball:

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
