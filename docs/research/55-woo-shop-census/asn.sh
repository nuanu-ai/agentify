#!/bin/sh
# For each host on stdin: its first IPv4 address and the autonomous system serving it, via Team Cymru's DNS.
while read -r host; do
  ip=$(dig +short A "$host" | grep -E '^[0-9.]+$' | head -n 1)
  if [ -z "$ip" ]; then echo "$host - -"; continue; fi
  rev=$(echo "$ip" | awk -F. '{print $4"."$3"."$2"."$1}')
  asn=$(dig +short TXT "$rev.origin.asn.cymru.com" | head -n 1 | tr -d '"' | cut -d'|' -f1 | tr -d ' ')
  name=$(dig +short TXT "AS$asn.asn.cymru.com" | head -n 1 | tr -d '"' | awk -F'|' '{print $5}')
  echo "$host $asn $name"
done
