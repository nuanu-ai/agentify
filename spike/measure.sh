#!/usr/bin/env bash
# Spike only. Builds the dashboard once per probe — 0, the control, then b, c
# and r — with exactly that probe's packages installed and the settings page's
# button importing that probe alone, and prints M1, M2 and M3 of
# docs/research/48-merchant-wallet-onboarding.md for each.
set -uo pipefail
cd "$(dirname "$0")/.."
all="@base-org/account @coinbase/cdp-core @coinbase/cdp-hooks @coinbase/cdp-react"
packages() {
  case "$1" in
    0) echo "" ;;
    b) echo "@base-org/account@2.5.13" ;;
    c) echo "@coinbase/cdp-core@0.0.127" ;;
    r) echo "@coinbase/cdp-core@0.0.127 @coinbase/cdp-hooks@0.0.127 @coinbase/cdp-react@0.0.127" ;;
  esac
}
for probe in 0 b c r; do
  # shellcheck disable=SC2086
  pnpm --filter @agentify/dashboard remove $all >/dev/null 2>&1
  # shellcheck disable=SC2086
  [ -n "$(packages $probe)" ] && pnpm --filter @agentify/dashboard add --save-exact $(packages $probe) >/dev/null 2>&1
  echo "installed for $probe: $(cd apps/dashboard && node -e 'const d=require("./package.json").dependencies; console.log(Object.keys(d).filter(k=>/base-org|cdp-/.test(k)).map(k=>k+"@"+d[k]).join(" ")||"none")')"
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
