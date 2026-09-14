#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${WEB_BASE_URL:=http://localhost:3000}"
[[ "$WEB_BASE_URL" == "http://localhost:"* || "$WEB_BASE_URL" == "http://127.0.0.1:"* ]] || {
  echo "Local core-flow smoke refuses a non-local WEB_BASE_URL" >&2
  exit 1
}
[[ "${STRIPE_ADAPTER:-}" == "local" && "${CARD_SIGNAL_ENABLED:-}" == "true" ]] || {
  echo "Local core-flow smoke requires STRIPE_ADAPTER=local and CARD_SIGNAL_ENABLED=true" >&2
  exit 1
}
[[ "${PUBLIC_SHARE_ENABLED:-}" == "true" ]] || {
  echo "Local core-flow smoke requires PUBLIC_SHARE_ENABLED=true" >&2
  exit 1
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
verification_file="$(mktemp /tmp/b2a-local-e2e.XXXXXX)"
trap 'rm -f "$verification_file"' EXIT

LOCAL_E2E_FIXTURE_ACK=yes \
LOCAL_E2E_VERIFICATION_FILE="$verification_file" \
corepack pnpm --filter @agentify/web e2e:seed

BROWSER_LOCAL_FLOW_FILE="$verification_file" \
BROWSER_EXPECT_LOCAL_CARD=true \
BROWSER_EXPECT_BROWSER_OBSERVATIONS=true \
WEB_BASE_URL="$WEB_BASE_URL" \
corepack pnpm ops:browser

echo "Local deterministic teaser/contact-gate/verified-session/share/card/deletion flow passed."
