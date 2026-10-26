#!/usr/bin/env bash
#
# Installs Playwright's Chromium, with the system libraries it needs, for one
# workspace package on a CI runner. The browser's download from Playwright's
# CDN now and then stalls with no error and no end, which held a job until its
# timeout, so each try at the download is cut at two minutes and made again,
# three times at most. The system libraries come first and once, outside any
# timeout: apt runs as root, and a cut try would leave its lock behind.
#
# Usage: scripts/install-chromium.sh <package> [playwright install options]
set -euo pipefail

package="$1"
shift
pnpm --filter "${package}" exec playwright install-deps chromium
for try in 1 2 3; do
  if timeout --kill-after=10 120 pnpm --filter "${package}" exec playwright install "$@" chromium; then
    exit 0
  fi
  printf 'Chromium for %s was not downloaded within two minutes (try %s of 3)\n' "${package}" "${try}" >&2
done
exit 1
