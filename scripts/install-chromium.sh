#!/usr/bin/env bash
#
# Installs Playwright's Chromium, with the system libraries it needs, for one
# workspace package on a CI runner. The download from Playwright's CDN now and
# then stalls with no error and no end, which held a job until its timeout, so
# each try is cut at two minutes and made again, three times at most.
#
# Usage: scripts/install-chromium.sh <package> [playwright install options]
set -euo pipefail

package="$1"
shift
for try in 1 2 3; do
  if timeout --kill-after=10 120 pnpm --filter "${package}" exec playwright install --with-deps "$@" chromium; then
    exit 0
  fi
  printf 'Chromium for %s was not installed within two minutes (try %s of 3)\n' "${package}" "${try}" >&2
done
exit 1
