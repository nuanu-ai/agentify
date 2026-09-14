#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

corepack pnpm ops:static
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test:unit
corepack pnpm test:integration
corepack pnpm db:check
corepack pnpm db:test:migrations
corepack pnpm build

if [[ "${FULL_RELEASE_GATE:-false}" == "true" ]]; then
  : "${WEB_BASE_URL:?WEB_BASE_URL required for full release gate}"
  corepack pnpm ops:runtime
  corepack pnpm ops:browser
else
  echo "Local release gate passed. FULL_RELEASE_GATE is not enabled; runtime, load, provider, backup, staging and production gates remain NO-GO."
fi
