#!/usr/bin/env bash
#
# Resolve the npm versions one application release tag would publish.
#
# The tag is `app-v<release>`, the acceptance that puts a revision on
# production (ADR-0016). The SDK and contracts versions are the ones the
# manifests carry — the number in the tag is the application's and says
# nothing about them — and Changesets publishes only what the registry does
# not hold yet, so a tag whose versions are already public publishes nothing.
#
# The workflow appends this command's stdout to GITHUB_OUTPUT, so stdout is a
# deliberately tiny machine contract. Explanations and refusals go to stderr.

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tag="${1:-}"

if [ -z "$tag" ]; then
  echo "usage: check-sdk-release-tag.sh app-v<release>" >&2
  exit 2
fi

if [[ ! "$tag" =~ ^app-v[0-9A-Za-z._-]+$ ]]; then
  echo "release tag $tag must be an app-v<release> acceptance tag; the SDK version comes from its manifest, not from the tag" >&2
  exit 1
fi

sdk_version="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$repo/packages/sdk/package.json")"
contracts_version="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$repo/packages/contracts/package.json")"

shopt -s nullglob
publishable=()
for manifest in "$repo"/{packages,apps}/*/package.json; do
  package_name="$(
    node -e '
      const manifest = require(process.argv[1]);
      if (!manifest.private) process.stdout.write(manifest.name ?? "");
    ' "$manifest"
  )"
  if [ -n "$package_name" ]; then
    publishable+=("$package_name")
  fi
done

IFS=$'\n' read -r -d '' -a publishable < <(printf '%s\n' "${publishable[@]}" | sort && printf '\0')
expected_publishable=("@nuanu-ai/agentify" "@nuanu-ai/agentify-contracts")
if [[ "${publishable[*]}" != "${expected_publishable[*]}" ]]; then
  printf 'SDK release may publish only: %s\nFound: %s\n' \
    "${expected_publishable[*]}" "${publishable[*]:-(none)}" >&2
  exit 1
fi

valid_version='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
if [[ ! "$sdk_version" =~ $valid_version ]]; then
  echo "SDK version $sdk_version is not a stable semantic version" >&2
  exit 1
fi
if [[ ! "$contracts_version" =~ $valid_version ]]; then
  echo "contracts version $contracts_version is not a stable semantic version" >&2
  exit 1
fi
if [ "$sdk_version" = "0.0.0" ] || [ "$contracts_version" = "0.0.0" ]; then
  echo "0.0.0 is not publishable; prepare the Changesets release before tagging" >&2
  exit 1
fi

printf 'sdk_version=%s\ncontracts_version=%s\ndist_tag=%s\n' \
  "$sdk_version" "$contracts_version" "latest"
