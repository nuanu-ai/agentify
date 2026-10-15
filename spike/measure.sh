#!/usr/bin/env bash
# Spike only. Builds the dashboard once per probe — b, c, r — with the settings
# page's button importing that probe alone, and prints M1, M2 and M3 of
# docs/research/48-merchant-wallet-onboarding.md for each.
set -uo pipefail
cd "$(dirname "$0")/.."
for probe in 0 b c r; do
  ext=ts; [ "$probe" = r ] && ext=tsx
  cp "apps/dashboard/app/wallet-probe-$probe.$ext" "apps/dashboard/app/wallet-probe.$ext"
  [ "$ext" = tsx ] && rm -f apps/dashboard/app/wallet-probe.ts || rm -f apps/dashboard/app/wallet-probe.tsx
  echo "===== probe $probe"
  if ! pnpm --filter @agentify/dashboard build >"${TMPDIR:-/tmp}/wallet-weight-build-$probe.log" 2>&1; then
    echo "M3: the build failed"; grep -iE "error" "${TMPDIR:-/tmp}/wallet-weight-build-$probe.log" | head -10; continue
  fi
  echo "M3: built with the configuration unchanged"
  pnpm --filter @agentify/dashboard budget 2>&1 | grep '^\[dashboard\]'
  (cd apps/dashboard && pnpm exec tsx ../../spike/click-weight.ts)
done
rm -f apps/dashboard/app/wallet-probe.tsx && cp apps/dashboard/app/wallet-probe-0.ts apps/dashboard/app/wallet-probe.ts
