#!/usr/bin/env bash
# Makes the certificates the controlled Woo fault's stack and a local copy of
# the lab trust: a certificate authority of the run's own, and the edge's
# certificate for shop.woo-fault.test and agentify.woo-fault.test signed by it.
# The authority's key is deleted once that one certificate is signed, so the
# authority the stack is told to trust can vouch for nothing else. Each run
# makes a new directory of its own; nothing is ever installed into the
# machine's or a browser's trust store.
set -euo pipefail

dir="${1:?Usage: certs.sh <a new directory for this run of certificates>}"
if [[ -e "$dir" ]]; then
  printf 'FAIL: %s exists; certs.sh makes a new directory and overwrites nothing\n' "$dir" >&2
  exit 1
fi
mkdir -p "$dir"
cd "$dir"

openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout ca-key.pem -out ca.pem \
  -subj "/CN=Controlled Woo fault, one run only" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout edge-key.pem -out edge.csr \
  -subj "/CN=shop.woo-fault.test" 2>/dev/null
printf '%s\n' \
  "subjectAltName=DNS:shop.woo-fault.test,DNS:agentify.woo-fault.test" \
  "extendedKeyUsage=serverAuth" \
  "keyUsage=critical,digitalSignature,keyEncipherment" \
  "basicConstraints=critical,CA:FALSE" >edge.ext
openssl x509 -req -in edge.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
  -days 30 -extfile edge.ext -out edge.pem 2>/dev/null
rm -f ca-key.pem ca.srl edge.csr edge.ext
# What the stack's application trusts beside Node's own authorities; another
# instrument laid over the same stack appends its authority here.
cp ca.pem trust.pem
# Read inside the containers by users other than the one who made them.
chmod 644 ca.pem trust.pem edge.pem edge-key.pem
openssl verify -CAfile ca.pem edge.pem
printf 'Certificates for one run are in %s\n' "$(pwd)"
