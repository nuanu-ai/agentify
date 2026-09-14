#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

command -v rg >/dev/null 2>&1 || { echo "rg is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

node ops/scripts/validate-ops.mjs

if rg -n 'fonts\.googleapis\.com|fonts\.gstatic\.com' apps/web; then
  echo "External Google font loading is forbidden." >&2
  exit 1
fi

if rg -n 'Hero Explorations|>Log in<' apps/web; then
  echo "Historical/dead prototype UI found in runtime code." >&2
  exit 1
fi

if rg -n "stripe\\.(paymentIntents|subscriptions|charges)|PaymentIntent|usage[\"']?\\s*[:=]\\s*[\"']off_session" \
  apps packages -g '*.{ts,tsx,js,mjs}' -g '!**/*.test.*'; then
  echo "Forbidden charge/subscription/off-session implementation reference found." >&2
  exit 1
fi

if rg -n '(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|sk_live_[A-Za-z0-9]{12,}|whsec_[A-Za-z0-9]{12,})' \
  . --hidden -g '!node_modules/**' -g '!.git/**' -g '!06-design/reference/**'; then
  echo "Possible committed secret found." >&2
  exit 1
fi

for script in ops/scripts/*.sh; do bash -n "$script"; done
for script in ops/deploy/droplet/*.sh ops/deploy/droplet/postgres-init/*.sh; do
  bash -n "$script"
done
for script in ops/scripts/*.mjs; do node --check "$script"; done
node --test ops/scripts/*.test.mjs

git diff --check
echo "Static release checks passed."
