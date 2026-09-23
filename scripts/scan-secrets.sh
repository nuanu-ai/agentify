#!/usr/bin/env bash
set -euo pipefail

source_dir="${1:-.}"
revision="${2:-HEAD}"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$(cd "$source_dir" && pwd)"

if [ "$(git -C "$source_dir" rev-parse --is-shallow-repository)" != false ]; then
  echo 'Secret scan needs the full Git history (checkout with fetch-depth: 0)' >&2
  exit 1
fi
revision="$(git -C "$source_dir" rev-parse --verify "${revision}^{commit}")"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    asset=gitleaks_8.30.1_linux_x64.tar.gz
    checksum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
    ;;
  Darwin-arm64)
    asset=gitleaks_8.30.1_darwin_arm64.tar.gz
    checksum=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5
    ;;
  *)
    echo 'Secret scan has no verified Gitleaks binary for this platform' >&2
    exit 1
    ;;
esac

temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
curl --fail --silent --show-error --location --retry 3 \
  "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/$asset" \
  --output "$temp_dir/$asset"
printf '%s  %s\n' "$checksum" "$temp_dir/$asset" | shasum -a 256 --check
tar -xzf "$temp_dir/$asset" -C "$temp_dir" gitleaks

# The candidate's own config must not be able to turn off the standard rules.
printf '[extend]\nuseDefault = true\n' > "$temp_dir/default.toml"
"$temp_dir/gitleaks" git --no-banner --redact \
  --config "$temp_dir/default.toml" \
  --gitleaks-ignore-path "$repo_dir/.gitleaksignore" \
  --log-opts="--full-history --diff-merges=first-parent $revision" "$source_dir"
