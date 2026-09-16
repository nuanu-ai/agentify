#!/usr/bin/env bash
#
# Arranges this stand so that a person can walk the WooCommerce Connect flow by
# hand in a browser. `./setup.sh` builds the shop the probes measure; this adds
# the three things a person walking the flow needs and the probes do not, and
# then prints what to run next.
#
# What it changes, and why each one is the laptop rather than the product:
#
#   1. The shop is moved onto https. WooCommerce picks its REST authentication
#      scheme from the shop's own is_ssl(): over https the granted key and
#      secret go in as HTTP Basic, over plain http they are refused and a signed
#      OAuth 1.0a request is required instead. The cabinet speaks Basic and
#      refuses an http shop at the door, for a reason that is not about the
#      laptop — over http a merchant's own secret would be on the wire on every
#      order — so the stand has to be the thing a real shop is.
#
#   2. A TLS terminator goes up in front of the cabinet, on 443. WooCommerce
#      refuses a callback_url that is not https, and WordPress only lets an
#      outgoing request reach ports 80, 443 and 8080. A deployed cabinet is
#      behind real TLS on 443 and meets neither; one running on a laptop meets
#      both.
#
#   3. The mu-plugin's two local allowances are switched on, by writing the flag
#      file they are gated behind: the shop is allowed to reach a private
#      address, and its outgoing TLS is pinned to this stand's certificates
#      rather than switched off. Both are recorded in the README as artefacts of
#      the laboratory.
#
# Usage: ./demo.sh
set -euo pipefail

cd "$(dirname "$0")"
HERE="$(pwd)"

SHOP_HTTP="http://localhost:8088"
SHOP_HTTPS="https://localhost:8443"
ADMIN_USER="admin"
ADMIN_PASS="agentify-dev-admin"   # local stand only; see README

say() { printf '\n=== %s\n' "$*"; }
wp() { docker compose run --rm -T cli wp "$@"; }

say "bringing the shop up (setup.sh is safe to re-run)"
./setup.sh >/dev/null

say "minting a certificate for the cabinet terminator"
if [[ ! -f "${HERE}/var/certs/cabinet-cert.pem" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "${HERE}/var/certs/cabinet-key.pem" \
    -out "${HERE}/var/certs/cabinet-cert.pem" \
    -days 7 -subj "/CN=cabinet" -addext "subjectAltName=DNS:cabinet,DNS:localhost,IP:127.0.0.1" \
    2>/dev/null
  chmod 644 "${HERE}/var/certs/cabinet-key.pem" "${HERE}/var/certs/cabinet-cert.pem"
  echo "  var/certs/cabinet-cert.pem"
else
  echo "  var/certs/cabinet-cert.pem is already there"
fi

say "switching the shop onto https"
# wc-auth builds its addresses from home_url(), so this is what decides whether
# the grant screen a merchant is sent to is an https one — and whether the keys
# it hands out are accepted as Basic authentication afterwards.
wp option update home "${SHOP_HTTPS}" >/dev/null
wp option update siteurl "${SHOP_HTTPS}" >/dev/null
wp rewrite flush --hard >/dev/null
echo "  home and siteurl are now ${SHOP_HTTPS}"

say "switching on the stand's two local allowances"
mkdir -p "${HERE}/var/probe"
printf 'see mu-plugins/agentify-probe.php\n' > "${HERE}/var/probe/allow-private-callback"
echo "  var/probe/allow-private-callback"

say "starting the TLS terminator in front of the cabinet"
# --force-recreate, because nginx reads the certificate once at start: after a
# --reset has minted a fresh one, a surviving terminator would keep serving the
# old certificate from memory and the shop's pinned verification would refuse
# it — with the same words a real mismatch gets.
docker compose --profile demo up -d --force-recreate cabinet >/dev/null
echo "  listening on https://cabinet inside this network and on 127.0.0.1:443"

REPO="$(cd "${HERE}/../.." && pwd)"

cat <<EOF

The stand is ready. Three things are left, and DEMO.md walks them in order.

  1. One line in /etc/hosts, so that your browser reaches the terminator by the
     same name the shop reaches it by:

         127.0.0.1 cabinet

  2. The shop, for your browser:

         ${SHOP_HTTPS}/wp-admin   (${ADMIN_USER} / ${ADMIN_PASS})

     The certificate is self-signed, so the browser asks once.

  3. The cabinet, on this laptop rather than in the stack, with the stand's
     certificate trusted so that it can read the shop:

         cd ${REPO}
         docker compose up -d --build
         docker compose stop cabinet
         NODE_EXTRA_CA_CERTS=${HERE}/var/certs/shop-cert.pem \\
         DATABASE_URL=postgres://agentify_commerce:agentify_commerce@localhost:5432/agentify_commerce \\
         GATEWAY_URL=http://localhost:8080 \\
         PUBLIC_BASE_URL=https://cabinet \\
         COOKIE_SECURE=true \\
         AUTH_SECRET=a-sandbox-secret-nobody-should-reuse-anywhere \\
         PAYMENT_NETWORK=eip155:84532 FACILITATOR_URL=sandbox:scripted \\
         PORT=3001 pnpm --filter @agentify/commerce-cabinet start

     Then open https://cabinet/register.

To take the stand back to what the probes measure: ./setup.sh --reset.
EOF
